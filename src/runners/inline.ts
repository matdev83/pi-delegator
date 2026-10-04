import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAgentSystemPrompt, type AgentDefinition } from "../agents.ts";
import {
	createAttemptArtifactStore,
	type AttemptArtifactStore,
	type ArtifactRef,
	type ResultEnvelope,
} from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import {
	THINKING_LEVELS,
	DEFAULT_RECOVERY_GRACE_SECONDS,
	type AgentScope,
	type FailureKind,
	type ThinkingLevel,
} from "../core/constants.ts";
import { publishLiveTranscriptEvent } from "../live-transcript.ts";
import {
	createLiveEventAppender,
	detectContextLengthExceeded,
} from "./headless-model.ts";
import {
	flushToolCallTelemetry,
	ToolCallTelemetryCollector,
} from "./tool-call-telemetry.ts";
import {
	createInactivityWatchdog,
	createRecoverableWatchdog,
	normalizeInactivityTimeoutMs,
	normalizeRecoveryInactivityTimeoutMs,
	type InactivityWatchdog,
	type RecoverableWatchdog,
} from "./inactivity.ts";
import {
	matchesSessionFinishMarker,
	SESSION_FINISH_PROMPT,
} from "./session-finish-marker.ts";
import {
	importPiSdk,
	type AgentSessionLike,
	type ModelLike,
	type ModelRuntimeLike,
	type PiSdkModule,
	type ResourceLoaderLike,
} from "./pi-sdk.ts";

export interface RunInlineModelOptions {
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
	timeoutMs?: number;
	/** Internal milliseconds value; the public tool option is in seconds. */
	inactivityTimeoutMs?: number;
	/** Internal milliseconds value; the public tool option is in seconds. 0 disables. */
	recoveryInactivityTimeoutMs?: number;
	signal?: AbortSignal;
	workspace?: Partial<ResultWorkspace>;
	model?: string;
	/**
	 * `provider/id` inherited from the parent Pi session. Consulted only when
	 * neither `model` nor the agent profile names one, so an agentless run
	 * inherits a model the parent has already proven usable.
	 */
	hostModel?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
	skills?: string[];
	extensions?: string[];
	captureToolCalls?: boolean;
	agentDefinition?: AgentDefinition;
}

function normalizeTimeoutMs(
	timeoutMs: number | undefined,
): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			"timeoutMs must be a positive finite number when provided.",
		);
	}
	return timeoutMs;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				"text" in part
			) {
				const record = part as { type?: unknown; text?: unknown };
				if (record.type === "text" && typeof record.text === "string")
					return record.text;
			}
			return "";
		})
		.join("");
}

function assistantTextFromMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	let text = "";
	for (const message of messages) {
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).role === "assistant"
		) {
			const candidate = textFromContent(
				(message as Record<string, unknown>).content,
			);
			if (candidate.length > 0) text = candidate;
		}
	}
	return text;
}

function maybeAssistantTextFromAgentEnd(event: unknown): string {
	if (typeof event !== "object" || event === null) return "";
	const record = event as Record<string, unknown>;
	if (record.type !== "agent_end") return "";
	return assistantTextFromMessages(record.messages);
}

function maybeTextDelta(event: unknown): string {
	if (typeof event !== "object" || event === null) return "";
	const record = event as Record<string, unknown>;
	if (record.type !== "message_update") return "";
	const assistantMessageEvent = record.assistantMessageEvent;
	if (
		typeof assistantMessageEvent !== "object" ||
		assistantMessageEvent === null
	)
		return "";
	const update = assistantMessageEvent as Record<string, unknown>;
	return update.type === "text_delta" && typeof update.delta === "string"
		? update.delta
		: "";
}

interface LiveOutputWriter {
	append(text: string): void;
	close(): Promise<void>;
}

/**
 * Keep inline runs observable while the SDK session is still executing.
 * Deltas are batched so the SDK event callback never waits on filesystem I/O.
 */
function createLiveOutputWriter(store: AttemptArtifactStore): LiveOutputWriter {
	let pending = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writeChain = Promise.resolve();

	function flush(): Promise<void> {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		const chunk = pending;
		pending = "";
		if (chunk.length === 0) return writeChain;
		writeChain = writeChain
			.then(async () => {
				await store.appendTextArtifact("output", chunk);
			})
			.catch(() => undefined);
		return writeChain;
	}

	function schedule(): void {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, 100);
	}

	return {
		append(text) {
			if (text.length === 0) return;
			pending += text;
			if (pending.length >= 4_096) void flush();
			else schedule();
		},
		async close() {
			await flush();
			await writeChain;
		},
	};
}

function splitThinkingSuffix(modelReference: string): {
	model: string;
	thinking?: ThinkingLevel;
} {
	const index = modelReference.lastIndexOf(":");
	if (index <= 0) return { model: modelReference };
	const suffix = modelReference.slice(index + 1);
	if (!(THINKING_LEVELS as readonly string[]).includes(suffix))
		return { model: modelReference };
	return {
		model: modelReference.slice(0, index),
		thinking: suffix as ThinkingLevel,
	};
}

async function resolveRequestedModel(
	modelRuntime: ModelRuntimeLike,
	resolveModelScope: PiSdkModule["resolveModelScopeWithDiagnostics"],
	modelReference: string,
): Promise<{ model: ModelLike; thinkingLevel: ThinkingLevel | undefined }> {
	const result = await resolveModelScope([modelReference], modelRuntime);
	const scoped = result.scopedModels[0];
	if (scoped === undefined) {
		const diagnostic = result.diagnostics?.[0];
		const detail = diagnostic?.message ?? "";
		throw new Error(
			`model ${JSON.stringify(modelReference)} was not found or is not available. ${detail}`.trim(),
		);
	}
	return {
		model: scoped.model,
		thinkingLevel: scoped.thinkingLevel,
	};
}

function buildPrompt(options: RunInlineModelOptions): string {
	if (options.systemPrompt !== undefined) return options.task;
	const sections = [
		`You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
		"You are running as an inline child session. Do not spawn subagents or delegate to unmanaged child agents.",
		options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
		options.agentScope ? `Agent scope: ${options.agentScope}` : undefined,
		options.confirmProjectAgents === undefined
			? undefined
			: `confirmProjectAgents: ${String(options.confirmProjectAgents)}`,
		`Task:\n${options.task}`,
	];
	return sections
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
}

function createChildResourceLoader(
	piSdk: PiSdkModule,
	options: RunInlineModelOptions,
	cwd: string,
): ResourceLoaderLike {
	const baseSystemPrompt = [
		`You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
		"Child profile: inline SDK worker. Recursive subagent spawning is disabled. Use only the explicitly enabled local tools if needed.",
		options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
	]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
	const agentSystemPrompt =
		options.systemPrompt !== undefined
			? options.systemPrompt
			: options.agentDefinition === undefined
				? undefined
				: buildAgentSystemPrompt(options.agentDefinition);
	const systemPrompt =
		agentSystemPrompt === undefined
			? baseSystemPrompt
			: options.systemPrompt !== undefined ||
					options.agentDefinition?.systemPromptMode === "replace"
				? agentSystemPrompt
				: `${baseSystemPrompt}\n\n${agentSystemPrompt}`;

	return new piSdk.DefaultResourceLoader({
		cwd,
		agentDir: piSdk.getAgentDir(),
		additionalExtensionPaths: options.extensions?.length
			? options.extensions
			: undefined,
		additionalSkillPaths: options.skills?.length ? options.skills : undefined,
		noExtensions:
			options.extensions !== undefined && options.extensions.length === 0,
		noSkills: options.skills !== undefined && options.skills.length === 0,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
}

interface PromptRunResult {
	failureKind: FailureKind | null;
	finishedByMarker: boolean;
	recoveryProbeCount: number;
}

async function promptWithStops(
	session: AgentSessionLike,
	prompt: string,
	timeoutMs: number | undefined,
	inactivityTimeoutMs: number,
	recoveryInactivityTimeoutMs: number,
	signal: AbortSignal | undefined,
	setActivityHandler: (handler: () => void) => void,
	setAssistantTextHandler: (handler: (text: string) => void) => void,
	onRecoveryProbe: (probeCount: number) => void,
): Promise<PromptRunResult> {
	const recoveryEnabled = recoveryInactivityTimeoutMs > 0;
	const recoveryGraceMs = DEFAULT_RECOVERY_GRACE_SECONDS * 1000;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let recoveryGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let inactivityWatchdog: InactivityWatchdog | undefined;
	let recoveryWatchdog: RecoverableWatchdog | undefined;
	let abortListener: (() => void) | undefined;
	let settled = false;
	let recovering = false;
	let finishedByMarker = false;
	let recoveryProbeCount = 0;
	let turnGeneration = 0;
	let resolveStop: (result: PromptRunResult) => void = () => undefined;
	const stopPromise = new Promise<PromptRunResult>((resolve) => {
		resolveStop = resolve;
	});

	function clearRecoveryGrace(): void {
		if (recoveryGraceTimer !== undefined) {
			clearTimeout(recoveryGraceTimer);
			recoveryGraceTimer = undefined;
		}
	}

	function settle(kind: FailureKind | null): void {
		if (settled) return;
		settled = true;
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		clearRecoveryGrace();
		inactivityWatchdog?.dispose();
		recoveryWatchdog?.dispose();
		if (abortListener !== undefined)
			signal?.removeEventListener("abort", abortListener);
		if (kind !== null) void session.abort?.();
		resolveStop({ failureKind: kind, finishedByMarker, recoveryProbeCount });
	}

	function stop(kind: FailureKind): void {
		settle(kind);
	}

	function onMarkerDetected(text: string): void {
		if (settled || !recovering) return;
		if (!matchesSessionFinishMarker(text)) return;
		finishedByMarker = true;
		settle(null);
	}

	function beginTurn(promptText: string, onDone: () => void): void {
		const generation = ++turnGeneration;
		try {
			void Promise.resolve(session.prompt(promptText)).then(
				() => {
					if (turnGeneration === generation && !settled) onDone();
				},
				() => {
					if (turnGeneration === generation && !settled) stop("timeout");
				},
			);
		} catch {
			if (!settled) stop("timeout");
		}
	}

	function enterRecovery(): void {
		if (settled || recovering) return;
		recovering = true;
		recoveryProbeCount += 1;
		onRecoveryProbe(recoveryProbeCount);
		clearRecoveryGrace();
		recoveryGraceTimer = setTimeout(() => stop("timeout"), recoveryGraceMs);
		// The in-flight turn produced no activity; abort it so the session can
		// accept the finish probe as the next prompt.
		void session.abort?.().catch(() => undefined);
		beginTurn(SESSION_FINISH_PROMPT, () => {
			if (settled) return;
			if (finishedByMarker) {
				settle(null);
				return;
			}
			// The session replied without the finish marker: it resumed
			// operations. Keep the tool call open and wait for the next
			// silent window before probing again.
			recovering = false;
			clearRecoveryGrace();
			recoveryWatchdog?.rearm();
		});
	}

	beginTurn(prompt, () => {
		if (!settled) settle(null);
	});

	if (timeoutMs !== undefined)
		timeoutTimer = setTimeout(() => stop("timeout"), timeoutMs);
	inactivityWatchdog = createInactivityWatchdog(
		inactivityTimeoutMs,
		() => stop("timeout"),
	);
	if (recoveryEnabled) {
		recoveryWatchdog = createRecoverableWatchdog(
			recoveryInactivityTimeoutMs,
			enterRecovery,
		);
	}
	setActivityHandler(() => {
		if (settled) return;
		if (recovering) {
			// Any reaction counts as liveness: restart the silence deadline.
			clearRecoveryGrace();
			recoveryGraceTimer = setTimeout(
				() => stop("timeout"),
				recoveryGraceMs,
			);
			inactivityWatchdog?.touch();
			return;
		}
		inactivityWatchdog?.touch();
		recoveryWatchdog?.touch();
	});
	setAssistantTextHandler(onMarkerDetected);
	if (signal !== undefined) {
		abortListener = () => stop("abort");
		if (signal.aborted) abortListener();
		else signal.addEventListener("abort", abortListener, { once: true });
	}
	return await stopPromise;
}

export async function runInlineModel(
	options: RunInlineModelOptions,
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
	const recoveryInactivityTimeoutMs = normalizeRecoveryInactivityTimeoutMs(
		options.recoveryInactivityTimeoutMs,
	);
	const cwd = resolve(options.cwd ?? process.cwd());
	const artifactCwd = resolve(options.artifactCwd ?? cwd);
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd: artifactCwd,
		runId: options.runId,
		attemptId: options.attemptId,
		runsDir: options.runsDir,
	});
	const workerPayload = `${JSON.stringify(
		{
			input: { agent: options.agent, task: options.task },
			cwd,
			backend: "inline",
			runId: store.runId,
			attemptId: store.attemptId,
			startedAt: startedAt.toISOString(),
		},
		null,
	2,
	)}\n`;
	await writeFile(store.pathFor("worker"), workerPayload);
	await writeFile(store.pathFor("output"), "");
	const workerRef = store.refFor(
		"worker",
		Buffer.byteLength(workerPayload, "utf8"),
	);
	const liveOutput = createLiveOutputWriter(store);
	const liveEvents = createLiveEventAppender(
		join(store.attemptDir, "pi-events.jsonl"),
	);

	let stdoutText = "";
	let stderrText = "";
	let outputText = "";
	let failureKind: FailureKind | null = null;
	let selectedModelRef: string | undefined;
	let toolCallArtifactRefs: ArtifactRef[] = [];
	const toolCallTelemetry =
		options.captureToolCalls === true
			? new ToolCallTelemetryCollector()
			: undefined;

	try {
		const { module: piSdk, source } = await importPiSdk();
		const modelRuntime = await piSdk.ModelRuntime.create({
			authPath: join(piSdk.getAgentDir(), "auth.json"),
			modelsPath: join(piSdk.getAgentDir(), "models.json"),
			refreshOnCreate: false,
		});
		const settingsManager = piSdk.SettingsManager.create(
			cwd,
			piSdk.getAgentDir(),
		);
		const sessionManager = piSdk.SessionManager.inMemory(cwd);
		const resourceLoader = createChildResourceLoader(piSdk, options, cwd);
		await resourceLoader.reload();
		const requestedModel =
			options.model ??
			options.agentDefinition?.model ??
			options.hostModel;
		const requestedThinking =
			options.thinking ?? options.agentDefinition?.thinking;
		const configuredModel =
			requestedModel ?? settingsManager.getDefaultModel?.();
		const configuredProvider = settingsManager.getDefaultProvider?.();
		let model: ModelLike | undefined;
		let modelThinking: ThinkingLevel | undefined;
		if (configuredModel !== undefined) {
			const modelReference =
				configuredModel.includes("/") || configuredProvider === undefined
					? configuredModel
					: `${configuredProvider}/${configuredModel}`;
			const resolved = await resolveRequestedModel(
				modelRuntime,
				piSdk.resolveModelScopeWithDiagnostics,
				modelReference,
			);
			model = resolved.model;
			modelThinking = resolved.thinkingLevel;
			selectedModelRef = `${model.provider ?? "?"}/${model.id ?? "?"}`;
		}
		const tools = options.tools ?? options.agentDefinition?.tools;

		const { session } = await piSdk.createAgentSession({
			cwd,
			modelRuntime,
			sessionManager,
			resourceLoader,
			excludeTools: ["subagent"],
			...(tools === undefined ? {} : { tools }),
			...(model === undefined ? {} : { model }),
			settingsManager,
			...(requestedThinking === undefined && modelThinking === undefined
				? {}
				: { thinkingLevel: requestedThinking ?? modelThinking }),
		});

		let activityHandler: () => void = () => undefined;
		let assistantTextHandler: (text: string) => void = () => undefined;
		const unsubscribe = session.subscribe?.((event) => {
			activityHandler();
			toolCallTelemetry?.processEvent(event);
			publishLiveTranscriptEvent(store.runId, store.attemptId, event);
			liveEvents.append(event);
			const delta = maybeTextDelta(event);
			stdoutText += delta;
			liveOutput.append(delta);
			const agentEndText = maybeAssistantTextFromAgentEnd(event);
			if (agentEndText.length > 0) outputText = agentEndText;
			if (stdoutText.length > 0) assistantTextHandler(stdoutText);
		});

		try {
			const outcome = await promptWithStops(
				session,
				buildPrompt(options),
				timeoutMs,
				inactivityTimeoutMs,
				recoveryInactivityTimeoutMs,
				options.signal,
				(handler) => {
					activityHandler = handler;
				},
				(handler) => {
					assistantTextHandler = handler;
				},
				(probeCount) => {
					stderrText += `[recovery] inactivity detected; sent session finish probe (attempt ${probeCount})\n`;
				},
			);
			if (outcome.failureKind !== null) failureKind = outcome.failureKind;
			if (outcome.finishedByMarker)
				stderrText += "[recovery] session replied with finish marker; completed.\n";
			if (outputText.length === 0)
				outputText = assistantTextFromMessages(session.messages);
			if (outputText.length === 0) outputText = stdoutText;
		} finally {
			if (typeof unsubscribe === "function") unsubscribe();
			session.dispose?.();
		}

		if (source !== undefined)
		stderrText += `${JSON.stringify({ sdkSource: source })}\n`;
	} catch (error) {
		failureKind = failureKind ?? "model";
		stderrText += `${error instanceof Error ? error.message : String(error)}\n`;
	}
	await liveOutput.close();
	await liveEvents.close();

	if (failureKind === null && outputText.length === 0) {
		failureKind = "model";
		// The SDK reports an unusable provider credential as an assistant turn
		// with no content, so the run reaches this point with no error text at
		// all. Name the model that was actually used and the one workaround that
		// exists, otherwise the caller only sees an unexplained empty result.
		stderrText += `Inline SDK session completed without assistant output${
			selectedModelRef === undefined ? "" : ` for model ${selectedModelRef}`
		}. The inline backend builds its own model runtime and cannot authenticate providers registered by a Pi extension; pass an explicit model backed by auth.json, or use backend: "headless" so the child loads ambient extensions first.\n`;
	}

	toolCallArtifactRefs = await flushToolCallTelemetry(toolCallTelemetry, store);

	const completedAt = new Date();
	const status =
		failureKind === null
			? "completed"
			: failureKind === "abort"
				? "cancelled"
				: "failed";
	const artifacts: ArtifactRef[] = [
		workerRef,
		await store.writeTextArtifact("stderr", stderrText),
		await store.writeTextArtifact("output", outputText),
		...toolCallArtifactRefs,
	];

	return await store.writeResult({
		backend: "inline",
		status,
		failureKind,
		cwd: artifactCwd,
		startedAt,
		completedAt,
		workspace: options.workspace ?? { mode: "shared", cwd },
		sandbox: { enabled: false },
		exitCode: null,
		signal: failureKind === "abort" ? "ABORT" : null,
		artifacts,
		correlationId: options.correlationId,
		metadata: {
			contextLengthExceeded: detectContextLengthExceeded({ stderrText }),
		},
	});
}
