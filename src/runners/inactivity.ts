import { DEFAULT_INACTIVITY_TIMEOUT_SECONDS } from "../core/constants.ts";

export const DEFAULT_INACTIVITY_TIMEOUT_MS =
	DEFAULT_INACTIVITY_TIMEOUT_SECONDS * 1000;

export function normalizeInactivityTimeoutMs(
	timeoutMs: number | undefined,
): number {
	if (timeoutMs === undefined) return DEFAULT_INACTIVITY_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error(
			"inactivityTimeoutMs must be a non-negative finite number when provided.",
		);
	}
	return timeoutMs;
}

export interface InactivityWatchdog {
	touch(): void;
	dispose(): void;
}

/** Resettable watchdog used by foreground runners while they await a worker. */
export function createInactivityWatchdog(
	timeoutMs: number,
	onTimeout: () => void,
): InactivityWatchdog {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	function arm(): void {
		if (timeoutMs <= 0 || disposed) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (disposed) return;
			disposed = true;
			onTimeout();
		}, timeoutMs);
	}

	arm();
	return {
		touch(): void {
			arm();
		},
		dispose(): void {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
