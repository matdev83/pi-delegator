import { resolve } from "node:path";
import { Type } from "typebox";
import type { ArtifactRef, ResultEnvelope } from "../artifacts/index.ts";
import { createAttemptArtifactStore, readRunRecord } from "../artifacts/index.ts";
import type {
	ResolveInput,
	ResolveValidationFailure,
	ResolvedBackend,
	ExecutionMode,
} from "../core/constants.ts";
import { clip, visibleLength } from "../core/text-width.ts";
import { readOutputPreview, OUTPUT_PREVIEW_MAX_BYTES, OUTPUT_PREVIEW_TOTAL_MAX_BYTES, type OutputPreview } from "../output-preview.ts";
import {
	isRecord,
	formatKeyList,
	TOOL_NAME,
	SUPPORTED_KEYS,
	hasAnyKey,
	AGENT_TASK_KEYS,
	textResult,
	displayText,
	addOutputPreview,
	type ToolTextContent,
	type ToolResult,
} from "./tool-contract.ts";
import { loadAgentByName, type AgentDefinition } from "../agents.ts";

interface ToolResultDetails {
	resolved?: ResolvedBackend;
	waited?: {
		backend: string;
		status: string;
		outcome: string;
		snapshot: string[];
	};
}

function resultSummary(payload: unknown): string {
	if (!isRecord(payload)) return "Done";
	const status = displayText(payload.status, 20) ?? "completed";
	const runId = displayText(payload.runId, 32);
	const backend = displayText(payload.backend, 16);
	const failureKind = displayText(payload.failureKind, 24);
	if (status === "running")
		return ["Started", backend, runId].filter(Boolean).join(" · ");
	if (status === "completed")
		return ["Completed", backend, runId].filter(Boolean).join(" · ");
	if (status === "cancelled")
		return ["Cancelled", failureKind, runId].filter(Boolean).join(" · ");
	if (status === "failed")
		return ["Failed", failureKind, runId].filter(Boolean).join(" · ");
	return [status, runId].filter(Boolean).join(" · ");
}

function artifactSummary(artifacts: readonly ArtifactRef[]) {
	return artifacts.map((artifact) => ({
		type: artifact.type,
		path: artifact.path,
		...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
	}));
}

async function compactResult(
	result: ResultEnvelope,
	error?: string,
	outputMaxBytes = OUTPUT_PREVIEW_MAX_BYTES,
) {
	const outputPreview = await readOutputPreview(
		result.cwd,
		result.artifacts,
		outputMaxBytes,
	);
	return {
		tool: TOOL_NAME,
		backend: result.backend,
		status: result.status,
		failureKind: result.failureKind,
		...(error === undefined ? {} : { error }),
		runId: result.runId,
		attemptId: result.attemptId,
		...(result.taskId === undefined ? {} : { taskId: result.taskId }),
		...(result.correlationId === undefined
			? {}
			: { correlationId: result.correlationId }),
		durationMs: result.durationMs,
		exitCode: result.exitCode,
		signal: result.signal,
		sandbox: result.sandbox,
		workspace: result.workspace,
		...(result.tmux === undefined ? {} : { tmux: result.tmux }),
		...(result.herdr === undefined ? {} : { herdr: result.herdr }),
		...(result.completion === undefined
			? {}
			: { completion: result.completion }),
		metadata: result.metadata,
		...(outputPreview === undefined ? {} : outputPreview),
		artifacts: artifactSummary(result.artifacts),
	};
}

async function compactResults(results: readonly ResultEnvelope[]) {
	let remaining = OUTPUT_PREVIEW_TOTAL_MAX_BYTES;
	const compacted = [];
	for (const result of results) {
		const budget = Math.min(OUTPUT_PREVIEW_MAX_BYTES, remaining);
		const item = await compactResult(result, undefined, budget);
		if (typeof item.output === "string")
			remaining = Math.max(0, remaining - Buffer.byteLength(item.output, "utf8"));
		compacted.push(item);
	}
	return compacted;
}

function subagentCallSummary(input: unknown): string {
	const args = isRecord(input) ? input : {};
	const action = displayText(args.action, 16) ?? "run";
	const mode =
		displayText(args.mode, 16) ??
		(Array.isArray(args.tasks) ? "parallel" : "single");
	const pieces = [`subagent ${action}`];

	if (action === "run") {
		pieces.push(mode);
		if (Array.isArray(args.tasks))
			pieces.push(
				`${args.tasks.length} run${args.tasks.length === 1 ? "" : "s"}`,
			);
		const agent = displayText(args.agent, 24);
		if (agent) pieces.push(agent);
		const task = displayText(args.task, 48);
		if (task) pieces.push(task);
		const asyncMode =
			args.async === true ? "async" : displayText(args.onComplete, 16);
		if (args.failFast === true || args.cancelSiblingsOnFailure === true)
			pieces.push("fail-fast");
		if (asyncMode) pieces.push(asyncMode);
	} else {
		const runId = displayText(args.runId, 28);
		if (runId) pieces.push(runId);
		const attemptId =
			displayText(args.attemptId, 16) ?? displayText(args.taskId, 16);
		if (attemptId) pieces.push(attemptId);
	}

	return pieces.filter(Boolean).join(" · ");
}

function isRunAction(input: unknown): boolean {
	const args = isRecord(input) ? input : {};
	return args.action === undefined || args.action === "run";
}

function isLogsAction(input: unknown): boolean {
	return isRecord(input) && input.action === "logs";
}

function validationFailure(failure: ResolveValidationFailure): ToolResult {
	return textResult(
		{
			tool: TOOL_NAME,
			backend: failure.backend,
			status: failure.status,
			failureKind: failure.failureKind,
			error: failure.error,
		},
		true,
		{ resolved: failure },
	);
}


function executionMode(input: ResolveInput): ExecutionMode {
	if (input.mode !== undefined) return input.mode;
	if (input.tasks !== undefined) return "parallel";
	return "single";
}

function unsupportedPathError(
	raw: Record<string, unknown>,
	input: ResolveInput,
	backend: ResolvedBackend,
): string | undefined {
	const mode = executionMode(input);
	const unknownKeys = Object.keys(raw).filter(
		(key) => !SUPPORTED_KEYS.has(key),
	);
	if (unknownKeys.length > 0) {
		return `unsupported subagent option(s): ${formatKeyList(unknownKeys)}.`;
	}

	if (mode === "parallel") {
		return input.tasks === undefined
			? "parallel mode requires a non-empty tasks array."
			: undefined;
	}

	if (
		backend !== "inline" &&
		backend !== "headless" &&
		backend !== "tmux" &&
		backend !== "herdr"
	) {
		return `backend "${backend}" is not implemented in this MVP; only inline, headless, tmux, and herdr execution are supported.`;
	}

	if (hasAnyKey(raw, AGENT_TASK_KEYS) && input.task === undefined) {
		return `${backend} agent/task execution requires a non-empty "task".`;
	}

	if (!hasAnyKey(raw, AGENT_TASK_KEYS)) {
		return `${backend} execution requires agent/task input.`;
	}

	return undefined;
}

async function writeUnsupportedResult(
	cwd: string,
	backend: ResolvedBackend,
	input: ResolveInput,
): Promise<ResultEnvelope> {
	const startedAt = new Date();
	const store = await createAttemptArtifactStore({
		cwd,
		runsDir: input.runsDir,
	});
	const sandboxed = Boolean(input.sandbox);
	return await store.writeResult({
		backend,
		status: "failed",
		failureKind: "validation",
		cwd,
		startedAt,
		completedAt: new Date(),
		workspace: { mode: "shared", cwd },
		sandbox: { enabled: sandboxed },
		exitCode: null,
		signal: null,
		artifacts: [],
		correlationId: input.correlationId,
		metadata: { contextLengthExceeded: false },
	});
}

type ToolUpdateCallback = (update: {
	content: ToolTextContent[];
	details: unknown;
}) => void;

interface NotificationContext {
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

interface ProjectAgentApprovalContext extends NotificationContext {
	hasUI?: boolean;
	ui?: NotificationContext["ui"] & {
		confirm?: (title: string, message?: string) => Promise<boolean> | boolean;
	};
}

interface AgentRequest {
	agent: string;
	cwd?: string;
	agentScope?: ResolveInput["agentScope"];
	confirmProjectAgents?: boolean;
}

function agentRequests(input: ResolveInput): AgentRequest[] {
	if (input.tasks !== undefined) {
		return input.tasks
			.filter(
				(task): task is typeof task & { agent: string } =>
					typeof task.agent === "string" && task.agent.length > 0,
			)
			.map((task) => ({
				agent: task.agent,
				cwd: task.cwd,
				agentScope: task.agentScope ?? input.agentScope,
				confirmProjectAgents:
					task.confirmProjectAgents ?? input.confirmProjectAgents ?? false,
			}));
	}
	return typeof input.agent === "string" && input.agent.length > 0
		? [
				{
					agent: input.agent,
					cwd: input.cwd,
					agentScope: input.agentScope,
					confirmProjectAgents: input.confirmProjectAgents ?? false,
				},
			]
		: [];
}


export {
	resultSummary,
	artifactSummary,
	compactResult,
	compactResults,
	subagentCallSummary,
	isRunAction,
	isLogsAction,
	validationFailure,
	executionMode,
	unsupportedPathError,
	writeUnsupportedResult,
	agentRequests,
};
export type {
	ToolUpdateCallback,
	NotificationContext,
	ProjectAgentApprovalContext,
	AgentRequest,
};
