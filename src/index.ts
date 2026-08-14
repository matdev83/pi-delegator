import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	catalogEntries,
	discoverSubagentCatalog,
	formatAgentCatalogText,
} from "./catalog.ts";
import {
	attachProgress,
	resetProgress,
	settleProgress,
} from "./live-progress.ts";
import { resetLiveTranscripts } from "./live-transcript.ts";
import {
	listSessionRuns,
	openSubagentWatch,
	registerSubagentWatchShortcuts,
} from "./watch.ts";
import {
	SingleLineComponent,
	HiddenComponent,
	ProgressLineComponent,
	subagentNumberSuffix,
	resetWidgetOrdinals,
	widgetOrdinalFor,
} from "./core/components.ts";
import {
	TOOL_NAME,
	buildSubagentToolDefinition,
	isRunAction,
	isLogsAction,
	isRecord,
	handleKillCommand,
	notifyKillResult,
} from "./orchestrate/tool-executor.ts";
import { interruptRun } from "./orchestrate/interrupt.ts";
import { reconcileSubagentRun } from "./orchestrate/reconcile.ts";
import { getRunLogs, getRunStatus, waitForRun } from "./orchestrate/status.ts";
import { showSubagentPanel } from "./panel.ts";

export default function registerSubagentEngine(pi: ExtensionAPI) {
	registerSubagentWatchShortcuts(pi);
	if (typeof pi.on === "function") {
		pi.on("tool_execution_start", (event, ctx) => {
			if (event.toolName !== TOOL_NAME || !isRunAction(event.args)) return;
			const requestedCwd =
				isRecord(event.args) &&
				typeof event.args.cwd === "string" &&
				event.args.cwd.length > 0
					? event.args.cwd
					: ctx.cwd;
			attachProgress(event.toolCallId, requestedCwd, () => undefined);
		});
		pi.on("tool_execution_end", (event) => {
			if (event.toolName !== TOOL_NAME) return;
			// The host's terminal event is authoritative even if registry finalization
			// is delayed or fails. The settled result row no longer needs polling.
			settleProgress(event.toolCallId, event.isError ? "failed" : "completed");
		});
		pi.on("session_shutdown", () => {
			resetProgress();
			resetLiveTranscripts();
			resetWidgetOrdinals();
		});
		pi.on("session_start", async (_event, ctx) => {
			resetWidgetOrdinals();
			setSubagentToolEnabled(pi, isSubagentToolEnabled(pi, ctx), ctx);
			await refreshSubagentCatalog(pi, ctx.cwd);
		});
		pi.on("session_tree", async (_event, ctx) => {
			setSubagentToolEnabled(pi, isSubagentToolEnabled(pi, ctx), ctx);
			await refreshSubagentCatalog(pi, ctx.cwd);
		});
	}
	if (typeof pi.registerCommand === "function") {
		pi.registerCommand("subagent", {
			description:
				"Subagent utilities. Use `/subagent enable|disable` to control LLM exposure, `/subagent panel` for status, `/subagent watch [number|runId]` for a live run, or `/subagent kill [runId|all]` to cancel runs.",
			getArgumentCompletions(prefix) {
				if (/^kill\s+/i.test(prefix)) {
					const value = prefix.trim().slice("kill".length).trim();
					if ("all".startsWith(value.toLowerCase())) {
						return [
							{
								value: "all",
								label: "all",
								description: "Cancel all active runs in this Pi session",
							},
						];
					}
					return null;
				}
				const items = [
					{
						value: "enable",
						label: "enable",
						description: "Expose the subagent tool to the LLM for this session",
					},
					{
						value: "disable",
						label: "disable",
						description: "Hide the subagent tool from the LLM for this session",
					},
					{
						value: "panel",
						label: "panel",
						description: "Open the live Subagents status panel",
					},
					{
						value: "watch",
						label: "watch [number|runId]",
						description: "Open one current-session subagent run in a modal",
					},
					{
						value: "kill",
						label: "kill [runId|all]",
						description: "Cancel one run, the only active run, or all active runs",
					},
				];
				const filtered = items.filter((item) =>
					item.value.startsWith(prefix.trim()),
				);
				return filtered.length > 0 ? filtered : null;
			},
			async handler(args, ctx) {
				const commandArgs = args.trim();
				const normalizedArgs = commandArgs
					.replace(/^\/?subagent\b\s*/, "")
					.trim();
				if (normalizedArgs === "enable" || normalizedArgs === "disable") {
					const enabled = normalizedArgs === "enable";
					setSubagentToolEnabled(pi, enabled, ctx);
					ctx.ui.notify?.(
						enabled
							? "Subagent tool enabled for this session."
							: "Subagent tool disabled for this session; it is hidden from the LLM.",
						"info",
					);
					return;
				}
				if (normalizedArgs === "panel") {
					await showSubagentPanel(ctx);
					return;
				}
				const watchMatch = /^watch(?:\s+(\S+))?$/.exec(normalizedArgs);
				if (watchMatch !== null) {
					await openSubagentWatch(ctx, watchMatch[1] ?? "1");
					return;
				}
				if (await handleKillCommand(normalizedArgs, ctx)) return;
				ctx.ui.notify?.(
					"Usage: /subagent enable|disable|panel|watch [number|runId]|kill [runId|all]",
					"warning",
				);
			},
		});
	}

	pi.registerTool(buildSubagentToolDefinition(DEFAULT_SUBAGENT_DESCRIPTION, []));
	void refreshSubagentCatalog(pi, process.cwd());
}

const DEFAULT_SUBAGENT_DESCRIPTION = [
	"Subagent engine. Executes headless/tmux/herdr/inline workers; supports workspace:auto/worktree isolation, bounded parallel fanout, async lifecycle lookup, mark-background, reconcile, and conservative interrupt. Workspaces default to shared; set worktree:true for parallel tasks that mutate files.",
	"",
	"{CATALOG}",
].join("\n");

type SubagentToolDefinition = ToolDefinition<any, any, any>;

/**
 * Refresh the LLM-facing subagent catalog for a working directory. Discovers
 * global + project agent profiles and re-registers the tool so its description
 * and prompt guidelines list every available profile. No-op when unchanged.
 */
interface CatalogRefreshState {
	lastDescription: string;
	requestId: number;
	enabledBySession: Map<string, boolean>;
}

const catalogRefreshStates = new WeakMap<object, CatalogRefreshState>();

function catalogStateFor(pi: ExtensionAPI): CatalogRefreshState {
	const existing = catalogRefreshStates.get(pi as object);
	if (existing !== undefined) return existing;
	const created: CatalogRefreshState = {
		lastDescription: "",
		requestId: 0,
		enabledBySession: new Map(),
	};
	catalogRefreshStates.set(pi as object, created);
	return created;
}

function sessionKey(ctx: unknown): string {
	if (isRecord(ctx)) {
		const sessionManager = ctx.sessionManager;
		if (isRecord(sessionManager) && typeof sessionManager.getSessionId === "function") {
			try {
				const id = sessionManager.getSessionId();
				if (typeof id === "string" && id.length > 0) return id;
			} catch {
				// Fall back to the extension instance when session metadata is unavailable.
			}
		}
	}
	return "__current__";
}

function setSubagentToolEnabled(
	pi: ExtensionAPI,
	enabled: boolean,
	ctx: unknown,
): void {
	const state = catalogStateFor(pi);
	state.enabledBySession.set(sessionKey(ctx), enabled);
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return;
	}
	const active = pi.getActiveTools();
	const next = enabled
		? active.includes(TOOL_NAME)
			? active
			: [...active, TOOL_NAME]
		: active.filter((name) => name !== TOOL_NAME);
	if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
		pi.setActiveTools(next);
	}
}

function isSubagentToolEnabled(pi: ExtensionAPI, ctx: unknown): boolean {
	return catalogStateFor(pi).enabledBySession.get(sessionKey(ctx)) ?? true;
}

async function refreshSubagentCatalog(
	pi: ExtensionAPI,
	cwd: string,
): Promise<void> {
	const state = catalogStateFor(pi);
	const requestId = ++state.requestId;
	try {
		const { agents } = await discoverSubagentCatalog(cwd);
		if (requestId !== state.requestId) return;
		const description = DEFAULT_SUBAGENT_DESCRIPTION.replace(
			"{CATALOG}",
			formatAgentCatalogText(agents),
		);
		if (description === state.lastDescription) return;
		const guidelines =
			agents.length === 0
				? []
				: [
						"When delegating to a subagent, prefer a named profile from the subagent tool description whose purpose matches the task. Never invent profile names. Omit agent to run an unnamed general-purpose worker.",
					];
		pi.registerTool(buildSubagentToolDefinition(description, guidelines));
		state.lastDescription = description;
	} catch {
		// Catalog refresh must never break session startup.
	}
}
