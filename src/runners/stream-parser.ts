import type { ResultMetadata } from "../artifacts/index.ts";

export interface PiJsonParseResult {
	finalAssistantText: string;
	errors: string[];
	parseErrors: string[];
	metadata: Partial<ResultMetadata>;
	usageAccumulation?: PiUsageAccumulation;
}

export interface PiUsageAccumulationSlot {
	count: number;
	total: unknown;
}

export interface PiUsageAccumulation {
	messageEnd: PiUsageAccumulationSlot;
	turnEnd: PiUsageAccumulationSlot;
}

export interface ContextLengthResolution {
	rawContextLengthExceeded: boolean;
	contextLengthExceeded: boolean;
	contextOverflowRecovered: boolean;
	recoveredStreamErrors: string[];
}

const CONTEXT_LENGTH_ERROR_PATTERN =
	/\bcontext[_ -]?length[_ -]?exceeded\b|\bcontext[_ -]?window[_ -]?(?:exceeded|overflow|exhausted)\b|\b(?:maximum|max)[_ -]?context[_ -]?length\b|\btoo many tokens\b|\b(?:prompt|input|request)[^\n]{0,80}\btoo large\b|\bcontext_length_exceeded\b/i;

const PARSED_EVENT_PATTERN =
	/"type"\s*:\s*"(?:message_end|turn_end|agent_end|error)"/;
const STREAM_EVENT_PATTERN =
	/"type"\s*:\s*"(?:message_start|message_update|tool_execution_start|tool_execution_update|tool_execution_end)"/;
export const MAX_PARSE_ERRORS = 20;
const MAX_JSON_LINE_CHARS = 64 * 1024 * 1024;

export function detectContextLengthExceeded(signals: {
	stderrText?: string;
	errors?: readonly string[];
}): boolean {
	const text = [signals.stderrText, ...(signals.errors ?? [])]
		.filter(
			(entry): entry is string => typeof entry === "string" && entry.length > 0,
		)
		.join("\n");
	return CONTEXT_LENGTH_ERROR_PATTERN.test(text);
}

export function resolveContextLengthState(
	parsed: PiJsonParseResult,
	rawContextLengthExceeded: boolean,
): ContextLengthResolution {
	const contextOverflowRecovered =
		rawContextLengthExceeded && finalAssistantSucceeded(parsed);
	return {
		rawContextLengthExceeded,
		contextLengthExceeded:
			rawContextLengthExceeded && !contextOverflowRecovered,
		contextOverflowRecovered,
		recoveredStreamErrors: contextOverflowRecovered
			? parsed.errors.filter((error) =>
					detectContextLengthExceeded({ errors: [error] }),
				)
			: [],
	};
}

function finalAssistantSucceeded(parsed: PiJsonParseResult): boolean {
	return (
		parsed.finalAssistantText.length > 0 &&
		parsed.metadata.stopReason !== "error"
	);
}

function textFromContent(content: unknown): string {
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

function errorText(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.message === "string" && record.message.length > 0)
			return record.message;
		if (typeof record.error === "string" && record.error.length > 0)
			return record.error;
	}
	return undefined;
}

const MAX_USAGE_DEPTH = 8;

function sumUsageValues(total: unknown, next: unknown, depth = 0): unknown {
	if (typeof next === "number") {
		if (!Number.isFinite(next)) return total;
		return typeof total === "number" ? total + next : next;
	}
	if (
		typeof next === "object" &&
		next !== null &&
		!Array.isArray(next) &&
		depth < MAX_USAGE_DEPTH
	) {
		const base: Record<string, unknown> =
			typeof total === "object" && total !== null && !Array.isArray(total)
				? { ...(total as Record<string, unknown>) }
				: {};
		for (const [key, value] of Object.entries(next)) {
			const merged = sumUsageValues(base[key], value, depth + 1);
			if (merged !== undefined) base[key] = merged;
		}
		return base;
	}
	return next ?? total;
}

function accumulateAssistantUsage(
	parsed: PiJsonParseResult,
	eventType: "message_end" | "turn_end",
	usage: unknown,
): void {
	const accumulation = (parsed.usageAccumulation ??= {
		messageEnd: { count: 0, total: undefined },
		turnEnd: { count: 0, total: undefined },
	});
	const slot =
		eventType === "message_end"
			? accumulation.messageEnd
			: accumulation.turnEnd;
	slot.count += 1;
	slot.total = sumUsageValues(slot.total, usage);
	parsed.metadata.usage =
		accumulation.messageEnd.count > 0
			? accumulation.messageEnd.total
			: accumulation.turnEnd.total;
}

function pushParseError(parsed: PiJsonParseResult, message: string): void {
	if (parsed.parseErrors.length < MAX_PARSE_ERRORS)
		parsed.parseErrors.push(message);
}

function parsePiJsonLine(
	line: string,
	lineNumber: number,
	parsed: PiJsonParseResult,
	onEvent?: (event: unknown) => void,
): void {
	if (line.trim().length === 0) return;
	if (
		!PARSED_EVENT_PATTERN.test(line) &&
		(onEvent === undefined || !STREAM_EVENT_PATTERN.test(line))
	)
		return;
	if (line.length > MAX_JSON_LINE_CHARS) {
		pushParseError(
			parsed,
			`line ${lineNumber}: JSON event too large to parse (${line.length} chars)`,
		);
		return;
	}

	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushParseError(parsed, `line ${lineNumber}: ${message}`);
		return;
	}

	onEvent?.(event);

	if (typeof event !== "object" || event === null) return;
	const record = event as Record<string, unknown>;
	const type = record.type;

	if (type === "message_end" || type === "turn_end") {
		const message = record.message;
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).role === "assistant"
		) {
			const assistant = message as Record<string, unknown>;
			parsed.finalAssistantText = textFromContent(assistant.content);
			if (typeof assistant.provider === "string")
				parsed.metadata.provider = assistant.provider;
			if (typeof assistant.model === "string")
				parsed.metadata.model = assistant.model;
			if (assistant.usage !== undefined)
				accumulateAssistantUsage(
					parsed,
					type as "message_end" | "turn_end",
					assistant.usage,
				);
			if (typeof assistant.stopReason === "string")
				parsed.metadata.stopReason = assistant.stopReason;
			if (assistant.stopReason === "error") {
				const text =
					errorText(assistant.errorMessage) ??
					errorText(assistant.error) ??
					"assistant stopped with an error";
				parsed.errors.push(text);
			}
		}
	} else if (type === "agent_end") {
		const messages = record.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (
					typeof message === "object" &&
					message !== null &&
					(message as Record<string, unknown>).role === "assistant"
				) {
					const text = textFromContent(
						(message as Record<string, unknown>).content,
					);
					if (text.length > 0) parsed.finalAssistantText = text;
				}
			}
		}
	}

	if (type === "error") {
		const text =
			errorText(record.error) ?? errorText(record.message) ?? errorText(record);
		if (text) parsed.errors.push(text);
	}
}

export class PiJsonStreamParser {
	readonly parsed: PiJsonParseResult = {
		finalAssistantText: "",
		errors: [],
		parseErrors: [],
		metadata: {},
	};
	private buffered = "";
	private lineNumber = 0;
	private discardingOversizedLine = false;
	private readonly onEvent?: (event: unknown) => void;

	constructor(onEvent?: (event: unknown) => void) {
		this.onEvent = onEvent;
	}

	push(chunk: Buffer | string): void {
		let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		while (text.length > 0) {
			if (this.discardingOversizedLine) {
				const newline = text.indexOf("\n");
				if (newline < 0) return;
				this.discardingOversizedLine = false;
				this.buffered = "";
				text = text.slice(newline + 1);
				continue;
			}

			const newline = text.indexOf("\n");
			const segment = newline < 0 ? text : text.slice(0, newline + 1);
			this.buffered += segment;
			text = newline < 0 ? "" : text.slice(newline + 1);

			if (this.buffered.length > MAX_JSON_LINE_CHARS) {
				this.lineNumber += 1;
				pushParseError(
					this.parsed,
					`line ${this.lineNumber}: JSON event too large to parse`,
				);
				this.buffered = "";
				this.discardingOversizedLine = newline < 0;
				continue;
			}

			if (newline >= 0) this.flushLine();
		}
	}

	private flushLine(): void {
		const line = this.buffered;
		this.buffered = "";
		this.lineNumber += 1;
		parsePiJsonLine(line, this.lineNumber, this.parsed, this.onEvent);
	}

	finish(): PiJsonParseResult {
		if (!this.discardingOversizedLine && this.buffered.length > 0)
			this.flushLine();
		return this.parsed;
	}
}

export function toBuffer(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export function emptyParseResult(): PiJsonParseResult {
	return { finalAssistantText: "", errors: [], parseErrors: [], metadata: {} };
}


const LIVE_EVENT_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

export function sanitizeLiveEventString(value: string): string {
	return value.replace(LIVE_EVENT_URL_PATTERN, (raw) => {
		try {
			const parsed = new URL(raw.replace(/[),.;!?]+$/g, ""));
			parsed.username = "";
			parsed.password = "";
			parsed.search = "";
			parsed.hash = "";
			return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
		} catch {
			return "[url]";
		}
	});
}

export function livePayloadChars(
	value: unknown,
	seen = new Set<object>(),
	depth = 0,
): number {
	if (typeof value === "string") return value.length;
	if (value === null || typeof value !== "object" || depth >= 8) return 0;
	if (seen.has(value)) return 0;
	seen.add(value);
	let chars = 0;
	const values = Array.isArray(value)
		? value
		: Object.values(value as Record<string, unknown>);
	for (const child of values.slice(0, 128)) {
		chars += livePayloadChars(child, seen, depth + 1);
		if (chars >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
	}
	return chars;
}
