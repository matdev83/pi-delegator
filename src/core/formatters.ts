import { readDelegatorEnv } from "./env.ts";

export function nowMs(): number {
	const raw = readDelegatorEnv("PANEL_NOW_MS");
	if (raw !== undefined && raw.length > 0) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

export function fmtAge(ms: number, now = nowMs()): string {
	const delta = Math.max(0, now - ms);
	if (delta < 1_000) return "now";
	if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function fmtDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function fmtElapsed(startedAt: string, completedAt: string | null): string {
	const start = Date.parse(startedAt);
	const end = completedAt === null ? nowMs() : Date.parse(completedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
	const seconds = Math.max(0, Math.floor((end - start) / 1_000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
