import { rename } from "node:fs/promises";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const DEFAULT_RETRIES = 20;
const MAX_RETRY_DELAY_MS = 100;

export interface RenameWithRetryOptions {
	platform?: NodeJS.Platform;
	retries?: number;
	renameFile?: (source: string, destination: string) => Promise<void>;
	wait?: (milliseconds: number) => Promise<void>;
}

function retryableWindowsRename(error: unknown, platform: NodeJS.Platform): boolean {
	return (
		platform === "win32" &&
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		WINDOWS_RENAME_RETRY_CODES.has(error.code)
	);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/**
 * Replace a file by rename, tolerating the brief sharing violations Windows
 * can report while another process is reading the destination.
 */
export async function renameWithRetry(
	source: string,
	destination: string,
	options: RenameWithRetryOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
	const renameFile = options.renameFile ?? rename;
	const wait = options.wait ?? sleep;
	for (let attempt = 0; ; attempt += 1) {
		try {
			await renameFile(source, destination);
			return;
		} catch (error) {
			if (attempt >= retries || !retryableWindowsRename(error, platform))
				throw error;
			const delayMs = Math.min(MAX_RETRY_DELAY_MS, 10 * 2 ** attempt);
			await wait(delayMs);
		}
	}
}
