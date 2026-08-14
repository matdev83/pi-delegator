import { clip, visibleLength } from "./text-width.ts";
import {
	getProgress,
	formatProgress,
	type LiveProgress,
} from "../live-progress.ts";

let nextWidgetOrdinal = 1;
const widgetOrdinals = new Map<string, number>();

export class SingleLineComponent {
	constructor(private readonly text: string) {}

	invalidate(): void {
		// Static one-line component.
	}

	render(width: number): string[] {
		return [clip(this.text, width)];
	}
}

export class HiddenComponent {
	invalidate(): void {
		// Intentionally invisible.
	}

	render(_width: number): string[] {
		return [];
	}
}

/**
 * Tool-panel row for the subagent tool. Shows the static call summary plus a
 * live progress suffix (elapsed time, last activity, last output line) that
 * updates while the run is in flight via the progress tracker.
 */
export class ProgressLineComponent {
	constructor(
		private readonly makeBase: (progress: LiveProgress | undefined) => string,
		private readonly toolCallId: string,
	) {}

	invalidate(): void {
		// Progress is pulled on every render from the live-progress tracker.
	}

	render(width: number): string[] {
		const progress = getProgress(this.toolCallId);
		const base = this.makeBase(progress);
		if (progress === undefined) return [clip(base, width)];
		const suffix = formatProgress(progress);
		const separator = " · ";
		const baseWidth = Math.max(
			4,
			width - visibleLength(suffix) - visibleLength(separator),
		);
		return [clip(`${clip(base, baseWidth)}${separator}${suffix}`, width)];
	}
}

export function subagentNumberSuffix(progress: LiveProgress | undefined): string {
	const ordinals = progress?.sessionOrdinals ??
		(progress?.sessionOrdinal === undefined ? [] : [progress.sessionOrdinal]);
	if (ordinals.length === 0) return "";
	if (ordinals.length === 1) return ` #${ordinals[0]}`;
	const sorted = [...ordinals].sort((a, b) => a - b);
	const consecutive = sorted.every(
		(value, index) => index === 0 || value === sorted[index - 1]! + 1,
	);
	return consecutive
		? ` #${sorted[0]}–#${sorted.at(-1)}`
		: ` ${sorted.map((value) => `#${value}`).join(",")}`;
}

export function resetWidgetOrdinals(): void {
	nextWidgetOrdinal = 1;
	widgetOrdinals.clear();
}

export function widgetOrdinalFor(toolCallId: string | undefined): number | undefined {
	if (toolCallId === undefined || toolCallId.length === 0) return undefined;
	const existing = widgetOrdinals.get(toolCallId);
	if (existing !== undefined) return existing;
	const ordinal = nextWidgetOrdinal++;
	widgetOrdinals.set(toolCallId, ordinal);
	return ordinal;
}
