// Ephemeral, process-local transcript channel for `/subagent watch`.
//
// Tool payload bodies may contain credentials or other sensitive data, so they
// must not be written to durable pi-events.jsonl artifacts. Active foreground
// runs can still expose their native tool progress to the local TUI through
// this bounded in-memory channel.

const MAX_TRANSCRIPTS = 24;
const MAX_EVENTS_PER_TRANSCRIPT = 512;
const MAX_TRANSCRIPT_CHARS = 1024 * 1024;
const MAX_STRING_CHARS = 32 * 1024;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 96;
const MAX_DEPTH = 10;

const transcripts = new Map<string, Record<string, unknown>[]>();
const transcriptChars = new Map<string, number>();

function transcriptKey(runId: string, attemptId: string): string {
	return `${runId}\u0000${attemptId}`;
}

function boundedValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string")
		return value.length <= MAX_STRING_CHARS
			? value
			: `${value.slice(0, MAX_STRING_CHARS)}…`;
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return value;
	if (typeof value !== "object") return undefined;
	if (depth >= MAX_DEPTH) return "[truncated]";
	if (Array.isArray(value))
		return value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => boundedValue(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
		const bounded = boundedValue(child, depth + 1);
		if (bounded !== undefined) out[key] = bounded;
	}
	return out;
}

function eventChars(event: Record<string, unknown>): number {
	try {
		return JSON.stringify(event).length;
	} catch {
		return 0;
	}
}

function trimTranscript(
	key: string,
	events: Record<string, unknown>[],
): void {
	while (
		events.length > MAX_EVENTS_PER_TRANSCRIPT ||
		(transcriptChars.get(key) ?? 0) > MAX_TRANSCRIPT_CHARS
	) {
		const removed = events.shift();
		if (removed === undefined) break;
		transcriptChars.set(
			key,
			Math.max(0, (transcriptChars.get(key) ?? 0) - eventChars(removed)),
		);
	}
}

/** Publish one native Pi event for a foreground run. Nothing is written to disk. */
export function publishLiveTranscriptEvent(
	runId: string,
	attemptId: string,
	event: unknown,
): void {
	const bounded = boundedValue(event);
	if (bounded === null || typeof bounded !== "object" || Array.isArray(bounded))
		return;
	const key = transcriptKey(runId, attemptId);
	let events = transcripts.get(key);
	if (events === undefined) {
		events = [];
		transcripts.set(key, events);
		transcriptChars.set(key, 0);
		while (transcripts.size > MAX_TRANSCRIPTS) {
			const oldest = transcripts.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			transcripts.delete(oldest);
			transcriptChars.delete(oldest);
		}
	}
	const record = bounded as Record<string, unknown>;
	if (record.type === "message_update") {
		const update = record.assistantMessageEvent;
		const previous = events.at(-1)?.assistantMessageEvent;
		if (
			update !== null &&
			typeof update === "object" &&
			previous !== null &&
			typeof previous === "object"
		) {
			const nextDelta = (update as Record<string, unknown>).delta;
			const priorDelta = (previous as Record<string, unknown>).delta;
			const sameKind =
				(update as Record<string, unknown>).type ===
					(previous as Record<string, unknown>).type &&
				(update as Record<string, unknown>).contentIndex ===
					(previous as Record<string, unknown>).contentIndex;
			if (
				sameKind &&
				typeof nextDelta === "string" &&
				typeof priorDelta === "string"
			) {
				const previousSize = eventChars(events.at(-1)!);
				(previous as Record<string, unknown>).delta =
					`${priorDelta}${nextDelta}`.slice(-MAX_STRING_CHARS);
				transcriptChars.set(
					key,
					(transcriptChars.get(key) ?? 0) -
						previousSize +
						eventChars(events.at(-1)!),
				);
				trimTranscript(key, events);
				return;
			}
		}
	}
	if (record.type === "tool_execution_update") {
		const priorIndex = events.findLastIndex(
			(candidate) =>
				candidate.type === "tool_execution_update" &&
				candidate.toolCallId === record.toolCallId,
		);
		if (priorIndex >= 0) {
			const [removed] = events.splice(priorIndex, 1);
			transcriptChars.set(
				key,
				Math.max(0, (transcriptChars.get(key) ?? 0) - eventChars(removed!)),
			);
		}
	}
	events.push(record);
	transcriptChars.set(
		key,
		(transcriptChars.get(key) ?? 0) + eventChars(record),
	);
	trimTranscript(key, events);
}

/** Return an isolated snapshot so transcript reconstruction may mutate it. */
export function readLiveTranscriptEvents(
	runId: string,
	attemptId: string,
): Record<string, unknown>[] {
	const events = transcripts.get(transcriptKey(runId, attemptId));
	if (events === undefined) return [];
	return structuredClone(events);
}

/** Test/session teardown helper. */
export function resetLiveTranscripts(): void {
	transcripts.clear();
	transcriptChars.clear();
}
