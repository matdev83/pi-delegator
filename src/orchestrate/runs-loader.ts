import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResultEnvelope, RunEvent } from "../artifacts/index.ts";
import type { Status } from "../core/constants.ts";
import { clip, stripAnsi, visibleLength } from "../core/text-width.ts";
import {
	listRunLocators,
	locatorOlderThanPruneThreshold,
	removeRunLocator,
	type RunRefLocator,
} from "./run-ref.ts";
import {
	summarizeChildEvents,
	type RunChildSummary,
} from "./status.ts";
import { readDelegatorEnv } from "../core/env.ts";
import { nowMs, fmtAge, fmtElapsed } from "../core/formatters.ts";

export const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const LOG_TAIL_LINES = 5;
const STALE_RUN_AFTER_MS = 30_000;
const DEFAULT_RECENT_TERMINAL_LIMIT = 20;
const ALL_SCOPE_RECENT_TERMINAL_LIMIT = 50;

export type ScopeFilter = "session" | "cwd" | "all";
export type StatusFilter = "all" | "running" | "completed" | "failed";

export interface TaskRow {
	attemptId: string;
	status: Status;
	backend: string;
	failureKind: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	resultPath: string;
	logPath: string | null;
	logTail: string[];
	workspace: string;
	worktreePath: string | null;
	modelLabel: string;
}

export interface RunRow {
	key: string;
	runId: string;
	sourceCwd: string;
	runsDir: string;
	status: Status;
	backend: string;
	updatedMs: number;
	startedAt: string;
	completedAt: string | null;
	dependency: string | null;
	eventTail: string[];
	childSummary?: RunChildSummary;
	tasks: TaskRow[];
}

export interface PanelSnapshot {
	runs: RunRow[];
	totalRuns: number;
	hiddenRuns: number;
	loadedAt: Date;
	staleLocators: number;
	invalidLocators: number;
	skippedLocators: number;
}

export interface LoadOptions {
	cwd: string;
	scope: ScopeFilter;
	statusFilter: StatusFilter;
	currentSessionId?: string;
	showMorePages: number;
}

export function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

export function safeRelative(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
	return rel.split(sep).join("/");
}

export function sanitizeRunText(text: string, currentSessionId?: string): string {
	let sanitized = stripAnsi(text)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\r/g, "");
	if (currentSessionId && currentSessionId.length > 0)
		sanitized = sanitized.split(currentSessionId).join("[session]");
	return sanitized;
}

export function displayEventLine(text: string, currentSessionId?: string): string {
	const sanitized = sanitizeRunText(text, currentSessionId).trim();
	if (!sanitized.startsWith("{") || !sanitized.endsWith("}")) return sanitized;
	try {
		const event = JSON.parse(sanitized) as Record<string, unknown>;
		const message = event.message;
		if (typeof message === "string" && message.length > 0) return message;
		if (message !== null && typeof message === "object") {
			const record = message as Record<string, unknown>;
			if (typeof record.text === "string" && record.text.length > 0)
				return record.text;
			if (Array.isArray(record.content)) {
				const text = record.content
					.map((part) =>
						part !== null && typeof part === "object" &&
							typeof (part as Record<string, unknown>).text === "string"
							? (part as Record<string, unknown>).text as string
							: "",
					)
					.filter(Boolean)
					.join(" ");
				if (text.length > 0) return text;
			}
		}
		if (typeof event.text === "string" && event.text.length > 0)
			return event.text;
		if (typeof event.type === "string") return "";
	} catch {
		// Preserve malformed non-JSON diagnostics.
	}
	return sanitized;
}

export function statusPriority(status: Status): number {
	if (status === "running") return 0;
	if (status === "pending") return 1;
	if (status === "failed") return 2;
	if (status === "cancelled") return 3;
	return 4;
}

export function aggregateRunStatus(attempts: TaskRow[]): Status {
	return attempts.at(-1)?.status ?? "pending";
}

export function aggregateLegacyRunStatus(attempts: TaskRow[]): Status {
	if (attempts.some((attempt) => attempt.status === "running"))
		return "running";
	if (attempts.some((attempt) => attempt.status === "pending"))
		return "pending";
	if (attempts.some((attempt) => attempt.status === "failed")) return "failed";
	if (attempts.some((attempt) => attempt.status === "cancelled"))
		return "cancelled";
	return attempts.length === 0 ? "pending" : "completed";
}

export function isResultEnvelope(value: unknown): value is ResultEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string" &&
		(typeof (value as { attemptId?: unknown }).attemptId === "string" ||
			typeof (value as { taskId?: unknown }).taskId === "string")
	);
}

export interface RegistryTaskRecord {
	attemptId?: string;
	taskId?: string;
	status: Status;
	backend?: string;
	failureKind?: string | null;
	startedAt?: string;
	completedAt?: string | null;
	updatedAt?: string;
	heartbeatAt?: string;
	artifactCwd?: string;
	resultPath?: string;
	outputPath?: string;
	stdoutPath?: string;
	stderrPath?: string;
	process?: { pid?: number; workerPid?: number };
	workspace?: { cwd?: string; worktreePath?: string | null };
}

export interface RegistryRunRecord {
	runId: string;
	mode?: string;
	status: Status;
	backend?: string;
	dependency?: string | null;
	parentSessionId?: string;
	startedAt: string;
	updatedAt: string;
	completedAt: string | null;
	attempts?: RegistryTaskRecord[];
	tasks?: RegistryTaskRecord[];
}

export function isRegistryRunRecord(value: unknown): value is RegistryRunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string" &&
		typeof (value as { startedAt?: unknown }).startedAt === "string" &&
		typeof (value as { updatedAt?: unknown }).updatedAt === "string" &&
		(Array.isArray((value as { attempts?: unknown }).attempts) ||
			Array.isArray((value as { tasks?: unknown }).tasks))
	);
}

export function parseRunEvents(text: string): RunEvent[] {
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as RunEvent;
			} catch {
				return null;
			}
		})
		.filter((event): event is RunEvent => event !== null);
}

export async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

export async function readTextTail(
	path: string,
	currentSessionId?: string,
): Promise<string[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text
		.split(/\r?\n/)
		.map((line) => displayEventLine(line, currentSessionId))
		.filter(Boolean)
		.slice(-LOG_TAIL_LINES);
}

export async function readLogTail(
	cwd: string,
	result: ResultEnvelope,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<{ path: string | null; tail: string[] }> {
	const artifact =
		result.artifacts.find((candidate) => candidate.type === "output") ??
		result.artifacts.find((candidate) => candidate.type === "stdout") ??
		result.artifacts.find((candidate) => candidate.type === "stderr");
	if (artifact === undefined) return { path: null, tail: [] };
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		return { path: artifact.path, tail: [] };
	const path = resolve(cwd, artifact.path.split("/").join(sep));
	if (!isInsideOrEqual(cwd, path)) return { path: artifact.path, tail: [] };
	const tail = loadTails ? await readTextTail(path, currentSessionId) : [];
	return { path: artifact.path, tail };
}

export function modelLabel(result: ResultEnvelope): string {
	return typeof result.metadata?.model === "string"
		? result.metadata.model
		: "";
}

export function isActive(status: Status): boolean {
	return status === "pending" || status === "running";
}

export function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "EPERM"
		);
	}
}

export function timestampFresh(
	value: string | undefined,
	staleAfterMs = STALE_RUN_AFTER_MS,
): boolean {
	if (value === undefined) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && nowMs() - time <= staleAfterMs;
}

export function runKey(cwd: string, runsDir: string, runId: string): string {
	return `${cwd}\u0000${runsDir}\u0000${runId}`;
}

export async function readTask(
	cwd: string,
	resultPath: string,
	mtimeMs: number,
	loadTails: boolean,
	currentSessionId?: string,
	options: { staleOverride?: boolean } = {},
): Promise<TaskRow | null> {
	const parsed = await readJson(resultPath);
	if (!isResultEnvelope(parsed)) return null;
	const log = await readLogTail(cwd, parsed, loadTails, currentSessionId);
	const stale =
		isActive(parsed.status) &&
		(options.staleOverride ?? nowMs() - mtimeMs > STALE_RUN_AFTER_MS);
	return {
		attemptId: parsed.attemptId ?? parsed.taskId ?? "unknown",
		status: stale ? "failed" : parsed.status,
		backend: parsed.backend,
		failureKind: stale ? "stale" : parsed.failureKind,
		startedAt: parsed.startedAt,
		completedAt: stale ? new Date(mtimeMs).toISOString() : parsed.completedAt,
		durationMs: parsed.durationMs,
		resultPath: safeRelative(cwd, resultPath),
		logPath: log.path,
		logTail: log.tail,
		workspace: parsed.workspace.cwd,
		worktreePath: parsed.workspace.worktreePath,
		modelLabel: modelLabel(parsed),
	};
}

export async function readTailFromRegistryPath(
	task: RegistryTaskRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<{ path: string | null; tail: string[] }> {
	const artifactCwd = task.artifactCwd;
	const path = task.outputPath ?? task.stdoutPath ?? task.stderrPath;
	if (
		artifactCwd === undefined ||
		path === undefined ||
		isAbsolute(path) ||
		path.split("/").includes("..")
	)
		return { path: path ?? null, tail: [] };
	const absolute = resolve(artifactCwd, path.split("/").join(sep));
	if (!isInsideOrEqual(resolve(artifactCwd), absolute))
		return { path, tail: [] };
	const tail = loadTails ? await readTextTail(absolute, currentSessionId) : [];
	return { path, tail };
}

export function registryTaskStale(task: RegistryTaskRecord): boolean {
	if (!isActive(task.status)) return false;
	if (pidAlive(task.process?.pid) || pidAlive(task.process?.workerPid))
		return false;
	if (timestampFresh(task.heartbeatAt) || timestampFresh(task.updatedAt))
		return false;
	return true;
}

export async function readTaskFromRegistry(
	cwd: string,
	task: RegistryTaskRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<TaskRow> {
	const registryStale = registryTaskStale(task);
	if (
		task.artifactCwd !== undefined &&
		task.resultPath !== undefined &&
		!isAbsolute(task.resultPath) &&
		!task.resultPath.split("/").includes("..")
	) {
		const absolute = resolve(
			task.artifactCwd,
			task.resultPath.split("/").join(sep),
		);
		if (isInsideOrEqual(resolve(task.artifactCwd), absolute)) {
			const statInfo = await stat(absolute).catch(() => null);
			if (statInfo !== null) {
				const parsed = await readTask(
					task.artifactCwd,
					absolute,
					statInfo.mtimeMs,
					loadTails,
					currentSessionId,
					isActive(task.status) ? { staleOverride: registryStale } : undefined,
				);
				if (parsed !== null) return parsed;
			}
		}
	}
	const log = await readTailFromRegistryPath(task, loadTails, currentSessionId);
	const stale = registryStale;
	return {
		attemptId: task.attemptId ?? task.taskId ?? "unknown",
		status: stale ? "failed" : task.status,
		backend: task.backend ?? "unknown",
		failureKind: stale ? "stale" : (task.failureKind ?? null),
		startedAt:
			task.startedAt ?? task.updatedAt ?? new Date(nowMs()).toISOString(),
		completedAt:
			task.completedAt ??
			(stale
				? (task.updatedAt ??
					task.heartbeatAt ??
					new Date(nowMs()).toISOString())
				: null),
		durationMs: null,
		resultPath: task.resultPath ?? "—",
		logPath: log.path,
		logTail: log.tail,
		workspace: task.workspace?.cwd ?? cwd,
		worktreePath: task.workspace?.worktreePath ?? null,
		modelLabel: "",
	};
}

export async function readRunFromRegistry(
	cwd: string,
	runsDir: string,
	runDir: string,
	registry: RegistryRunRecord,
	loadTails: boolean,
	currentSessionId?: string,
): Promise<RunRow | null> {
	const eventsText = await readFile(join(runDir, "events.jsonl"), "utf8").catch(
		() => "",
	);
	const eventTail = loadTails
		? eventsText
				.split(/\r?\n/)
				.map((line) => displayEventLine(line, currentSessionId))
				.filter(Boolean)
				.slice(-LOG_TAIL_LINES)
		: [];
	const childSummary = summarizeChildEvents(parseRunEvents(eventsText));
	const records = registry.attempts ?? registry.tasks ?? [];
	const tasks = await Promise.all(
		records.map((task) =>
			readTaskFromRegistry(cwd, task, loadTails, currentSessionId),
		),
	);
	tasks.sort((a, b) =>
		a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }),
	);
	return {
		key: runKey(cwd, runsDir, registry.runId),
		runId: registry.runId,
		sourceCwd: cwd,
		runsDir,
		status: registry.status ?? aggregateRunStatus(tasks),
		backend:
			registry.backend ??
			tasks.at(-1)?.backend ??
			tasks[0]?.backend ??
			"unknown",
		updatedMs: Number.isFinite(Date.parse(registry.updatedAt))
			? Date.parse(registry.updatedAt)
			: nowMs(),
		startedAt: registry.startedAt,
		completedAt: registry.completedAt,
		dependency: registry.dependency ?? null,
		eventTail,
		...(childSummary === undefined ? {} : { childSummary }),
		tasks,
	};
}

export async function loadRunsFromCwd(
	cwd: string,
	options: Pick<LoadOptions, "currentSessionId"> & { sessionOnly?: string },
): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	const runsDir = resolve(cwd, DEFAULT_RUNS_DIR);
	if (!isInsideOrEqual(cwd, runsDir))
		return { runs: [], stale: 0, invalid: 0, skipped: 0 };
	const runEntries = await readdir(runsDir, { withFileTypes: true }).catch(
		() => [],
	);
	const runs: RunRow[] = [];
	let invalid = 0;

	for (const runEntry of runEntries) {
		if (!runEntry.isDirectory()) continue;
		const runDir = join(runsDir, runEntry.name);
		const registry = await readJson(join(runDir, "run.json"));
		if (isRegistryRunRecord(registry)) {
			if (
				options.sessionOnly !== undefined &&
				registry.parentSessionId !== options.sessionOnly
			)
				continue;
			const row = await readRunFromRegistry(
				cwd,
				DEFAULT_RUNS_DIR,
				runDir,
				registry,
				true,
				options.currentSessionId,
			).catch(() => null);
			if (row !== null) runs.push(row);
			else invalid += 1;
			continue;
		}

		if (options.sessionOnly !== undefined) continue;

		const taskEntries = await readdir(runDir, { withFileTypes: true }).catch(
			() => [],
		);
		const attemptEntries = await readdir(join(runDir, "attempts"), {
			withFileTypes: true,
		}).catch(() => []);
		const candidates = [
			...attemptEntries
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(runDir, "attempts", entry.name, "result.json")),
			...taskEntries
				.filter((entry) => entry.isDirectory() && entry.name !== "attempts")
				.map((entry) => join(runDir, entry.name, "result.json")),
		];
		const eventsText = await readFile(
			join(runDir, "events.jsonl"),
			"utf8",
		).catch(() => "");
		const eventTail = eventsText
			.split(/\r?\n/)
			.map((line) => sanitizeRunText(line, options.currentSessionId))
			.filter(Boolean)
			.slice(-LOG_TAIL_LINES);
		const childSummary = summarizeChildEvents(parseRunEvents(eventsText));
		const tasks: TaskRow[] = [];
		let updatedMs = 0;
		for (const resultPath of candidates) {
			const resultStat = await stat(resultPath).catch(() => null);
			if (resultStat === null) continue;
			updatedMs = Math.max(updatedMs, resultStat.mtimeMs);
			const task = await readTask(
				cwd,
				resultPath,
				resultStat.mtimeMs,
				true,
				options.currentSessionId,
			);
			if (task !== null) tasks.push(task);
		}
		if (tasks.length === 0) continue;
		tasks.sort((a, b) =>
			a.attemptId.localeCompare(b.attemptId, undefined, { numeric: true }),
		);
		const status = aggregateLegacyRunStatus(tasks);
		runs.push({
			key: runKey(cwd, DEFAULT_RUNS_DIR, runEntry.name),
			runId: runEntry.name,
			sourceCwd: cwd,
			runsDir: DEFAULT_RUNS_DIR,
			status,
			backend: tasks[0]?.backend ?? "unknown",
			updatedMs,
			startedAt:
				tasks.map((task) => task.startedAt).sort()[0] ??
				new Date(updatedMs).toISOString(),
			completedAt: tasks.every((task) => task.completedAt !== null)
				? (tasks
						.map((task) => task.completedAt)
						.sort()
						.at(-1) ?? null)
				: null,
			dependency: null,
			eventTail,
			...(childSummary === undefined ? {} : { childSummary }),
			tasks,
		});
	}
	return { runs, stale: 0, invalid, skipped: 0 };
}

export async function loadRunFromLocator(
	locator: RunRefLocator,
	options: Pick<LoadOptions, "scope" | "currentSessionId">,
): Promise<{
	row: RunRow | null;
	stale: boolean;
	invalid: boolean;
	pruned: boolean;
}> {
	try {
		const cwd = resolve(locator.cwd);
		const runsDir = locator.runsDir ?? DEFAULT_RUNS_DIR;
		const absoluteRunsDir = resolve(cwd, runsDir);
		if (!isInsideOrEqual(cwd, absoluteRunsDir))
			return { row: null, stale: false, invalid: true, pruned: false };
		const runDir = join(absoluteRunsDir, locator.runId);
		const runDirStat = await stat(runDir).catch(() => null);
		if (runDirStat === null || !runDirStat.isDirectory()) {
			if (
				locatorOlderThanPruneThreshold(locator) &&
				(await removeRunLocator(locator.runId))
			) {
				return { row: null, stale: false, invalid: false, pruned: true };
			}
			return { row: null, stale: true, invalid: false, pruned: false };
		}
		const registry = await readJson(join(runDir, "run.json"));
		if (!isRegistryRunRecord(registry))
			return { row: null, stale: false, invalid: true, pruned: false };
		if (options.scope === "session") {
			if (
				options.currentSessionId === undefined ||
				registry.parentSessionId !== options.currentSessionId
			)
				return { row: null, stale: false, invalid: false, pruned: false };
		}
		const row = await readRunFromRegistry(
			cwd,
			runsDir,
			runDir,
			registry,
			false,
			options.currentSessionId,
		);
		return { row, stale: row === null, invalid: false, pruned: false };
	} catch {
		return { row: null, stale: false, invalid: true, pruned: false };
	}
}

export function childFailureCount(summary: RunChildSummary | undefined): number {
	return (summary?.failed ?? 0) + (summary?.cancelled ?? 0);
}

export function runHasFailure(run: Pick<RunRow, "status" | "childSummary">): boolean {
	return (
		run.status === "failed" ||
		run.status === "cancelled" ||
		childFailureCount(run.childSummary) > 0
	);
}

export function statusMatches(run: RunRow, filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "running")
		return run.status === "running" || run.status === "pending";
	if (filter === "completed")
		return run.status === "completed" && !runHasFailure(run);
	return runHasFailure(run);
}

export function recentTerminalLimit(
	scope: ScopeFilter,
	showMorePages: number,
): number {
	const base =
		scope === "all"
			? ALL_SCOPE_RECENT_TERMINAL_LIMIT
			: DEFAULT_RECENT_TERMINAL_LIMIT;
	return base * Math.max(1, showMorePages + 1);
}

export function compareRecentRuns(a: RunRow, b: RunRow): number {
	return b.updatedMs - a.updatedMs || a.key.localeCompare(b.key);
}

export function takeRecentRuns(runs: RunRow[], limit: number): RunRow[] {
	if (runs.length <= limit) return runs;
	const visibleKeys = new Set(
		runs
			.toSorted(compareRecentRuns)
			.slice(0, limit)
			.map((run) => run.key),
	);
	return runs.filter((run) => visibleKeys.has(run.key));
}

export function limitRunsForPanel(
	runs: RunRow[],
	options: Pick<LoadOptions, "scope" | "statusFilter" | "showMorePages">,
): { runs: RunRow[]; hiddenRuns: number } {
	if (options.statusFilter === "running") return { runs, hiddenRuns: 0 };
	const limit = recentTerminalLimit(options.scope, options.showMorePages);
	if (options.statusFilter !== "all") {
		const limited = takeRecentRuns(runs, limit);
		return {
			runs: limited,
			hiddenRuns: Math.max(0, runs.length - limited.length),
		};
	}
	const active = runs.filter((run) => isActive(run.status));
	const terminal = runs.filter((run) => !isActive(run.status));
	const limitedTerminal = takeRecentRuns(terminal, limit);
	return {
		runs: [...active, ...limitedTerminal],
		hiddenRuns: Math.max(0, terminal.length - limitedTerminal.length),
	};
}

export async function mergeLoadedRuns(
	...groups: Array<{
		runs: RunRow[];
		stale: number;
		invalid: number;
		skipped: number;
	}>
): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	return {
		runs: groups.flatMap((group) => group.runs),
		stale: groups.reduce((sum, group) => sum + group.stale, 0),
		invalid: groups.reduce((sum, group) => sum + group.invalid, 0),
		skipped: groups.reduce((sum, group) => sum + group.skipped, 0),
	};
}

export async function loadRunsFromIndex(options: LoadOptions): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	const listed = await listRunLocators();
	const locators =
		options.scope === "session" && options.currentSessionId !== undefined
			? listed.locators.filter(
					(locator) => locator.parentSessionId === options.currentSessionId,
				)
			: listed.locators;
	const runs: RunRow[] = [];
	let stale = 0;
	let invalid = listed.invalidCount;
	let pruned = listed.prunedCount;
	for (const locator of locators) {
		const loaded = await loadRunFromLocator(locator, options);
		if (loaded.row !== null) runs.push(loaded.row);
		if (loaded.stale) stale += 1;
		if (loaded.invalid) invalid += 1;
		if (loaded.pruned) pruned += 1;
	}
	return {
		runs,
		stale,
		invalid,
		skipped: listed.skippedCount + pruned,
	};
}

export async function loadRunsForScope(options: LoadOptions): Promise<{
	runs: RunRow[];
	stale: number;
	invalid: number;
	skipped: number;
}> {
	if (options.scope === "cwd") return loadRunsFromCwd(options.cwd, options);
	if (options.scope === "session") {
		const indexed = await loadRunsFromIndex(options);
		if (options.currentSessionId === undefined) return indexed;
		const local = await loadRunsFromCwd(options.cwd, {
			currentSessionId: options.currentSessionId,
			sessionOnly: options.currentSessionId,
		});
		return mergeLoadedRuns(indexed, local);
	}
	const indexed = await loadRunsFromIndex(options);
	const local = await loadRunsFromCwd(options.cwd, options);
	return mergeLoadedRuns(indexed, local);
}

export async function loadRuns(options: LoadOptions): Promise<PanelSnapshot> {
	const effectiveScope =
		options.scope === "session" && options.currentSessionId === undefined
			? "cwd"
			: options.scope;
	const loaded = await loadRunsForScope({ ...options, scope: effectiveScope });
	const unique = new Map<string, RunRow>();
	for (const run of loaded.runs) unique.set(run.key, run);
	const allRuns = [...unique.values()].sort(
		(a, b) =>
			statusPriority(a.status) - statusPriority(b.status) ||
			b.updatedMs - a.updatedMs ||
			a.key.localeCompare(b.key),
	);
	const filtered = allRuns.filter((run) =>
		statusMatches(run, options.statusFilter),
	);
	const limited = limitRunsForPanel(filtered, options);
	return {
		runs: limited.runs,
		totalRuns: filtered.length,
		hiddenRuns: limited.hiddenRuns,
		loadedAt: new Date(nowMs()),
		staleLocators: loaded.stale,
		invalidLocators: loaded.invalid,
		skippedLocators: loaded.skipped,
	};
}
