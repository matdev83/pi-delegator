import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readRunRecord } from "../artifacts/index.ts";
import { getProgress } from "../live-progress.ts";
import { interruptRun } from "./interrupt.ts";
import { listRunLocators, resolveRunRef } from "./run-ref.ts";
import { isSafeId } from "../core/identifiers.ts";
import { isRecord, TOOL_NAME } from "./tool-contract.ts";
import { currentSessionIdFromCtx, listSessionRuns } from "../watch.ts";

async function activeSessionRuns(
	ctx: ExtensionCommandContext,
): Promise<Array<{ runId: string; status: string }>> {
	const sessionId = currentSessionIdFromCtx(ctx);
	let runs = await listSessionRuns(ctx.cwd, sessionId);
	if (runs.length === 0 && sessionId !== undefined)
		runs = await listSessionRuns(ctx.cwd, undefined);
	return runs
		.filter((run) => run.status === "running" || run.status === "pending")
		.map((run) => ({ runId: run.runId, status: run.status }));
}

async function killSubagent(
	ctx: ExtensionCommandContext,
	runId: string,
): Promise<Awaited<ReturnType<typeof interruptRun>>> {
	return await interruptRun({
		cwd: ctx.cwd,
		runId,
		reason: "killed via /subagent kill",
	});
}

function notifyKillResult(
	ctx: ExtensionCommandContext,
	result: Awaited<ReturnType<typeof interruptRun>>,
): void {
	const prefix = `Subagent ${result.runId}`;
	if (result.status === "interrupt-requested") {
		ctx.ui.notify?.(`${prefix}: kill requested.`, "info");
		return;
	}
	if (result.status === "already-terminal") {
		ctx.ui.notify?.(`${prefix}: already finished.`, "info");
		return;
	}
	if (result.status === "not-found") {
		ctx.ui.notify?.(`${prefix}: run not found.`, "warning");
		return;
	}
	ctx.ui.notify?.(`${prefix}: kill is unsupported for this run.`, "warning");
}

async function handleKillCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const match = /^kill(?:\s+(\S+))?$/.exec(args);
	if (match === null) return false;
	const target = match[1];
	if (target !== undefined && target !== "all" && !isSafeId(target)) {
		ctx.ui.notify?.(
			"Invalid subagent run ID. Use only letters, numbers, dots, underscores, or dashes.",
			"warning",
		);
		return true;
	}
	const active = await activeSessionRuns(ctx);
	if (target === undefined && active.length === 0) {
		ctx.ui.notify?.("No active subagent runs to kill.", "info");
		return true;
	}
	if (target === undefined && active.length > 1) {
		ctx.ui.notify?.(
			"Multiple active subagents found. Use `/subagent kill <runId>` or `/subagent kill all`.",
			"warning",
		);
		return true;
	}
	const runIds = target === "all"
		? active.map((run) => run.runId)
		: [target ?? active[0]!.runId];
	if (runIds.length === 0) {
		ctx.ui.notify?.("No active subagent runs to kill.", "info");
		return true;
	}
	if (runIds.length === 1 && target !== "all") {
		const result = await killSubagent(ctx, runIds[0]!);
		notifyKillResult(ctx, result);
		return true;
	}
	const results = await Promise.all(
		runIds.map(async (runId) => {
			try {
				return await killSubagent(ctx, runId);
			} catch {
				return null;
			}
		}),
	);
	const requested = results.filter(
		(result) => result?.status === "interrupt-requested",
	).length;
	const alreadyFinished = results.filter(
		(result) => result?.status === "already-terminal",
	).length;
	const unsupported = results.filter(
		(result) => result?.status === "unsupported",
	).length;
	const notFoundOrFailed = results.length - requested - alreadyFinished - unsupported;
	const details = [`${requested} kill requested`];
	if (alreadyFinished > 0) details.push(`${alreadyFinished} already finished`);
	if (unsupported > 0) details.push(`${unsupported} unsupported`);
	if (notFoundOrFailed > 0) details.push(`${notFoundOrFailed} failed or not found`);
	ctx.ui.notify?.(
		`Kill all: ${details.join(", ")}.`,
		notFoundOrFailed > 0 ? "warning" : "info",
	);
	return true;
}


export {
	activeSessionRuns,
	killSubagent,
	notifyKillResult,
	handleKillCommand,
};
