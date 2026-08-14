import { discoverSubagentCatalog, catalogEntries } from "../catalog.ts";
import { resolveRunRef, listRunLocators } from "./run-ref.ts";
import { listSessionRuns } from "../watch.ts";
import { getRunStatus, getRunLogs, waitForRun } from "./status.ts";
import { readRunRecord, setRunDependency, appendRunEvent } from "../artifacts/index.ts";
import { interruptRun } from "./interrupt.ts";
import { reconcileSubagentRun } from "./reconcile.ts";
import { isSafeId } from "../core/identifiers.ts";
import { TOOL_NAME, textResult, addOutputPreview, type ToolResult } from "./tool-contract.ts";

export class InputValidationError extends Error {
	readonly failureKind = "validation" as const;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0)
		throw new InputValidationError(
			`${fieldName} must be a non-empty string when provided.`,
		);
	return value;
}

function optionalPositiveNumber(
	value: unknown,
	fieldName: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new InputValidationError(
			`${fieldName} must be a positive finite number when provided.`,
		);
	return value;
}

export async function lifecycleAction(
	raw: Record<string, unknown>,
	cwd: string,
	parentSessionId?: string,
): Promise<ToolResult | null> {
	const action = raw.action ?? "run";
	if (action === "run") return null;
	if (action === "runs") {
		const scope =
			optionalString(raw.scope, "scope") ??
			(raw.scope === undefined ? "session" : undefined);
		if (scope === undefined || !["session", "cwd", "all"].includes(scope)) {
			throw new InputValidationError(
				'scope must be one of "session", "cwd", or "all" when provided.',
			);
		}
		const limit = Math.min(
			50,
			Math.max(1, Math.floor(optionalPositiveNumber(raw.limit, "limit") ?? 10)),
		);
		let runs: Array<Record<string, unknown>>;
		if (scope === "all") {
			const { locators } = await listRunLocators();
			runs = locators
				.slice()
				.sort(
					(left, right) =>
						Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
				)
				.slice(0, limit)
				.map((locator) => ({
					runId: locator.runId,
					cwd: locator.cwd,
					...(locator.runsDir === undefined ? {} : { runsDir: locator.runsDir }),
					...(locator.parentSessionId === undefined
						? {}
						: { parentSessionId: locator.parentSessionId }),
					...(locator.correlationId === undefined
						? {}
						: { correlationId: locator.correlationId }),
					updatedAt: locator.updatedAt,
				}));
		} else {
			const scoped = await listSessionRuns(
				cwd,
				scope === "session" ? parentSessionId : undefined,
			);
			runs = scoped.slice(0, limit).map((run) => ({
				runId: run.runId,
				attemptId: run.attemptId,
				status: run.status,
				backend: run.backend,
				startedAt: new Date(run.startedAt).toISOString(),
				completedAt:
					run.completedAt === null || run.completedAt <= 0
						? null
						: new Date(run.completedAt).toISOString(),
				task: run.task,
				lastLine: run.lastLine,
			}));
		}
		return textResult(
			{
				tool: TOOL_NAME,
				action: "runs",
				scope,
				cwd,
				parentSessionId,
				count: runs.length,
				runs,
			},
			false,
			{ runs, scope, parentSessionId },
		);
	}
	if (action === "agents") {
		const catalogCwd = optionalString(raw.cwd, "cwd") ?? cwd;
		const { agents, projectAgentsDir } =
			await discoverSubagentCatalog(catalogCwd);
		const entries = catalogEntries(agents);
		return textResult(
			{
				tool: TOOL_NAME,
				action: "agents",
				projectAgentsDir,
				cwd: catalogCwd,
				agents: entries,
			},
			false,
			{ agents: entries, projectAgentsDir, cwd: catalogCwd },
		);
	}
	if (
		action !== "status" &&
		action !== "logs" &&
		action !== "wait" &&
		action !== "interrupt" &&
		action !== "mark-background" &&
		action !== "reconcile"
	) {
		throw new InputValidationError(
			'action must be one of "run", "agents", "runs", "status", "logs", "wait", "interrupt", "mark-background", or "reconcile" when provided.',
		);
	}

	const runId = optionalString(raw.runId, "runId");
	if (runId === undefined)
		throw new InputValidationError(
			`${String(action)} action requires a non-empty runId.`,
		);
	if (!isSafeId(runId))
		throw new InputValidationError(
			"runId must contain only letters, numbers, dots, underscores, or dashes.",
		);
	const attemptId =
		optionalString(raw.attemptId, "attemptId") ??
		optionalString(raw.taskId, "taskId");
	if (attemptId !== undefined && !isSafeId(attemptId))
		throw new InputValidationError(
			"attemptId must contain only letters, numbers, dots, underscores, or dashes.",
		);
	const ref = await resolveRunRef(
		{
			cwd: optionalString(raw.cwd, "cwd"),
			runId,
			attemptId,
			runsDir: optionalString(raw.runsDir, "runsDir"),
		},
		cwd,
	);

	if (action === "status") {
		const snapshot = await addOutputPreview(await getRunStatus(ref));
		const notFound = snapshot === null;
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: notFound ? "not-found" : snapshot.status,
				...(notFound ? { error: `No run found with id: ${runId}` } : {}),
				snapshot,
			},
			notFound,
			{ snapshot },
		);
	}

	if (action === "logs") {
		const snapshot = await getRunLogs(ref);
		const notFound = snapshot === null;
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: notFound ? "not-found" : snapshot.status,
				...(notFound ? { error: `No run found with id: ${runId}` } : {}),
				snapshot,
			},
			notFound,
			{ snapshot },
		);
	}

	if (action === "mark-background") {
		const existing = await readRunRecord(ref);
		if (existing === null)
			return textResult(
				{
					tool: TOOL_NAME,
					action,
					status: "not-found",
					error: `No run found with id: ${runId}`,
					snapshot: null,
				},
				true,
				{ snapshot: null },
			);
		const record = await setRunDependency(ref, "background");
		await appendRunEvent(ref, {
			type: "run.mark_background",
			status: record.status,
			message: "run marked background",
		});
		const snapshot = await getRunStatus(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: snapshot?.status ?? record.status,
				snapshot,
			},
			false,
			{ snapshot, record },
		);
	}

	if (action === "interrupt") {
		const signal = optionalString(raw.signal, "signal") as
			| NodeJS.Signals
			| undefined;
		if (
			signal !== undefined &&
			signal !== "SIGINT" &&
			signal !== "SIGTERM" &&
			signal !== "SIGKILL"
		) {
			throw new InputValidationError(
				'signal must be one of "SIGINT", "SIGTERM", or "SIGKILL" when provided.',
			);
		}
		const interrupted = await interruptRun({
			cwd: ref.cwd,
			runId,
			runsDir: ref.runsDir,
			attemptId: ref.attemptId,
			reason: optionalString(raw.reason, "reason"),
			signal,
			escalateAfterMs: optionalPositiveNumber(
				raw.escalateAfterMs,
				"escalateAfterMs",
			),
			killAfterMs: optionalPositiveNumber(raw.killAfterMs, "killAfterMs"),
		});
		const snapshot = await getRunStatus(ref);
		const isError =
			interrupted.status === "not-found" ||
			interrupted.status === "unsupported";
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: interrupted.status,
				interrupted,
				snapshot,
			},
			isError,
			{ interrupted, snapshot },
		);
	}

	if (action === "reconcile") {
		const reconciled = await reconcileSubagentRun(ref);
		const snapshot = await getRunStatus(ref);
		return textResult(
			{
				tool: TOOL_NAME,
				action,
				status: reconciled.status,
				reconciled,
				snapshot,
			},
			reconciled.status === "not-found",
			{ reconciled, snapshot },
		);
	}

	const waited = await waitForRun({
		...ref,
		timeoutMs: optionalPositiveNumber(raw.timeoutMs, "timeoutMs"),
		pollIntervalMs: optionalPositiveNumber(
			raw.pollIntervalMs,
			"pollIntervalMs",
		),
	});
	const snapshot = await addOutputPreview(waited.snapshot);
	const isError =
		waited.status !== "completed" || waited.snapshot?.status !== "completed";
	return textResult(
		{
			tool: TOOL_NAME,
			action,
			status: waited.status,
			outcome: waited.outcome,
			snapshot,
		},
		isError,
		{ waited: { ...waited, snapshot } },
	);
}
