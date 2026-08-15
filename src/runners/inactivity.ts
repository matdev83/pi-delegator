import {
	DEFAULT_INACTIVITY_TIMEOUT_SECONDS,
	DEFAULT_RECOVERY_INACTIVITY_SECONDS,
} from "../core/constants.ts";

export const DEFAULT_INACTIVITY_TIMEOUT_MS =
	DEFAULT_INACTIVITY_TIMEOUT_SECONDS * 1000;
export const DEFAULT_RECOVERY_INACTIVITY_TIMEOUT_MS =
	DEFAULT_RECOVERY_INACTIVITY_SECONDS * 1000;

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

export function normalizeRecoveryInactivityTimeoutMs(
	timeoutMs: number | undefined,
): number {
	if (timeoutMs === undefined) return DEFAULT_RECOVERY_INACTIVITY_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error(
			"recoveryInactivityTimeoutMs must be a non-negative finite number when provided.",
		);
	}
	return timeoutMs;
}

export interface InactivityWatchdog {
	touch(): void;
	dispose(): void;
}

export interface RecoverableWatchdog extends InactivityWatchdog {
	rearm(): void;
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

/**
 * Re-armable watchdog: fires once per silent period, then keeps monitoring.
 * Used by the inline backend's inactivity recovery probe so a session that
 * resumes operations can be probed again after the next silent window.
 */
export function createRecoverableWatchdog(
	timeoutMs: number,
	onTimeout: () => void,
): RecoverableWatchdog {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	function arm(): void {
		if (timeoutMs <= 0 || disposed) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (disposed) return;
			onTimeout();
		}, timeoutMs);
	}

	arm();
	return {
		touch(): void {
			arm();
		},
		rearm(): void {
			arm();
		},
		dispose(): void {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
