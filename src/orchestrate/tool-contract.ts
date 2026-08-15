import { readOutputPreview, type OutputPreview } from "../output-preview.ts";

// Leaf module for the shared subagent tool contract. Everything here is the
// single home of constants, type guards, and result-shaping helpers that the
// orchestrate modules (lifecycle, tool-executor, result-compact,
// kill-orchestrator) share. It must never import from those modules, or the
// re-export hub (tool-executor) closes an import cycle.

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
	"inactivityTimeoutSeconds",
	"recoveryInactivitySeconds",
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

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	details: unknown;
	isError: boolean;
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

export function textResult(
	payload: unknown,
	isError: boolean,
	details?: unknown,
): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details,
		isError,
	};
}

export function displayText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length <= maxLength
		? normalized
		: `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export async function addOutputPreview<T extends { logs?: readonly { type: string; path: string; artifactCwd?: string }[]; }>(
	snapshot: T | null,
): Promise<(T & Partial<OutputPreview>) | null> {
	if (snapshot === null) return null;
	const preview = await readOutputPreview(
		snapshot.logs?.find((log) => log.artifactCwd)?.artifactCwd ?? process.cwd(),
		snapshot.logs ?? [],
	);
	return preview === undefined ? snapshot : { ...snapshot, ...preview };
}
