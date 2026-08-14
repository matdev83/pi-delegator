import { resolve } from "node:path";
import { Type, type TSchema } from "typebox";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	applyAgentRuntimeDefaults,
	loadAgentByName,
	type AgentDefinition,
} from "../agents.ts";
import {
	catalogEntries,
	discoverSubagentCatalog,
	formatAgentCatalogText,
} from "../catalog.ts";
import {
	appendRunEvent,
	createAttemptArtifactStore,
	readRunRecord,
	setRunDependency,
	type ArtifactRef,
	type ResultEnvelope,
	type ResultMetadata,
	type ToolResultBudgetMetadata,
} from "../artifacts/index.ts";
import {
	AGENT_SCOPES,
	ASYNC_DEPENDENCIES,
	BACKENDS,
	EXECUTION_MODES,
	ON_COMPLETE_ACTIONS,
	THINKING_LEVELS,
	WORKSPACE_MODES,
	WORKTREE_POLICIES,
	type ExecutionMode,
	type ResolveInput,
	type ResolveValidationFailure,
	type ResolvedBackend,
} from "../core/constants.ts";
import { resolveBackend } from "../core/resolver.ts";
import { isSafeId } from "../core/identifiers.ts";
import { clip, visibleLength } from "../core/text-width.ts";
import { validateResolveInput } from "../core/validation.ts";
import {
	startAsyncParallelSubagentRuns,
	startAsyncSubagentRun,
} from "./async.ts";
import { interruptRun } from "./interrupt.ts";
import { reconcileSubagentRun } from "./reconcile.ts";
import { resolveRunRef, listRunLocators } from "./run-ref.ts";
import {
	DEFAULT_PARALLEL_CONCURRENCY,
	runParallelSubagentTasks,
	runSubagentTask,
} from "./run.ts";
import { getRunLogs, getRunStatus, waitForRun } from "./status.ts";
import { showSubagentPanel } from "../panel.ts";
import {
	attachProgress,
	bindProgress,
	formatProgress,
	getProgress,
	resetProgress,
	settleProgress,
	type LiveProgress,
} from "../live-progress.ts";
import { resetLiveTranscripts } from "../live-transcript.ts";
import {
	currentSessionIdFromCtx,
	listSessionRuns,
	openSubagentWatch,
	registerSubagentWatchShortcuts,
} from "../watch.ts";
import { WorkspacePolicyError } from "../workspace/worktree.ts";
import {
	SingleLineComponent,
	HiddenComponent,
	ProgressLineComponent,
	subagentNumberSuffix,
	resetWidgetOrdinals,
	widgetOrdinalFor,
} from "../core/components.ts";
import { lifecycleAction, InputValidationError, type ToolResult } from "./lifecycle.ts";
import {
	OUTPUT_PREVIEW_MAX_BYTES,
	OUTPUT_PREVIEW_TOTAL_MAX_BYTES,
	readOutputPreview,
	type OutputPreview,
} from "../output-preview.ts";
import {
	textResult,
	resultSummary,
	artifactSummary,
	compactResult,
	compactResults,
	addOutputPreview,
	displayText,
	subagentCallSummary,
	validationFailure,
	executionMode,
	unsupportedPathError,
	writeUnsupportedResult,
	isRunAction,
	isLogsAction,
	ToolUpdateCallback,
	NotificationContext,
	ProjectAgentApprovalContext,
	AgentRequest,
	agentRequests,
} from "./result-compact.ts";
import {
	activeSessionRuns,
	killSubagent,
	notifyKillResult,
	handleKillCommand,
} from "./kill-orchestrator.ts";

export const TOOL_NAME = "subagent";
export const AGENT_TASK_KEYS = [
	"agent",
	"task",
	"roleContext",
	"agentScope",
	"confirmProjectAgents",
];
export const SUPPORTED_KEYS = new Set([
	"backend",
	"visible",
	"sandbox",
	"agent",
	"task",
	"roleContext",
	"agentScope",
	"confirmProjectAgents",
	"mode",
	"tasks",
	"concurrency",
	"failFast",
	"cancelSiblingsOnFailure",
	"asyncDependency",
	"workspace",
	"worktree",
	"worktreePolicy",
	"cwd",
	"async",
	"onComplete",
	"model",
	"tools",
	"systemPrompt",
	"skills",
	"extensions",
	"runsDir",
	"correlationId",
	"captureToolCalls",
	"thinking",
	"thinkingLevel",
	"reasoningLevel",
	"action",
	"runId",
	"attemptId",
	"taskId",
	"pollIntervalMs",
	"reason",
	"signal",
	"scope",
	"limit",
]);
const SANDBOX_SCHEMA = Type.Union(
	[
		Type.Boolean(),
		Type.Null(),
		Type.Object({
			allowedDomains: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						'Network domains the sandboxed child may reach, e.g. "api.anthropic.com" or "*.npmjs.org". Model-backed sandboxed runs must include their provider endpoint. Omitted means deny-all network.',
				}),
			),
		}),
	],
	{
		description:
			"true = offline OS sandbox; { allowedDomains: [...] } = sandbox with explicit network egress; false/null = no sandbox.",
	},
);
const SUBAGENT_TASK_SCHEMA = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1 })),
	task: Type.Optional(Type.String({ minLength: 1 })),
	roleContext: Type.Optional(Type.String({ minLength: 1 })),
	agentScope: Type.Optional(
		Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value))),
	),
	confirmProjectAgents: Type.Optional(Type.Boolean()),
	sandbox: Type.Optional(SANDBOX_SCHEMA),
	visible: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value))),
	),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
	skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	captureToolCalls: Type.Optional(
		Type.Boolean({
			description:
				"Capture redacted child tool-call telemetry as artifacts. Default false.",
		}),
	),
});

interface ToolTextContent {
	type: "text";
	text: string;
}

interface ToolResultEnvelopeContent {
	type: "result_envelope";
	resultEnvelope: ResultEnvelope;
}

interface ToolResultDetails {
	resolved?: ResolvedBackend;
	waited?: {
		backend: string;
		status: string;
		outcome: string;
		snapshot: string[];
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasAnyKey(
	input: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.some((key) => Object.hasOwn(input, key));
}

export function formatKeyList(keys: readonly string[]): string {
	return keys.map((key) => `"${key}"`).join(", ");
}

function getExecuteParams(first: unknown, second: unknown): unknown {
	return second === undefined ? first : second;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
	return isRecord(value) && typeof value.aborted === "boolean";
}

function normalizeExecuteArgs(args: unknown[]): {
	params: unknown;
	toolCallId?: string;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateCallback;
	ctx?: unknown;
} {
	const [first, second, third, fourth, fifth] = args;
	const params = getExecuteParams(first, second);

	// Pi has shipped both execute(toolCallId, params, signal, onUpdate, ctx)
	// and execute(toolCallId, params, onUpdate, ctx, signal) call orders. Support
	// both so context-scoped metadata (cwd/session) and cancellation survive either
	// host version.
	if (typeof third === "function") {
		return {
			params,
			...(typeof first === "string" ? { toolCallId: first } : {}),
			onUpdate: third as ToolUpdateCallback,
			ctx: fourth,
			...(isAbortSignalLike(fifth) ? { signal: fifth } : {}),
		};
	}

	if (isAbortSignalLike(fifth) && !isAbortSignalLike(third)) {
		return {
			params,
			...(typeof first === "string" ? { toolCallId: first } : {}),
			signal: fifth,
			...(typeof fourth === "function"
				? { onUpdate: fourth as ToolUpdateCallback }
				: { ctx: fourth }),
		};
	}

	return {
		params,
		...(typeof first === "string" ? { toolCallId: first } : {}),
		...(isAbortSignalLike(third) ? { signal: third } : {}),
		...(typeof fourth === "function"
			? { onUpdate: fourth as ToolUpdateCallback }
			: {}),
		ctx: fifth,
	};
}

function getCwd(ctx: unknown): string {
	if (isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd.length > 0)
		return ctx.cwd;
	return process.cwd();
}

function parentSessionIdFromCtx(ctx: unknown): string | undefined {
	if (!isRecord(ctx)) return undefined;
	const sessionManager = ctx.sessionManager;
	if (
		!isRecord(sessionManager) ||
		typeof sessionManager.getSessionId !== "function"
	)
		return undefined;
	try {
		const id = (sessionManager.getSessionId as () => unknown)();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

async function maybeConfirmProjectAgents(
	input: ResolveInput,
	cwd: string,
	ctx?: ProjectAgentApprovalContext,
): Promise<void> {
	const projectAgents: AgentDefinition[] = [];
	for (const request of agentRequests(input)) {
		if (
			request.confirmProjectAgents === false ||
			request.agentScope === "global"
		)
			continue;
		const requestCwd = resolve(cwd, request.cwd ?? ".");
		const agent = await loadAgentByName(
			request.agent,
			requestCwd,
			request.agentScope,
		);
		if (
			agent?.source === "project" &&
			!projectAgents.some(
				(candidate) => candidate.sourcePath === agent.sourcePath,
			)
		) {
			projectAgents.push(agent);
		}
	}
	if (projectAgents.length === 0) return;

	const names = projectAgents.map((agent) => agent.displayName).join(", ");
	const sources = projectAgents.map((agent) => agent.sourcePath).join("\n");
	if (ctx?.hasUI && ctx.ui?.confirm) {
		const approved = await ctx.ui.confirm(
			"Run project-local subagent definitions?",
			`Agents: ${names}\nSources:\n${sources}\n\nProject agents are repository-controlled. Continue only for trusted repositories.`,
		);
		if (!approved)
			throw new Error(
				"Canceled: project-local subagent definitions were not approved.",
			);
		return;
	}

	throw new Error(
		"Project-local subagent definitions require interactive approval or confirmProjectAgents:false.",
	);
}


async function completionPayload(result: ResultEnvelope, mode: ExecutionMode) {
	const outputPreview = await readOutputPreview(
		result.cwd,
		result.artifacts,
	);
	return {
		tool: TOOL_NAME,
		event: "complete",
		mode,
		runId: result.runId,
		attemptId: result.attemptId,
		backend: result.backend,
		status: result.status,
		failureKind: result.failureKind,
		...(outputPreview === undefined ? {} : outputPreview),
		artifacts: artifactSummary(result.artifacts),
	};
}

async function notifyCompletion(
	input: ResolveInput,
	result: ResultEnvelope,
	mode: ExecutionMode,
	onUpdate?: ToolUpdateCallback,
	ctx?: NotificationContext,
): Promise<number> {
	if (input.onComplete !== "notify") return 0;
	const payload = await completionPayload(result, mode);
	let updatesSent = 0;
	try {
		onUpdate?.({
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			details: payload,
		});
		if (onUpdate) updatesSent += 1;
	} catch {
		// Completion notifications must not change the task result.
	}
	try {
		ctx?.ui?.notify?.(
			`subagent ${result.runId}/${result.attemptId} ${result.status}`,
			result.status === "completed" ? "info" : "warning",
		);
		if (ctx?.ui?.notify) updatesSent += 1;
	} catch {
		// Completion notifications must not change the task result.
	}
	return updatesSent;
}

export function buildSubagentToolDefinition(
	description: string,
	promptGuidelines: string[],
): ToolDefinition {
	return {
		name: TOOL_NAME,
		label: "Subagent",
		description,
		promptGuidelines,
		parameters: Type.Object({
			backend: Type.Optional(
				Type.Union(BACKENDS.map((value) => Type.Literal(value))),
			),
			visible: Type.Optional(Type.Boolean()),
			sandbox: Type.Optional(SANDBOX_SCHEMA),
			agent: Type.Optional(Type.String({ minLength: 1 })),
			task: Type.Optional(Type.String({ minLength: 1 })),
			roleContext: Type.Optional(Type.String({ minLength: 1 })),
			agentScope: Type.Optional(
				Type.Union(AGENT_SCOPES.map((value) => Type.Literal(value))),
			),
			confirmProjectAgents: Type.Optional(Type.Boolean()),
			mode: Type.Optional(
				Type.Union(EXECUTION_MODES.map((value) => Type.Literal(value))),
			),
			tasks: Type.Optional(Type.Array(SUBAGENT_TASK_SCHEMA, { minItems: 1 })),
			concurrency: Type.Optional(
				Type.Number({
					minimum: 1,
					description: `Maximum parallel runs to launch at once. Default ${DEFAULT_PARALLEL_CONCURRENCY}.`,
				}),
			),
			failFast: Type.Optional(
				Type.Boolean({
					description:
						"For synchronous parallel runs, stop scheduling additional siblings after the first failed result.",
				}),
			),
			cancelSiblingsOnFailure: Type.Optional(
				Type.Boolean({
					description:
						"For synchronous parallel runs, abort already-running siblings after the first failed result. Implies fail-fast scheduling.",
				}),
			),
			asyncDependency: Type.Optional(
				Type.Union(
					ASYNC_DEPENDENCIES.map((value) => Type.Literal(value)),
					{
						description:
							"Whether an async run is needed before final, background, or unclassified.",
					},
				),
			),
			workspace: Type.Optional(
				Type.Union([
					Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value))),
					Type.Object({
						mode: Type.Optional(
							Type.Union(WORKSPACE_MODES.map((value) => Type.Literal(value))),
						),
						path: Type.Optional(Type.String({ minLength: 1 })),
					}),
				]),
			),
			worktree: Type.Optional(
				Type.Union([Type.Boolean(), Type.String({ minLength: 1 })]),
			),
			worktreePolicy: Type.Optional(
				Type.Union(WORKTREE_POLICIES.map((value) => Type.Literal(value))),
			),
			cwd: Type.Optional(Type.String({ minLength: 1 })),
			async: Type.Optional(Type.Boolean()),
			onComplete: Type.Optional(
				Type.Union(ON_COMPLETE_ACTIONS.map((value) => Type.Literal(value))),
			),
			model: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Optional Pi model pattern or provider/model id for model-backed subagents.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Optional tool allowlist. With a named agent this may only narrow the agent-declared tools. Use [] to disable tools.",
				}),
			),
			systemPrompt: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Optional compiled system prompt. When provided, it replaces the named agent prompt body but not agent frontmatter policy.",
				}),
			),
			skills: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Additional Pi skill paths to load. Omit to use ambient discovery; pass [] to disable child skills.",
				}),
			),
			extensions: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Additional Pi extension paths to load. Omit to use ambient discovery; pass [] to disable child extensions.",
				}),
			),
			runsDir: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Safe relative run/artifact root under cwd.",
				}),
			),
			correlationId: Type.Optional(
				Type.String({
					minLength: 1,
					description: "External correlation label; no aggregation semantics.",
				}),
			),
			captureToolCalls: Type.Optional(
				Type.Boolean({
					description:
						"Capture redacted child tool-call telemetry (tool names, durations, statuses; no args/results) as run artifacts. Default false.",
				}),
			),
			thinking: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Optional Pi thinking/reasoning level." },
				),
			),
			thinkingLevel: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Alias for thinking." },
				),
			),
			reasoningLevel: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((value) => Type.Literal(value)),
					{ description: "Alias for thinking." },
				),
			),
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("run"),
						Type.Literal("agents"),
						Type.Literal("runs"),
						Type.Literal("status"),
						Type.Literal("logs"),
						Type.Literal("wait"),
						Type.Literal("interrupt"),
						Type.Literal("mark-background"),
						Type.Literal("reconcile"),
					],
					{
						default: "run",
						description:
							'What to do. Default "run" starts a new subagent. agents lists discovered profiles. status/logs/wait/interrupt/mark-background/reconcile operate on an existing runId.',
					},
				),
			),
			runId: Type.Optional(Type.String({ minLength: 1 })),
			attemptId: Type.Optional(Type.String({ minLength: 1 })),
			taskId: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Deprecated alias for attemptId when reading old runs.",
				}),
			),
			pollIntervalMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			reason: Type.Optional(Type.String({ minLength: 1 })),
			signal: Type.Optional(
				Type.Union([
					Type.Literal("SIGINT"),
					Type.Literal("SIGTERM"),
					Type.Literal("SIGKILL"),
				]),
			),
			scope: Type.Optional(
				Type.Union(
					[
						Type.Literal("session"),
						Type.Literal("cwd"),
						Type.Literal("all"),
					],
					{
						description:
							'With action:"runs", restrict the listing to the current session (default), the current cwd, or all located runs. Ignored otherwise.',
					},
				),
			),
			limit: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 50,
					description:
						"With action:\"runs\", maximum number of runs to return (default 10, max 50). Ignored otherwise.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			if (isLogsAction(args)) return new HiddenComponent();
			const widgetOrdinal = isRunAction(args)
				? widgetOrdinalFor(context?.toolCallId)
				: undefined;
			const summary = subagentCallSummary(args);
			const rest = summary.startsWith("subagent ")
				? summary.slice("subagent ".length)
				: summary;
			const makeBase = (progress: LiveProgress | undefined) => {
				const hasPersistedNumber =
					progress?.sessionOrdinal !== undefined ||
					(progress?.sessionOrdinals?.length ?? 0) > 0;
				const numberSource = hasPersistedNumber
					? progress
					: widgetOrdinal === undefined
						? progress
						: ({ ...progress, sessionOrdinal: widgetOrdinal } as LiveProgress);
				const title = theme.fg(
					"toolTitle",
					theme.bold(`subagent${subagentNumberSuffix(numberSource)}`),
				);
				return `${title} ${theme.fg("muted", rest)}`;
			};
			if (
				isRunAction(args) &&
				context?.toolCallId &&
				typeof context.invalidate === "function"
			) {
				// Pi may reuse the render-context object while redrawing multiple tool
				// rows. Capture per-execution values now; retaining `context` would let
				// an older component follow a later call after the host mutates it.
				const toolCallId = context.toolCallId;
				const invalidate = context.invalidate;
				const requestedCwd =
					isRecord(args) &&
					typeof args.cwd === "string" &&
					args.cwd.length > 0
						? args.cwd
						: context.cwd;
				attachProgress(toolCallId, requestedCwd, () => invalidate());
				return new ProgressLineComponent(makeBase, toolCallId);
			}
			return new SingleLineComponent(makeBase(undefined));
		},
		renderResult(result, options, theme, context) {
			const payload = result.details ?? (() => {
				const text = result.content.find(
					(item): item is ToolTextContent => item.type === "text",
				)?.text;
				if (text === undefined) return undefined;
				try {
					return JSON.parse(text) as unknown;
				} catch {
					return text;
				}
			})();
			const summary = resultSummary(
				isRecord(payload) && "result" in payload ? payload.result : payload,
			);
			const settledStatus =
				isRecord(payload) && "result" in payload && isRecord(payload.result)
					? payload.result.status
					: isRecord(payload)
						? payload.status
					: undefined;
			if (!options.isPartial && context?.toolCallId) {
				const terminalStatus =
					settledStatus === "failed" ||
					settledStatus === "cancelled" ||
					settledStatus === "completed"
						? settledStatus
						: "completed";
				settleProgress(context.toolCallId, terminalStatus);
			}
			if (
				isLogsAction(context?.args) ||
				(isRecord(payload) && payload.action === "logs")
			)
				return new HiddenComponent();
			const color = options.isPartial
				? "warning"
				: settledStatus === "failed" ||
					settledStatus === "cancelled" ||
					settledStatus === "not-found"
					? "error"
					: "success";
			return new SingleLineComponent(theme.fg(color, summary));
		},
		async execute(...executeArgs: unknown[]) {
			const { params, toolCallId, signal, onUpdate, ctx } =
				normalizeExecuteArgs(executeArgs);
			const cwd = getCwd(ctx);

			try {
				const raw = isRecord(params) ? params : {};
				if (isRunAction(raw)) widgetOrdinalFor(toolCallId);
				const parentSessionId = parentSessionIdFromCtx(ctx);
				const lifecycle = await lifecycleAction(raw, cwd, parentSessionId);
				if (lifecycle !== null) return lifecycle;

				const validation = validateResolveInput(params);
				if (!validation.ok) return validationFailure(validation.failure);

				if (parentSessionId !== undefined)
					validation.input.parentSessionId = parentSessionId;
				const profileCwd = resolve(validation.input.cwd ?? cwd);
				const profiled = await applyAgentRuntimeDefaults(
					validation.input,
					profileCwd,
				);
				Object.assign(validation.input, profiled.input);

				const resolved = resolveBackend(validation.input);
				if (resolved.status === "failed") return validationFailure(resolved);

				const unsupportedError = unsupportedPathError(
					raw,
					validation.input,
					resolved.backend,
				);
				if (unsupportedError) {
					const result = await writeUnsupportedResult(
						cwd,
						resolved.backend,
						validation.input,
					);
					return textResult(await compactResult(result, unsupportedError), true, {
						result,
						resolved,
					});
				}

				const runCwd = validation.input.cwd ?? cwd;
				const onRunStarted =
					toolCallId === undefined
						? undefined
						: ({
									runId,
									attemptId,
									cwd: bindingCwd,
									startedAt,
								}: {
									runId: string;
									attemptId: string;
									cwd: string;
									startedAt: Date;
								}) =>
									bindProgress(
										toolCallId,
										bindingCwd,
									runId,
									attemptId,
									startedAt.getTime(),
								);
				await maybeConfirmProjectAgents(
					validation.input,
					runCwd,
					ctx as ProjectAgentApprovalContext,
				);
				const mode = executionMode(validation.input);
				const asyncRequested =
					validation.input.async === true ||
					validation.input.onComplete === "detach" ||
					validation.input.onComplete === "notify";
				if (mode === "parallel") {
					const parallel = asyncRequested
						? await startAsyncParallelSubagentRuns(
								validation.input,
								runCwd,
								signal,
								(completed, completedMode) =>
									notifyCompletion(
										validation.input,
										completed,
										completedMode,
										onUpdate,
										ctx as NotificationContext,
									),
								onRunStarted,
							)
						: await runParallelSubagentTasks(validation.input, runCwd, signal, {
								onRunStarted,
							});
					const runs = await compactResults(parallel.results);
					const failed =
						!asyncRequested &&
						(parallel.failFastTriggered ||
							parallel.results.some((result) => result.status !== "completed"));
					return textResult(
						{
							tool: TOOL_NAME,
							mode: "parallel",
							status: failed
								? "failed"
								: asyncRequested
									? "running"
									: "completed",
							runIds: parallel.runIds,
							concurrencyLimit: parallel.concurrency,
							totalTasks: parallel.totalTasks,
							startedCount: parallel.startedCount,
							skippedCount: parallel.skippedCount,
							failFastTriggered: parallel.failFastTriggered,
							runs,
						},
						failed,
						{ results: parallel.results, resolved },
					);
				}

				if (asyncRequested) {
					const result = await startAsyncSubagentRun({
						input: validation.input,
						cwd: runCwd,
						backend: resolved.backend,
						signal,
						onRunStarted,
						onComplete: (completed, completedMode) =>
							notifyCompletion(
								validation.input,
								completed,
								completedMode,
								onUpdate,
								ctx as NotificationContext,
							),
					});
					return textResult(await compactResult(result), false, { result, resolved });
				}

				const result = await runSubagentTask({
					input: validation.input,
					cwd: runCwd,
					signal,
					onRunStarted,
				});
				return textResult(
					await compactResult(result),
					result.status !== "completed",
					{ result, resolved },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const failureKind =
					error instanceof WorkspacePolicyError ||
					error instanceof InputValidationError
						? error.failureKind
						: typeof error === "object" &&
								error !== null &&
								(error as { failureKind?: unknown }).failureKind ===
									"validation"
							? "validation"
							: "internal";
				return textResult(
					{
						tool: TOOL_NAME,
						status: "failed",
						failureKind,
						error: message,
					},
					true,
				);
			}
		},
	};
}


export {
	textResult,
	resultSummary,
	artifactSummary,
	compactResult,
	compactResults,
	addOutputPreview,
	displayText,
	subagentCallSummary,
	validationFailure,
	executionMode,
	unsupportedPathError,
	writeUnsupportedResult,
	isRunAction,
	isLogsAction,
	ToolUpdateCallback,
	NotificationContext,
	ProjectAgentApprovalContext,
	AgentRequest,
	agentRequests,
} from "./result-compact.ts";
export {
	activeSessionRuns,
	killSubagent,
	notifyKillResult,
	handleKillCommand,
} from "./kill-orchestrator.ts";
