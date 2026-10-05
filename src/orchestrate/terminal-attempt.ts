import {
	appendRunEvent,
	commitAttemptResultIfActive,
	createAttemptArtifactStore,
	type ResultEnvelope,
	type RunRef,
} from "../artifacts/index.ts";
import type { FailureKind, ResolvedBackend } from "../core/constants.ts";

// Shared terminal-write helper for subagent attempts that stopped early.
//
// A terminal attempt can be written by whoever stopped the worker: the durable
// worker itself when it reacts to a signal, or the interrupt path when the
// worker was killed before it could react. Both must produce the same envelope
// shape and the same event trail, so that logic lives here once.

export const CANCELLED_FAILURE_KIND: FailureKind = "user_cancelled";

/** Statuses an early-stopped attempt can settle on. */
export type TerminalAttemptStatus = "cancelled" | "failed";

export interface TerminalAttemptInput {
	cwd: string;
	runId: string;
	attemptId: string;
	runsDir?: string;
	status: TerminalAttemptStatus;
	failureKind?: FailureKind | null;
	backend?: ResolvedBackend;
	startedAt?: string;
	completedAt?: string;
	correlationId?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	sandbox?: boolean;
	/** Human-readable explanation, written to the attempt stderr artifact. */
	message: string;
}

/** Write the stderr/result artifacts of a terminal attempt. */
export async function writeTerminalAttemptArtifacts(
	input: TerminalAttemptInput,
): Promise<ResultEnvelope> {
	const store = await createAttemptArtifactStore({
		cwd: input.cwd,
		runId: input.runId,
		attemptId: input.attemptId,
		runsDir: input.runsDir,
	});
	const stderr = await store.writeTextArtifact("stderr", `${input.message}\n`);
	return await store.writeResult({
		backend: input.backend ?? "inline",
		status: input.status,
		failureKind: input.failureKind ?? null,
		cwd: input.cwd,
		startedAt: input.startedAt ?? new Date().toISOString(),
		completedAt: input.completedAt ?? new Date().toISOString(),
		workspace: { mode: "shared", cwd: input.cwd },
		sandbox: { enabled: input.sandbox === true },
		exitCode: input.exitCode ?? null,
		signal: input.signal ?? null,
		artifacts: [store.refFor("worker"), stderr],
		...(input.correlationId === undefined
			? {}
			: { correlationId: input.correlationId }),
		metadata: { contextLengthExceeded: false },
	});
}

/**
 * Commit a terminal envelope when the attempt is still the active one and
 * announce it. Returns false when something else already settled the attempt,
 * in which case that result wins untouched.
 */
export async function commitTerminalAttempt(
	ref: RunRef,
	result: ResultEnvelope,
	attemptMessage: string,
): Promise<boolean> {
	const committed = await commitAttemptResultIfActive(ref, result);
	if (!committed.committed) return false;
	const status: TerminalAttemptStatus =
		result.status === "cancelled" ? "cancelled" : "failed";
	const data = {
		failureKind: result.failureKind,
		signal: result.signal,
		exitCode: result.exitCode,
	};
	await appendRunEvent(ref, {
		type: `attempt.${status}`,
		attemptId: result.attemptId,
		status,
		message: attemptMessage,
		data,
	}).catch(() => undefined);
	await appendRunEvent(ref, {
		type: `run.${status}`,
		status,
		message: `run ${status}`,
		data,
	}).catch(() => undefined);
	return true;
}
