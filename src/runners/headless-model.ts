import { once } from "node:events";
import {
	buildPiArgv,
	effectiveSpawnCommand,
	resolvePiInvocation,
	buildPrompt,
	toolResultBudgetExtensionPath,
} from "./argv-builder.ts";
import {
	detectContextLengthExceeded,
	resolveContextLengthState,
	PiJsonStreamParser,
	sanitizeLiveEventString,
	livePayloadChars,
	toBuffer,
	emptyParseResult,
	MAX_PARSE_ERRORS,
	type PiJsonParseResult,
	type PiUsageAccumulationSlot,
	type PiUsageAccumulation,
	type ContextLengthResolution,
} from "./stream-parser.ts";

export {
	detectContextLengthExceeded,
	resolveContextLengthState,
} from "./stream-parser.ts";
export { buildPiArgv, toolResultBudgetExtensionPath } from "./argv-builder.ts";

const STDERR_TEXT_LIMIT = 256 * 1024;
const LIVE_EVENT_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_EVENT_MAX_LINE_BYTES = 64 * 1024;
const LIVE_EVENT_MAX_STRING_CHARS = 4 * 1024;
import { execFileSync, spawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	realpathSync,
} from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentSystemPrompt, type AgentDefinition } from "../agents.ts";
import {
	createAttemptArtifactStore,
	type ArtifactRef,
	type ProcessMetadata,
	type ResultEnvelope,
	type ResultMetadata,
	type ToolResultBudgetMetadata,
} from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import type {
	AgentScope,
	FailureKind,
	SandboxInput,
	Status,
	ThinkingLevel,
	ToolResultBudgetInput,
} from "../core/constants.ts";
import { sandboxAllowedDomains } from "../core/constants.ts";
import { publishLiveTranscriptEvent } from "../live-transcript.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";
import {
	flushToolCallTelemetry,
	ToolCallTelemetryCollector,
} from "./tool-call-telemetry.ts";
import {
	createInactivityWatchdog,
	normalizeInactivityTimeoutMs,
	type InactivityWatchdog,
} from "./inactivity.ts";
import {
	CONTEXT_RECOVERY_EVICT_FRACTION,
	normalizeToolResultBudget,
	TOOL_RESULT_BUDGET_ENV,
	TOOL_RESULT_BUDGET_STATE_FILENAME,
	type NormalizedToolResultBudget,
	type ToolResultBudgetState,
} from "./tool-result-budget.ts";

export interface RunHeadlessModelOptions {
	agent: string;
	task: string;
	roleContext?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	artifactCwd?: string;
	runId?: string;
	attemptId?: string;
	runsDir?: string;
	correlationId?: string;
	parentSessionId?: string;
	sessionId?: string;
	timeoutMs?: number;
	/** Internal milliseconds value; the public tool option is in seconds. */
	inactivityTimeoutMs?: number;
	signal?: AbortSignal;
	piCommand?: string;
	sandbox?: SandboxInput | false | null;
	workspace?: Partial<ResultWorkspace>;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	agentDefinition?: AgentDefinition;
	captureToolCalls?: boolean;
	/**
	 * Opt-in transcript hygiene: cumulative character budget for retained
	 * child tool results, enforced by a child extension before every model
	 * call. Default off; invalid values are ignored with a recorded warning.
	 */
	toolResultBudget?: ToolResultBudgetInput;
	onProcessStart?: (process: ProcessMetadata) => void | Promise<void>;
}

export interface ProcessOutcome {
	status: Status;
	failureKind: FailureKind | null;
	exitCode: number | null;
	signal: string | null;
}

interface ProcessResult {
	outcome: ProcessOutcome;
	stderrRef: ArtifactRef;
	toolCallArtifactRefs: ArtifactRef[];
	parsed: PiJsonParseResult;
	stderrText: string;
	stderrContextLengthExceeded: boolean;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			"timeoutMs must be a positive finite number when provided.",
		);
	}
	return timeoutMs;
}

type SessionManagerModule = {
	SessionManager?: {
		list?: (cwd: string) => Promise<Array<{ id: string }>>;
	};
};

export async function resultSessionMetadata(
	cwd: string,
	sessionId: string | undefined,
): Promise<Partial<ResultMetadata>> {
	if (sessionId === undefined) {
		return { session: { requested: false, disposition: "ephemeral" } };
	}

	try {
		const sessionCwd = await realpath(cwd).catch(() => cwd);
		const mod = (await import(
			"@earendil-works/pi-coding-agent"
		)) as SessionManagerModule;
		if (typeof mod.SessionManager?.list !== "function") {
			return {
				sessionId,
				session: {
					id: sessionId,
					requested: true,
					disposition: "unavailable",
					reason: "resume_unsupported",
				},
			};
		}
		const sessions = await mod.SessionManager.list(sessionCwd);
		return {
			sessionId,
			session: {
				id: sessionId,
				requested: true,
				disposition: sessions.some((session) => session.id === sessionId)
					? "resumed"
					: "created",
			},
		};
	} catch {
		return {
			sessionId,
			session: {
				id: sessionId,
				requested: true,
				disposition: "unavailable",
				reason: "session_store_error",
			},
		};
	}
}

function persistedLiveEvent(event: unknown): Record<string, unknown> | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	if (typeof record.type !== "string") return undefined;

	if (record.type === "message_update") {
		const update = record.assistantMessageEvent;
		if (typeof update !== "object" || update === null) return undefined;
		const updateRecord = update as Record<string, unknown>;
		if (
			(updateRecord.type !== "text_delta" &&
				updateRecord.type !== "thinking_delta") ||
			typeof updateRecord.delta !== "string" ||
			updateRecord.delta.length > LIVE_EVENT_MAX_STRING_CHARS
		)
			return undefined;
		return {
			type: record.type,
			assistantMessageEvent: {
				type: updateRecord.type,
				...(typeof updateRecord.contentIndex === "number"
					? { contentIndex: updateRecord.contentIndex }
					: {}),
				delta: sanitizeLiveEventString(updateRecord.delta),
			},
		};
	}

	if (record.type === "message_start" || record.type === "message_end") {
		const message = record.message;
		if (typeof message !== "object" || message === null) return undefined;
		const role = (message as Record<string, unknown>).role;
		if (role !== "assistant") return undefined;
		return {
			type: record.type,
			message: { role, content: [] },
		};
	}

	if (
		record.type === "tool_execution_start" ||
		record.type === "tool_execution_update" ||
		record.type === "tool_execution_end"
	) {
		const payload =
			record.type === "tool_execution_update"
				? record.partialResult
				: record.type === "tool_execution_end"
					? record.result
					: undefined;
		return {
			type: record.type,
			...(typeof record.toolCallId === "string"
				? { toolCallId: record.toolCallId }
				: {}),
			...(typeof record.toolName === "string"
				? { toolName: record.toolName }
				: {}),
			...(typeof record.isError === "boolean"
				? { isError: record.isError }
				: {}),
			...(payload === undefined
				? {}
				: { progressChars: livePayloadChars(payload) }),
		};
	}

	if (
		record.type === "agent_end" ||
		record.type === "turn_end" ||
		record.type === "error"
	)
		return { type: record.type };
	return undefined;
}

export function createLiveEventAppender(eventPath: string): {
	append: (event: unknown) => void;
	close: () => Promise<void>;
} {
	const stream = createWriteStream(eventPath, { flags: "a" });
	let bytesWritten = 0;
	let enabled = true;
	let streamFailed = false;
	let closePromise: Promise<void> | undefined;
	stream.on("error", () => {
		streamFailed = true;
		enabled = false;
	});

	function append(event: unknown): void {
		if (!enabled) return;
		const persisted = persistedLiveEvent(event);
		if (persisted === undefined) return;
		let line: string;
		try {
			line = `${JSON.stringify(persisted)}\n`;
		} catch {
			return;
		}
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (
			lineBytes > LIVE_EVENT_MAX_LINE_BYTES ||
			bytesWritten + lineBytes > LIVE_EVENT_MAX_BYTES
		)
			return;
		try {
			stream.write(line, "utf8");
			bytesWritten += lineBytes;
		} catch {
			// Live observability must never change the child run outcome.
			enabled = false;
		}
	}

	function close(): Promise<void> {
		if (closePromise !== undefined) return closePromise;
		if (streamFailed || stream.destroyed) return Promise.resolve();
		closePromise = new Promise((resolve) => {
			const done = (): void => resolve();
			stream.once("finish", done);
			stream.once("error", done);
			stream.end();
		});
		return closePromise;
	}

	return { append, close };
}

export function parsePiJsonLines(stdout: string): PiJsonParseResult {
	const parser = new PiJsonStreamParser();
	parser.push(stdout);
	return parser.finish();
}

export async function parsePiJsonFile(
	path: string,
): Promise<PiJsonParseResult> {
	const parser = new PiJsonStreamParser();
	const stream = createReadStream(path, { encoding: "utf8" });
	for await (const chunk of stream) parser.push(chunk);
	return parser.finish();
}

export function resolvePiJsonOutcome(
	processOutcome: ProcessOutcome,
	parsed: PiJsonParseResult,
	contextLengthExceeded: boolean,
): ProcessOutcome {
	if (processOutcome.status !== "completed") return processOutcome;
	if (parsed.parseErrors.length > 0 && parsed.finalAssistantText.length === 0) {
		return { ...processOutcome, status: "failed", failureKind: "parse" };
	}
	if (
		parsed.errors.length > 0 &&
		parsedErrorsAreFatal(parsed, contextLengthExceeded)
	) {
		return { ...processOutcome, status: "failed", failureKind: "model" };
	}
	return processOutcome;
}

export function resultMetadataFromParse(
	parsed: PiJsonParseResult,
	contextLength: ContextLengthResolution,
	outcome: ProcessOutcome,
): Partial<ResultMetadata> {
	return {
		...parsed.metadata,
		contextLengthExceeded: contextLength.contextLengthExceeded,
		...(contextLength.contextOverflowRecovered
			? { contextOverflowRecovered: true }
			: {}),
		...(parsed.errors.length === 0
			? {}
			: { streamErrors: parsed.errors.slice(0, MAX_PARSE_ERRORS) }),
		...(outcome.status === "completed" && parsed.errors.length > 0
			? { nonFatalStreamErrors: parsed.errors.slice(0, MAX_PARSE_ERRORS) }
			: {}),
		...(contextLength.recoveredStreamErrors.length === 0
			? {}
			: {
					recoveredStreamErrors: contextLength.recoveredStreamErrors.slice(
						0,
						MAX_PARSE_ERRORS,
					),
				}),
		...(parsed.parseErrors.length === 0
			? {}
			: { parseErrors: parsed.parseErrors.slice(0, MAX_PARSE_ERRORS) }),
	};
}

function parsedErrorsAreFatal(
	parsed: PiJsonParseResult,
	contextLengthExceeded: boolean,
): boolean {
	return (
		parsed.finalAssistantText.length === 0 ||
		parsed.metadata.stopReason === "error" ||
		contextLengthExceeded
	);
}



async function readToolResultBudgetState(
	statePath: string | undefined,
): Promise<ToolResultBudgetState | undefined> {
	if (statePath === undefined) return undefined;
	try {
		const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const state = parsed as ToolResultBudgetState;
		return typeof state.evictableCount === "number" &&
			typeof state.evictedCount === "number"
			? state
			: undefined;
	} catch {
		return undefined;
	}
}

function toolResultBudgetMetadata(
	budget: NormalizedToolResultBudget,
	state: ToolResultBudgetState | undefined,
): ToolResultBudgetMetadata | undefined {
	if (budget.warning !== undefined)
		return { enabled: false, warning: budget.warning };
	if (budget.budget === undefined) return undefined;
	return {
		enabled: true,
		maxTotalChars: budget.budget.maxTotalChars,
		...(state === undefined
			? {}
			: {
					toolResults: state.toolResults,
					retainedChars: state.retainedChars,
					evictedCount: state.evictedCount,
					evictedChars: state.evictedChars,
					evictableCount: state.evictableCount,
					forcedEvictionApplied: state.forcedEvictionApplied,
				}),
	};
}

async function fileBytes(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function appendLimited(base: string, chunk: string, limit: number): string {
	if (base.length >= limit) return base;
	return base + chunk.slice(0, limit - base.length);
}

async function runProcess(
	argv: readonly [string, ...string[]],
	cwd: string,
	timeoutMs: number | undefined,
	inactivityTimeoutMs: number,
	store: Awaited<ReturnType<typeof createAttemptArtifactStore>>,
	captureToolCalls?: boolean,
	abortSignal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
	onProcessStart?: (process: ProcessMetadata) => void | Promise<void>,
): Promise<ProcessResult> {
	const stderrPath = store.pathFor("stderr");
	const eventPath = join(store.attemptDir, "pi-events.jsonl");
	await writeFile(stderrPath, "");
	await writeFile(eventPath, "");

	const toolCallTelemetry =
		captureToolCalls === true ? new ToolCallTelemetryCollector() : undefined;
	const liveEvents = createLiveEventAppender(eventPath);
	const parser = new PiJsonStreamParser((event) => {
		toolCallTelemetry?.processEvent(event);
		publishLiveTranscriptEvent(store.runId, store.attemptId, event);
		liveEvents.append(event);
	});
	const stderrStream = createWriteStream(stderrPath, { flags: "w" });
	let stderrText = "";
	let stderrContextLengthExceeded = false;

	async function finishWith(outcome: ProcessOutcome): Promise<ProcessResult> {
		stderrStream.end();
		await once(stderrStream, "finish");
		const parsed = parser.finish();
		await liveEvents.close();
		return {
			outcome,
			stderrRef: store.refFor("stderr", await fileBytes(stderrPath)),
			toolCallArtifactRefs: await flushToolCallTelemetry(
				toolCallTelemetry,
				store,
			),
			parsed,
			stderrText,
			stderrContextLengthExceeded,
		};
	}

	if (abortSignal?.aborted) {
		return await finishWith({
			status: "cancelled",
			failureKind: "abort",
			exitCode: null,
			signal: null,
		});
	}

	return await new Promise<ProcessResult>((resolveProcess) => {
		const { command, args } = effectiveSpawnCommand(argv);
		const child = spawn(command, args, {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			windowsHide: process.platform === "win32",
			stdio: ["ignore", "pipe", "pipe"],
			...(env === undefined ? {} : { env }),
		});

		if (child.pid !== undefined) {
			void Promise.resolve(
				onProcessStart?.({
					pid: child.pid,
					processGroupId: process.platform === "win32" ? undefined : child.pid,
					command: argv[0],
				}),
			).catch(() => undefined);
		}

		let settled = false;
		let stopKind: "timeout" | "abort" | null = null;
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
		let inactivityWatchdog: InactivityWatchdog | undefined;

		function clearTimers(): void {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			timeoutTimer = null;
			forceKillTimer = null;
			inactivityWatchdog?.dispose();
			inactivityWatchdog = undefined;
		}

		function cleanup(): void {
			clearTimers();
			abortSignal?.removeEventListener("abort", onAbort);
		}

		function signalChild(signal: NodeJS.Signals): void {
			try {
				if (child.pid !== undefined && process.platform !== "win32")
					process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					/* already exited */
				}
			}
		}

		function requestStop(kind: "timeout" | "abort"): void {
			if (settled) return;
			stopKind ??= kind;
			signalChild("SIGTERM");
			forceKillTimer ??= setTimeout(() => {
				signalChild("SIGKILL");
				const forcedKind = stopKind ?? kind;
				settle({
					status: forcedKind === "abort" ? "cancelled" : "failed",
					failureKind: forcedKind,
					exitCode: null,
					signal: "SIGKILL",
				});
			}, 1_000);
		}

		function onAbort(): void {
			requestStop("abort");
		}

		function settle(outcome: ProcessOutcome): void {
			if (settled) return;
			settled = true;
			cleanup();
			// A killed Windows child can leave inherited stdio handles open. Close
			// our copies so timeout/abort returns do not wait forever for `close`.
			child.stdout?.destroy();
			child.stderr?.destroy();
			void finishWith(outcome).then(resolveProcess, () =>
				resolveProcess({
					outcome: {
						status: "failed",
						failureKind: "internal",
						exitCode: null,
						signal: null,
					},
					stderrRef: store.refFor("stderr", 0),
					toolCallArtifactRefs: [],
					parsed: parser.finish(),
					stderrText,
					stderrContextLengthExceeded,
				}),
			);
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			inactivityWatchdog?.touch();
			parser.push(toBuffer(chunk));
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			inactivityWatchdog?.touch();
			const buffer = toBuffer(chunk);
			const text = buffer.toString("utf8");
			stderrText = appendLimited(stderrText, text, STDERR_TEXT_LIMIT);
			stderrContextLengthExceeded ||= detectContextLengthExceeded({
				stderrText: text,
			});
			if (!stderrStream.write(buffer)) {
				child.stderr?.pause();
				stderrStream.once("drain", () => child.stderr?.resume());
			}
		});

		child.on("error", () => {
			settle({
				status: "failed",
				failureKind: "spawn",
				exitCode: null,
				signal: null,
			});
		});

		child.on("close", (exitCode, signal) => {
			if (stopKind === null && signal !== null) {
				settle({
					status: "cancelled",
					failureKind: "cancelled",
					exitCode,
					signal,
				});
				return;
			}
			const failureKind = stopKind ?? (exitCode === 0 ? null : "model");
			settle({
				status:
					failureKind === null
						? "completed"
						: failureKind === "abort"
							? "cancelled"
							: "failed",
				failureKind,
				exitCode,
				signal,
			});
		});

		if (timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				requestStop("timeout");
			}, timeoutMs);
		}
		inactivityWatchdog = createInactivityWatchdog(
			inactivityTimeoutMs,
			() => requestStop("timeout"),
		);

		abortSignal?.addEventListener("abort", onAbort, { once: true });
		if (abortSignal?.aborted) requestStop("abort");
	});
}

export async function runHeadlessModel(
	options: RunHeadlessModelOptions,
): Promise<ResultEnvelope> {
	if (typeof options.agent !== "string" || options.agent.length === 0) {
		throw new Error("agent must be a non-empty string.");
	}
	if (typeof options.task !== "string" || options.task.length === 0) {
		throw new Error("task must be a non-empty string.");
	}

	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const inactivityTimeoutMs = normalizeInactivityTimeoutMs(
		options.inactivityTimeoutMs,
	);
	const cwd = resolve(options.cwd ?? process.cwd());
	const artifactCwd = resolve(options.artifactCwd ?? cwd);
	const sessionMetadata = await resultSessionMetadata(cwd, options.sessionId);
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd: artifactCwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.runsDir,
	});
	const argv = buildPiArgv(options);
	const budget = normalizeToolResultBudget(options.toolResultBudget);
	const budgetStatePath =
		budget.budget === undefined
			? undefined
			: join(store.attemptDir, TOOL_RESULT_BUDGET_STATE_FILENAME);
	const budgetEnv =
		budget.budget === undefined || budgetStatePath === undefined
			? undefined
			: {
					[TOOL_RESULT_BUDGET_ENV.maxTotalChars]: String(
						budget.budget.maxTotalChars,
					),
					[TOOL_RESULT_BUDGET_ENV.statePath]: budgetStatePath,
				};

	async function executeAttempt(
		forceEvictFraction?: number,
	): Promise<ProcessResult> {
		const attemptEnv =
			budgetEnv === undefined
				? undefined
				: {
						...budgetEnv,
						...(forceEvictFraction === undefined
							? {}
							: {
									[TOOL_RESULT_BUDGET_ENV.forceEvictFraction]:
										String(forceEvictFraction),
								}),
					};
		try {
			return options.sandbox
				? await withSandboxedArgv(
						argv,
						{
							sandbox: options.sandbox,
							cwd,
							writablePaths: [store.taskDir],
							signal: options.signal,
						},
						(launch) =>
							runProcess(
								launch.argv,
								cwd,
								timeoutMs,
								inactivityTimeoutMs,
								store,
								options.captureToolCalls,
								options.signal,
								attemptEnv === undefined
									? launch.env
									: { ...(launch.env ?? process.env), ...attemptEnv },
								options.onProcessStart,
							),
					)
				: await runProcess(
						argv,
						cwd,
						timeoutMs,
						inactivityTimeoutMs,
						store,
						options.captureToolCalls,
						options.signal,
						attemptEnv === undefined
							? undefined
							: { ...process.env, ...attemptEnv },
						options.onProcessStart,
					);
		} catch (error) {
			if (!(error instanceof SandboxUnavailableError)) throw error;
			const stderrRef = await store.writeTextArtifact(
				"stderr",
				`${error.message}\n`,
			);
			return {
				outcome: {
					status: "failed",
					failureKind: "sandbox",
					exitCode: null,
					signal: null,
				},
				stderrRef,
				toolCallArtifactRefs: [],
				parsed: emptyParseResult(),
				stderrText: `${error.message}\n`,
				stderrContextLengthExceeded: detectContextLengthExceeded({
					stderrText: error.message,
				}),
			};
		}
	}

	function analyzeAttempt(attempt: ProcessResult): {
		contextLength: ContextLengthResolution;
		outcome: ProcessOutcome;
	} {
		const rawContextLengthExceeded =
			attempt.stderrContextLengthExceeded ||
			detectContextLengthExceeded({
				stderrText: attempt.stderrText,
				errors: attempt.parsed.errors,
			});
		const resolvedContextLength = resolveContextLengthState(
			attempt.parsed,
			rawContextLengthExceeded,
		);
		return {
			contextLength: resolvedContextLength,
			outcome: resolvePiJsonOutcome(
				attempt.outcome,
				attempt.parsed,
				resolvedContextLength.contextLengthExceeded,
			),
		};
	}

	let processResult = await executeAttempt();
	let { contextLength, outcome } = analyzeAttempt(processResult);
	let contextRecovered = false;
	if (
		budget.budget !== undefined &&
		outcome.status === "failed" &&
		contextLength.contextLengthExceeded
	) {
		const budgetState = await readToolResultBudgetState(budgetStatePath);
		if (budgetState !== undefined && budgetState.evictableCount >= 1) {
			// Single-recovery guard: exactly one evict-and-retry per run. The
			// retry instructs the child extension to evict the oldest ~25% of
			// retained tool-result chars before its first model call.
			processResult = await executeAttempt(CONTEXT_RECOVERY_EVICT_FRACTION);
			({ contextLength, outcome } = analyzeAttempt(processResult));
			contextRecovered = outcome.status === "completed";
		}
	}

	const { stderrRef, toolCallArtifactRefs, parsed } = processResult;
	const budgetMetadata = toolResultBudgetMetadata(
		budget,
		await readToolResultBudgetState(budgetStatePath),
	);

	const completedAt = new Date();
	const outputText = parsed.finalAssistantText;
	const artifacts: ArtifactRef[] = [
		stderrRef,
		await store.writeTextArtifact("output", outputText),
		...toolCallArtifactRefs,
	];

	return await store.writeResult({
		backend: "headless",
		status: outcome.status,
		failureKind: outcome.failureKind,
		cwd: artifactCwd,
		startedAt,
		completedAt,
		workspace: options.workspace ?? { mode: "shared", cwd },
		sandbox: options.sandbox
			? {
					enabled: true,
					allowedDomains: sandboxAllowedDomains(options.sandbox),
				}
			: { enabled: false },
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		artifacts,
		correlationId: options.correlationId,
		metadata: {
			...resultMetadataFromParse(parsed, contextLength, outcome),
			...sessionMetadata,
			...(options.parentSessionId === undefined
				? {}
				: { parentSessionId: options.parentSessionId }),
			...(contextRecovered ? { contextRecovered: true } : {}),
			...(budgetMetadata === undefined
				? {}
				: { toolResultBudget: budgetMetadata }),
		},
	});
}
