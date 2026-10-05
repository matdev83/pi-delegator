import {
	setRunTitle,
	type RunRef,
	type RunTitleSource,
} from "../artifacts/index.ts";
import { readDelegatorEnv } from "../core/env.ts";
import { requestModelSessionTitle } from "./title-model.ts";

// Automatic, human-readable titles for subagent sessions.
//
// A dispatch is announced to the parent model as `subagent #3 run · single ·
// reviewer`, which says nothing about *what* the worker is doing. Titles fix
// that by asking a lightweight auxiliary model for a short label derived from
// the dispatch text, without involving the parent session.
//
// The request is auxiliary by design, so the policy is strictly fail-open:
//   - it runs in the background and is never awaited by the dispatch path,
//   - it is bounded by a timeout,
//   - and any failure (disabled config, unknown model, provider error,
//     timeout, unusable response, unwritable registry) degrades to the first
//     six words of the dispatch instead of touching the run outcome.

/** Model used for titles when nothing is configured: a free-model router. */
export const DEFAULT_TITLE_MODEL = "openrouter/free";
/** Words taken from the dispatch text when the model request cannot be used. */
export const FALLBACK_TITLE_WORDS = 6;
/** Upper bound for a generated title, in words. */
export const MAX_TITLE_WORDS = 6;
/** Upper bound for a stored title, in characters (keeps UI rows one line). */
export const MAX_TITLE_CHARS = 60;
export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;
export const MIN_TITLE_TIMEOUT_MS = 250;
export const MAX_TITLE_TIMEOUT_MS = 120_000;

export interface SessionTitleSettings {
	enabled: boolean;
	model: string;
	timeoutMs: number;
}

const DISABLED_VALUES = new Set(["0", "off", "false", "no", "disabled"]);
const ENABLED_VALUES = new Set(["1", "on", "true", "yes", "enabled"]);

function enabledFromEnv(raw: string | undefined): boolean {
	if (raw === undefined) return true;
	const value = raw.trim().toLowerCase();
	if (DISABLED_VALUES.has(value)) return false;
	if (ENABLED_VALUES.has(value)) return true;
	// Unrecognized values must never silently disable the feature.
	return true;
}

function timeoutFromEnv(raw: string | undefined): number {
	if (raw === undefined || raw.trim().length === 0)
		return DEFAULT_TITLE_TIMEOUT_MS;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_TITLE_TIMEOUT_MS;
	return Math.min(MAX_TITLE_TIMEOUT_MS, Math.max(MIN_TITLE_TIMEOUT_MS, parsed));
}

/**
 * Resolve title configuration from the environment. Legacy `PI_SUBAGENT_*`
 * spellings are accepted by `readDelegatorEnv`; `PI_DELEGATOR_*` wins.
 */
export function resolveSessionTitleSettings(
	env: NodeJS.ProcessEnv = process.env,
): SessionTitleSettings {
	const model = readDelegatorEnv("TITLE_MODEL", env)?.trim();
	return {
		enabled: enabledFromEnv(readDelegatorEnv("TITLE", env)),
		model:
			model === undefined || model.length === 0
				? DEFAULT_TITLE_MODEL
				: model,
		timeoutMs: timeoutFromEnv(readDelegatorEnv("TITLE_TIMEOUT_MS", env)),
	};
}

/**
 * Poor-man's proxy title: the first few words of the dispatch text. Used
 * whenever the auxiliary request cannot produce a usable title, so a run is
 * always labelled with roughly what it is doing.
 */
export function dispatchFallbackTitle(
	dispatch: string | undefined | null,
	maxWords: number = FALLBACK_TITLE_WORDS,
): string {
	if (typeof dispatch !== "string") return "";
	const words = dispatch.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return "";
	return words.slice(0, Math.max(1, maxWords)).join(" ");
}

const LABEL_PREFIX = /^(?:title|session title)\s*[:\-\u2013\u2014]\s*/i;
const WRAPPING_MARKS =
	/^[\*_`"'\u201c\u201d\u2018\u2019\s]+|[\*_`"'\u201c\u201d\u2018\u2019\s]+$/g;
const TRAILING_PUNCTUATION = /[\s.,;:!?\-\u2013\u2014]+$/;

function stripWrappingMarks(text: string): string {
	let current = text;
	for (let pass = 0; pass < 4; pass += 1) {
		const next = current.replace(WRAPPING_MARKS, "");
		if (next === current) break;
		current = next;
	}
	return current;
}

/**
 * Turn raw model output into a storable one-line title, or `null` when the
 * response is unusable. Models wrap titles in quotes, bold markers, labels,
 * and trailing commentary; none of that may reach the UI or `run.json`.
 */
export function normalizeGeneratedTitle(
	raw: string | undefined | null,
	maxWords: number = MAX_TITLE_WORDS,
): string | null {
	if (typeof raw !== "string") return null;
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (firstLine === undefined) return null;
	const stripped = stripWrappingMarks(
		firstLine.replace(/\*+/g, "").replace(LABEL_PREFIX, ""),
	);
	if (stripped.length === 0) return null;
	const words = stripped
		.split(" ")
		.filter(Boolean)
		.slice(0, Math.max(1, maxWords));
	const clipped = stripWrappingMarks(
		words.join(" ").slice(0, MAX_TITLE_CHARS).trim(),
	).replace(TRAILING_PUNCTUATION, "");
	return clipped.length === 0 ? null : clipped;
}

export interface SessionTitleRequest {
	dispatch: string;
	agent?: string;
	model: string;
	signal: AbortSignal;
}

/** Auxiliary model call used to name a session. Replaceable in tests. */
export type SessionTitleGenerator = (
	request: SessionTitleRequest,
) => Promise<string | null | undefined>;

export interface SessionTitleOutcome {
	title: string;
	source: RunTitleSource;
	model: string;
	/** Why the failover title was used, when it was. */
	reason?: string;
}

export interface GenerateSessionTitleOptions {
	dispatch: string;
	agent?: string;
	model: string;
	timeoutMs: number;
	generate: SessionTitleGenerator;
	/** Caller cancellation (session shutdown). A parent abort is not a failure. */
	signal?: AbortSignal;
}

/**
 * Ask the auxiliary model for a title, bounded by a timeout, and fall back to
 * the dispatch proxy on every failure path. Never rejects.
 */
export async function generateSessionTitle(
	options: GenerateSessionTitleOptions,
): Promise<SessionTitleOutcome> {
	const fallback = dispatchFallbackTitle(options.dispatch);
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	if (options.signal !== undefined) {
		if (options.signal.aborted) controller.abort();
		else options.signal.addEventListener("abort", abort, { once: true });
	}
	const timer = setTimeout(abort, Math.max(1, options.timeoutMs));
	let reason: string | undefined;
	try {
		const raw = await options.generate({
			dispatch: options.dispatch,
			...(options.agent === undefined ? {} : { agent: options.agent }),
			model: options.model,
			signal: controller.signal,
		});
		const title = normalizeGeneratedTitle(raw);
		if (title !== null)
			return { title, source: "model", model: options.model };
		reason = "unusable-response";
	} catch (error) {
		// A caller abort is not a title failure worth reporting; it still has to
		// resolve to the proxy so no dispatch is left without a label.
		if (controller.signal.aborted)
			reason = options.signal?.aborted === true ? "cancelled" : "timeout";
		else reason = `model-error: ${describe(error)}`;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
	return {
		title: fallback,
		source: "dispatch",
		model: options.model,
		...(reason === undefined ? {} : { reason }),
	};
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

const pending = new Set<AbortController>();

/** Abort in-flight title requests (session shutdown / test teardown). */
export function abortPendingSessionTitles(): void {
	for (const controller of [...pending]) controller.abort();
	pending.clear();
}

export interface ScheduleSessionTitleOptions {
	ref: RunRef;
	dispatch: string | undefined;
	agent?: string;
	env?: NodeJS.ProcessEnv;
	/** Injected in tests; defaults to the SDK-backed auxiliary request. */
	generate?: SessionTitleGenerator;
}

/**
 * Start background title generation for one run and persist the outcome.
 *
 * Callers intentionally do not await the returned promise: the dispatch must
 * continue immediately, and the title simply appears in the UI once it lands.
 * The promise never rejects and resolves to `null` when no title applies.
 */
export async function scheduleSessionTitle(
	options: ScheduleSessionTitleOptions,
): Promise<SessionTitleOutcome | null> {
	const settings = resolveSessionTitleSettings(options.env);
	if (!settings.enabled) return null;
	if (typeof options.dispatch !== "string") return null;
	if (options.dispatch.trim().length === 0) return null;
	const controller = new AbortController();
	pending.add(controller);
	try {
		const generate = options.generate ?? requestModelSessionTitle;
		const outcome = await generateSessionTitle({
			dispatch: options.dispatch,
			...(options.agent === undefined ? {} : { agent: options.agent }),
			model: settings.model,
			timeoutMs: settings.timeoutMs,
			generate,
			signal: controller.signal,
		});
		if (outcome.title.length === 0) return null;
		await setRunTitle({
			...options.ref,
			title: outcome.title,
			source: outcome.source,
			model: settings.model,
		}).catch(() => undefined);
		return outcome;
	} finally {
		pending.delete(controller);
	}
}
