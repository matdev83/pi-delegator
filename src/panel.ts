import { basename } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Status } from "./core/constants.ts";
import { clip, visibleLength } from "./core/text-width.ts";
import {
	isEscapeKey,
	isArrowKey,
	isTabKey,
	isPageKey,
	isEnterKey,
} from "./core/keyboard.ts";
import { nowMs, fmtAge, fmtElapsed } from "./core/formatters.ts";
import {
	loadRuns,
	runHasFailure,
	childFailureCount,
	sanitizeRunText,
	isActive,
	safeRelative,
	DEFAULT_RUNS_DIR,
	type RunRow,
	type TaskRow,
	type ScopeFilter,
	type StatusFilter,
	type PanelSnapshot,
	type LoadOptions,
} from "./orchestrate/runs-loader.ts";

const LIVE_REFRESH_MS = 1_500;
const PANEL_MIN_LINES = 12;
const PANEL_MAX_LINES = 30;
const PANEL_RESERVED_TUI_LINES = 8;

type FocusGroup = "scope" | "status" | "detail";

interface PanelTheme {
	fg?(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

interface PanelTui {
	requestRender?: () => void;
}

function style(theme: PanelTheme, color: string, text: string): string {
	return theme.fg?.(color, text) ?? text;
}

function bold(theme: PanelTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}

function pad(text: string, width: number): string {
	const visible = visibleLength(text);
	return visible >= width
		? clip(text, width)
		: text + " ".repeat(width - visible);
}

function statusColor(status: Status): string {
	if (status === "completed") return "success";
	if (status === "running" || status === "pending") return "warning";
	if (status === "failed" || status === "cancelled") return "error";
	return "accent";
}

function statusLabel(status: Status): string {
	if (status === "completed") return "done";
	return status;
}

function runStatusLabel(run: Pick<RunRow, "status" | "childSummary">): string {
	const base = statusLabel(run.status);
	return childFailureCount(run.childSummary) > 0 ? `${base}+child` : base;
}

function runStatusDetail(run: Pick<RunRow, "status" | "childSummary">): string {
	const failures = childFailureCount(run.childSummary);
	return failures > 0
		? `${statusLabel(run.status)} (child failures: ${failures})`
		: statusLabel(run.status);
}

function runStatusColor(run: Pick<RunRow, "status" | "childSummary">): string {
	return childFailureCount(run.childSummary) > 0
		? "error"
		: statusColor(run.status);
}

function splitLine(left: string, right: string, width: number): string {
	const gap = width - visibleLength(left) - visibleLength(right);
	if (gap <= 1) return clip(`${left} ${right}`, width);
	return `${left}${" ".repeat(gap)}${right}`;
}

function border(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function panelLineBudget(): number {
	const rows = process.stdout.rows;
	if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0)
		return PANEL_MAX_LINES;
	return Math.max(
		PANEL_MIN_LINES,
		Math.min(PANEL_MAX_LINES, rows - PANEL_RESERVED_TUI_LINES),
	);
}

function currentSessionIdFromCtx(
	ctx: ExtensionCommandContext,
): string | undefined {
	const raw = ctx as unknown as {
		sessionManager?: { getSessionId?: () => unknown };
	};
	try {
		const id = raw.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export class SubagentPanel implements Component {
	private snapshot: PanelSnapshot = {
		runs: [],
		totalRuns: 0,
		loadedAt: new Date(nowMs()),
		hiddenRuns: 0,
		staleLocators: 0,
		invalidLocators: 0,
		skippedLocators: 0,
	};
	private selectedRun = 0;
	private showMorePages = 0;
	private scope: ScopeFilter;
	private statusFilter: StatusFilter = "all";
	private focus: FocusGroup = "scope";
	private detailOffset = 0;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;
	private loading = false;

	constructor(
		private readonly cwd: string,
		private readonly theme: PanelTheme,
		private readonly tui: PanelTui,
		private readonly done: () => void,
		private readonly currentSessionId?: string,
	) {
		this.scope = currentSessionId === undefined ? "cwd" : "session";
		void this.refresh({ preserveSelection: false });
		this.timer = setInterval(() => void this.refresh(), LIVE_REFRESH_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearInterval(this.timer);
	}

	invalidate(): void {
		// Stateless render; refresh loop owns data invalidation.
	}

	handleInput(data: string): void {
		if (data === "q" || isEscapeKey(data)) {
			this.dispose();
			this.done();
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (data === "m") {
			if (this.snapshot.hiddenRuns > 0) {
				this.showMorePages += 1;
				void this.refresh();
			}
			return;
		}
		if (isTabKey(data) || data === "shift+tab" || data === "\u001b[Z") {
			const groups: FocusGroup[] = ["scope", "status", "detail"];
			const direction = data === "shift+tab" || data === "\u001b[Z" ? -1 : 1;
			const current = groups.indexOf(this.focus);
			this.focus =
				groups[(current + direction + groups.length) % groups.length] ??
				"scope";
			this.tui.requestRender?.();
			return;
		}
		if (isArrowKey(data, "right") || data === "l") {
			void this.cycleFocused(1);
			return;
		}
		if (isArrowKey(data, "left") || data === "h") {
			void this.cycleFocused(-1);
			return;
		}
		if (isEnterKey(data)) return;
		if (this.focus === "detail") {
			if (isArrowKey(data, "up") || data === "k") this.scrollDetail(-1);
			if (isArrowKey(data, "down") || data === "j") this.scrollDetail(1);
			if (isPageKey(data, "up")) this.scrollDetail(-8);
			if (isPageKey(data, "down")) this.scrollDetail(8);
			return;
		}
		if (isArrowKey(data, "up") || data === "k") this.moveRun(-1);
		if (isArrowKey(data, "down") || data === "j") this.moveRun(1);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxLines = panelLineBudget();
		const lines: string[] = [];
		const active = this.snapshot.runs.filter((run) =>
			isActive(run.status),
		).length;
		const failed = this.snapshot.runs.filter((run) =>
			runHasFailure(run),
		).length;
		const title = `${style(this.theme, "accent", "●")} ${bold(this.theme, "Subagents")}`;
		const stale = this.snapshot.staleLocators + this.snapshot.invalidLocators;
		const staleText =
			stale > 0 || this.snapshot.skippedLocators > 0
				? ` · stale ${this.snapshot.staleLocators} · skipped ${this.snapshot.invalidLocators + this.snapshot.skippedLocators}`
				: "";
		const status = `live · ${active} active · ${failed} failed · ${this.snapshot.runs.length}/${this.snapshot.totalRuns} shown${staleText} · updated ${fmtAge(this.snapshot.loadedAt.getTime())}`;
		lines.push(splitLine(title, style(this.theme, "muted", status), safeWidth));
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(this.renderControls(safeWidth));
		lines.push(this.renderScopeHelp(safeWidth));
		lines.push(style(this.theme, "border", border(safeWidth)));

		if (this.snapshot.runs.length === 0) {
			const bodyHeight = Math.max(1, maxLines - lines.length - 2);
			lines.push(
				style(this.theme, "muted", clip(this.emptyMessage(), safeWidth)),
			);
			for (let index = 1; index < bodyHeight; index += 1) lines.push("");
			lines.push(style(this.theme, "border", border(safeWidth)));
			lines.push(style(this.theme, "dim", this.footerHelp(false)));
			return lines.slice(0, maxLines).map((line) => clip(line, safeWidth));
		}

		let leftWidth = Math.max(30, Math.min(64, Math.floor(safeWidth * 0.42)));
		if (safeWidth - leftWidth - 3 < 30)
			leftWidth = Math.max(18, safeWidth - 33);
		const rightWidth = safeWidth - leftWidth - 3;
		const selectedRun =
			this.snapshot.runs[
				Math.min(this.selectedRun, this.snapshot.runs.length - 1)
			];
		const selectedTask = selectedRun.tasks.at(-1);
		const bodyHeight = Math.max(1, maxLines - lines.length - 2);
		const runLines = this.renderRuns(leftWidth, bodyHeight);
		const detailLines = this.renderDetailWindow(
			this.renderDetail(selectedRun, selectedTask, rightWidth),
			rightWidth,
			bodyHeight,
		);
		const bodyLines = bodyHeight;
		for (let index = 0; index < bodyLines; index += 1) {
			lines.push(
				`${pad(runLines[index] ?? "", leftWidth)} ${style(this.theme, "border", "│")} ${pad(detailLines[index] ?? "", rightWidth)}`,
			);
		}
		lines.push(style(this.theme, "border", border(safeWidth)));
		lines.push(style(this.theme, "dim", this.footerHelp(true)));
		return lines.slice(0, maxLines).map((line) => clip(line, safeWidth));
	}

	private emptyMessage(): string {
		if (this.scope === "session" && this.currentSessionId === undefined)
			return `No current session id; showing current cwd ${DEFAULT_RUNS_DIR}`;
		if (this.scope === "session")
			return "No subagent runs found for this session";
		if (this.scope === "all")
			return "No indexed or current-workspace subagent runs found";
		return `No subagent runs found under ${DEFAULT_RUNS_DIR}`;
	}

	private async refresh(
		options: { preserveSelection?: boolean } = {},
	): Promise<void> {
		if (this.loading || this.disposed) return;
		this.loading = true;
		try {
			const previousKey =
				options.preserveSelection === false
					? undefined
					: this.snapshot.runs[this.selectedRun]?.key;
			const snapshot = await loadRuns({
				cwd: this.cwd,
				scope: this.scope,
				statusFilter: this.statusFilter,
				currentSessionId: this.currentSessionId,
				showMorePages: this.showMorePages,
			});
			this.snapshot = snapshot;
			const oldSelectedRun = this.selectedRun;
			const nextIndex =
				previousKey === undefined
					? -1
					: snapshot.runs.findIndex((run) => run.key === previousKey);
			this.selectedRun =
				nextIndex >= 0
					? nextIndex
					: Math.min(this.selectedRun, Math.max(0, snapshot.runs.length - 1));
			if (this.selectedRun !== oldSelectedRun) this.detailOffset = 0;
			this.tui.requestRender?.();
		} finally {
			this.loading = false;
		}
	}

	private async cycleFocused(delta: number): Promise<void> {
		if (this.focus === "scope") {
			const scopes: ScopeFilter[] = ["session", "cwd", "all"];
			const current = scopes.indexOf(this.scope);
			this.scope =
				scopes[(current + delta + scopes.length) % scopes.length] ?? "cwd";
			this.detailOffset = 0;
		} else if (this.focus === "status") {
			const filters: StatusFilter[] = ["all", "running", "completed", "failed"];
			const current = filters.indexOf(this.statusFilter);
			this.statusFilter =
				filters[(current + delta + filters.length) % filters.length] ?? "all";
			this.detailOffset = 0;
		} else {
			this.scrollDetail(delta > 0 ? 1 : -1);
			return;
		}
		this.selectedRun = 0;
		this.showMorePages = 0;
		await this.refresh({ preserveSelection: false });
	}

	private footerHelp(withDetailKeys: boolean): string {
		const detail = withDetailKeys ? " · PgUp/PgDn detail" : "";
		const more = this.snapshot.hiddenRuns > 0 ? " · m show more" : "";
		return `tab focus scope/status/detail · ←→ change · ↑↓/j/k select/scroll${detail} · r refresh${more} · q/esc close`;
	}

	private moveRun(delta: number): void {
		const runCount = this.snapshot.runs.length;
		if (runCount === 0) return;
		const current = Math.max(0, Math.min(runCount - 1, this.selectedRun));
		const next = (current + delta + runCount) % runCount;
		if (next !== this.selectedRun) this.detailOffset = 0;
		this.selectedRun = next;
		this.tui.requestRender?.();
	}

	private scrollDetail(delta: number): void {
		this.detailOffset = Math.max(0, this.detailOffset + delta);
		this.tui.requestRender?.();
	}

	private renderControls(width: number): string {
		const focused = (group: FocusGroup, text: string): string =>
			this.focus === group
				? style(this.theme, "accent", text)
				: style(this.theme, "dim", text);
		const scopeTabs = this.renderTabSet(
			[
				["session", "session"],
				["cwd", "cwd"],
				["all", "all"],
			],
			this.scope,
		);
		const statusTabs = this.renderTabSet(
			[
				["all", "all"],
				["running", "running"],
				["completed", "completed"],
				["failed", "failed"],
			],
			this.statusFilter,
		);
		return clip(
			`${focused("scope", "scope:")} ${scopeTabs}   ${focused("status", "status:")} ${statusTabs}   ${focused("detail", "detail:")} scroll`,
			width,
		);
	}

	private renderTabSet<T extends string>(
		tabs: Array<[T, string]>,
		current: T,
	): string {
		return tabs
			.map(([value, label]) =>
				value === current
					? style(this.theme, "accent", `[${label}]`)
					: style(this.theme, "dim", label),
			)
			.join(" ");
	}

	private renderScopeHelp(width: number): string {
		return clip(
			style(
				this.theme,
				"dim",
				"session: this conversation · cwd: this workspace · all: global index + cwd legacy",
			),
			width,
		);
	}

	private renderRuns(width: number, maxVisible: number): string[] {
		const maxStart = Math.max(0, this.snapshot.runs.length - maxVisible);
		const windowStart = Math.min(
			maxStart,
			Math.max(0, this.selectedRun - maxVisible + 1),
		);
		const showCwd = this.scope !== "cwd" && width >= 46;
		return this.snapshot.runs
			.slice(windowStart, windowStart + maxVisible)
			.map((run, index) => {
				const runIndex = windowStart + index;
				const marker =
					runIndex === this.selectedRun
						? style(this.theme, "accent", "▸")
						: " ";
				const status = runStatusLabel(run);
				const age = fmtAge(run.updatedMs);
				const cwdLabel = showCwd
					? ` · ${basename(run.sourceCwd) || run.sourceCwd}`
					: "";
				const fullMeta = `${age}${cwdLabel}`;
				const statusWidth = Math.max(4, Math.min(13, status.length));
				const fullIdWidth = visibleLength(run.runId);
				let metaWidth = visibleLength(fullMeta);
				let idWidth = width - statusWidth - metaWidth - 4;
				if (showCwd && idWidth < fullIdWidth) {
					metaWidth = Math.max(
						visibleLength(age),
						width - statusWidth - fullIdWidth - 4,
					);
					idWidth = width - statusWidth - metaWidth - 4;
				}
				idWidth = Math.max(6, idWidth);
				const meta = clip(fullMeta, metaWidth);
				const line = `${marker} ${pad(clip(run.runId, idWidth), idWidth)} ${style(this.theme, runStatusColor(run), pad(status, statusWidth))} ${style(this.theme, "muted", meta)}`;
				return clip(line, width);
			});
	}

	private renderDetailWindow(
		detailLines: string[],
		width: number,
		height: number,
	): string[] {
		if (detailLines.length <= height) {
			this.detailOffset = 0;
			return detailLines;
		}
		const hintHeight = 1;
		const contentHeight = Math.max(1, height - hintHeight);
		const maxOffset = Math.max(0, detailLines.length - contentHeight);
		this.detailOffset = Math.min(this.detailOffset, maxOffset);
		const end = Math.min(detailLines.length, this.detailOffset + contentHeight);
		const hint = style(
			this.theme,
			this.focus === "detail" ? "accent" : "dim",
			`detail ${this.detailOffset + 1}-${end}/${detailLines.length} · ${this.focus === "detail" ? "↑↓/Pg scroll" : "tab to detail"}`,
		);
		return [...detailLines.slice(this.detailOffset, end), clip(hint, width)];
	}

	private renderDetail(
		run: RunRow,
		task: TaskRow | undefined,
		width: number,
	): string[] {
		const lines: string[] = [];
		const labelWidth = Math.max(8, Math.min(12, Math.floor(width * 0.18)));
		const divider = (): void => {
			lines.push(style(this.theme, "border", "─".repeat(Math.max(1, width))));
		};
		const section = (title: string): void => {
			if (lines.length > 0) divider();
			lines.push(style(this.theme, "accent", title));
		};
		const field = (
			name: string,
			value: string | null | undefined,
			color = "muted",
		): void => {
			const rendered =
				value && value.length > 0
					? sanitizeRunText(value, this.currentSessionId)
					: "—";
			const label = style(
				this.theme,
				"dim",
				pad(clip(name, labelWidth), labelWidth),
			);
			lines.push(
				`${label} ${style(this.theme, color, clip(rendered, Math.max(1, width - labelWidth - 1)))}`,
			);
		};

		section("RUN");
		field("Run ID", run.runId, "text");
		field("Status", runStatusDetail(run), runStatusColor(run));
		field("Elapsed", fmtElapsed(run.startedAt, run.completedAt));
		field("Updated", fmtAge(run.updatedMs));

		if (run.childSummary !== undefined) {
			const latest = run.childSummary.latestFailure;
			field(
				"Children",
				latest === null
					? `total ${run.childSummary.total} · running ${run.childSummary.running} · failed ${run.childSummary.failed}`
					: `total ${run.childSummary.total} · failed ${run.childSummary.failed} · latest ${latest.childRunId}${latest.taskId ? `/${latest.taskId}` : ""}${latest.failureKind ? ` · ${latest.failureKind}` : ""}`,
				childFailureCount(run.childSummary) > 0 ? "error" : "muted",
			);
			if (run.childSummary.activeChildRunIds.length > 0) {
				field(
					"Active children",
					clip(run.childSummary.activeChildRunIds.join(", "), width - 16),
					"muted",
				);
			}
		}

		section("ATTEMPT");
		field(
			"All",
			run.tasks
				.map(
					(candidate) =>
						`${candidate.attemptId}:${statusLabel(candidate.status)}`,
				)
				.join(" · "),
		);
		if (task === undefined) {
			field("Selected", "no attempts recorded", "muted");
			return lines;
		}
		field(
			"Selected",
			`${run.tasks.indexOf(task) + 1}/${run.tasks.length} · ${task.attemptId} · ${statusLabel(task.status)} · ${fmtElapsed(task.startedAt, task.completedAt)}${task.modelLabel ? ` · ${task.modelLabel}` : ""}`,
			statusColor(task.status),
		);
		field("Started", task.startedAt);
		field("Completed", task.completedAt ?? "running");
		if (task.failureKind !== null) field("Failure", task.failureKind, "error");

		section(`LOG TAIL (${task.attemptId})`);
		field("Source", task.logPath ?? task.resultPath);
		const tail =
			task.logTail.length > 0
				? task.logTail
				: ["No log output loaded for this scope yet."];
		for (const logLine of tail)
			lines.push(
				`${style(this.theme, "dim", "›")} ${clip(sanitizeRunText(logLine, this.currentSessionId), Math.max(1, width - 2))}`,
			);

		field("Result", task.resultPath);
		field("Log", task.logPath ?? "—");

		section("WORKSPACE");
		field("Registry", safeRelative(this.cwd, run.sourceCwd));
		field("RunsDir", run.runsDir);
		field("Attempt", safeRelative(this.cwd, task.workspace));
		field(
			"Worktree",
			task.worktreePath === null
				? "—"
				: safeRelative(this.cwd, task.worktreePath),
		);

		if (run.eventTail.length > 0) {
			section("EVENTS");
			for (const eventLine of run.eventTail)
				lines.push(
					`${style(this.theme, "dim", "›")} ${clip(sanitizeRunText(eventLine, this.currentSessionId), Math.max(1, width - 2))}`,
				);
		}
		return lines;
	}
}

export async function showSubagentPanel(
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify?.(
			"/subagent panel is available only in the interactive TUI.",
			"warning",
		);
		return;
	}
	const currentSessionId = currentSessionIdFromCtx(ctx);
	await ctx.ui.custom<void>(
		(
			tui: PanelTui,
			theme: PanelTheme,
			_keybindings: unknown,
			done: () => void,
		) => new SubagentPanel(ctx.cwd, theme, tui, done, currentSessionId),
	);
}
