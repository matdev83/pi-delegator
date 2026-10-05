import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	appendRunEvent,
	readRunRecord,
	recordInterruptRequest,
	type RunAttemptRecord,
	type RunRecord,
	type RunRef,
} from "../artifacts/index.ts";
import {
	CANCELLED_FAILURE_KIND,
	commitTerminalAttempt,
	writeTerminalAttemptArtifacts,
} from "./terminal-attempt.ts";
import { resolveRunRef } from "./run-ref.ts";
import { isTerminalStatus } from "./status.ts";

/** Relative default root for durable run artifacts. */
const INTERRUPT_RUNS_DIR = ".pi/agent/runs";

export interface InterruptRunOptions {
	cwd?: string;
	runId: string;
	runsDir?: string;
	attemptId?: string;
	/** @deprecated v1 compatibility alias. */
	taskId?: string;
	reason?: string;
	signal?: NodeJS.Signals;
	escalateAfterMs?: number;
	killAfterMs?: number;
}

export interface InterruptRunResult {
	status:
		| "interrupt-requested"
		| "not-found"
		| "already-terminal"
		| "unsupported";
	runId: string;
	signal: NodeJS.Signals;
	interruptedAttempts: string[];
	unsupportedAttempts: string[];
	/** @deprecated v1 compatibility alias. */
	interruptedTasks: string[];
	/** @deprecated v1 compatibility alias. */
	unsupportedTasks: string[];
	record: RunRecord | null;
}

function sendProcessSignal(
	attempt: RunAttemptRecord,
	signal: NodeJS.Signals,
): boolean {
	const pid = attempt.process?.pid;
	if (pid === undefined) return false;
	if (process.platform === "win32") {
		// Windows: a detached durable worker has no console attached, so
		// SIGINT/SIGTERM cannot be delivered gracefully (they arrive only as an
		// unclean kill and the worker's cancel handler never runs). Graceful
		// interrupts are therefore handled cooperatively through the
		// interrupt-request marker file (see writeInterruptRequestMarker and the
		// durable worker's polling); only SIGKILL is sent here, as a hard kill
		// of the whole process tree.
		if (signal !== "SIGKILL") return false;
		const kill = spawnSync(
			"taskkill",
			["/PID", String(pid), "/T", "/F"],
			{ windowsHide: true, stdio: "ignore" },
		);
		if (kill.status === 0) return true;
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			return false;
		}
	}
	try {
		const target = -(attempt.process?.processGroupId ?? pid);
		process.kill(target, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Write a cooperative cancel marker into the attempt directory so a durable
 * worker that cannot receive OS signals (Windows detached processes) can
 * observe the interrupt request and cancel itself gracefully.
 */
async function writeInterruptRequestMarker(
	ref: RunRef,
	attempt: RunAttemptRecord,
	signal: NodeJS.Signals,
	reason: string | null,
): Promise<void> {
	try {
		const cwd = ref.cwd ?? process.cwd();
		const runsDir = ref.runsDir ?? INTERRUPT_RUNS_DIR;
		const markerPath = join(
			cwd,
			runsDir,
			ref.runId,
			"attempts",
			attempt.attemptId,
			"interrupt-request.json",
		);
		await writeFile(
			markerPath,
			JSON.stringify({
				signal,
				reason,
				requestedAt: new Date().toISOString(),
			}),
			"utf8",
		);
	} catch {
		// Best-effort: on POSIX the OS signal is the primary mechanism.
	}
}

function runningAttempts(
	record: RunRecord,
	targetAttemptId?: string,
): RunAttemptRecord[] {
	return record.attempts.filter((attempt) => {
		if (targetAttemptId !== undefined && attempt.attemptId !== targetAttemptId)
			return false;
		return attempt.status === "running" || attempt.status === "pending";
	});
}

/** Grace period before the interrupt path takes over an unreachable worker. */
const KILL_SETTLE_MS = 150;

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Record the cancellation of an attempt whose worker can no longer write it.
 *
 * A durable worker installs its signal handlers only after Node boots and
 * jiti loads the plugin. A run interrupted inside that window dies before it
 * can write anything, which used to leave the attempt "running" forever: every
 * wait timed out and only a manual reconcile recovered it. Whoever applied the
 * fatal signal therefore owns the terminal write. A worker that reacted in
 * time has already committed, and that result wins untouched.
 */
async function finalizeUnreachableAttempt(
	ref: RunRef,
	attempt: RunAttemptRecord,
	options: InterruptRunOptions,
	signal: NodeJS.Signals,
): Promise<boolean> {
	// Give a worker that is mid-write a moment to land its own result first.
	await new Promise((resolveSleep) => setTimeout(resolveSleep, KILL_SETTLE_MS));
	const record = await readRunRecord(ref).catch(() => null);
	if (record === null || isTerminalStatus(record.status)) return false;
	const current = record.attempts.find(
		(candidate) => candidate.attemptId === attempt.attemptId,
	);
	if (current === undefined) return false;
	if (current.status !== "running" && current.status !== "pending") return false;
	const cwd = current.artifactCwd ?? ref.cwd ?? process.cwd();
	const message =
		`run interrupted (${options.reason ?? "no reason given"}); worker was ` +
		`stopped by ${signal} before it could report a result`;
	const result = await writeTerminalAttemptArtifacts({
		cwd,
		runId: ref.runId,
		attemptId: current.attemptId,
		runsDir: ref.runsDir,
		status: "cancelled",
		failureKind: CANCELLED_FAILURE_KIND,
		backend: current.backend,
		startedAt: current.startedAt,
		correlationId: record.correlationId,
		signal,
		message,
	});
	return await commitTerminalAttempt(ref, result, message);
}

async function escalate(
	options: InterruptRunOptions,
	signal: NodeJS.Signals,
): Promise<void> {
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref).catch(() => null);
	if (record === null || isTerminalStatus(record.status)) return;
	const signalled: RunAttemptRecord[] = [];
	for (const attempt of runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	)) {
		if (process.platform === "win32" && signal !== "SIGKILL") {
			await writeInterruptRequestMarker(
				ref,
				attempt,
				signal,
				options.reason ?? null,
			);
			continue;
		}
		sendProcessSignal(attempt, signal);
		signalled.push(attempt);
	}
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: record.status,
		message: `interrupt escalation ${signal}`,
		data: { signal },
	}).catch(() => undefined);
	// SIGKILL cannot be handled, and a worker that is already gone will never
	// report anything, so the run has to be settled by whoever escalated.
	for (const attempt of signalled) {
		if (signal !== "SIGKILL" && processAlive(attempt.process?.pid)) continue;
		await finalizeUnreachableAttempt(ref, attempt, options, signal).catch(
			() => undefined,
		);
	}
}

function result(
	status: InterruptRunResult["status"],
	runId: string,
	signal: NodeJS.Signals,
	interruptedAttempts: string[],
	unsupportedAttempts: string[],
	record: RunRecord | null,
): InterruptRunResult {
	return {
		status,
		runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		interruptedTasks: interruptedAttempts,
		unsupportedTasks: unsupportedAttempts,
		record,
	};
}

export async function interruptRun(
	options: InterruptRunOptions,
): Promise<InterruptRunResult> {
	const signal = options.signal ?? "SIGINT";
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null) {
		return result("not-found", options.runId, signal, [], [], null);
	}
	if (isTerminalStatus(record.status)) {
		return result("already-terminal", options.runId, signal, [], [], record);
	}

	const candidates = runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	);
	const interruptedAttempts: string[] = [];
	const unsupportedAttempts: string[] = [];
	for (const attempt of candidates) {
		if (process.platform === "win32" && signal !== "SIGKILL") {
			await writeInterruptRequestMarker(
				ref,
				attempt,
				signal,
				options.reason ?? null,
			);
			interruptedAttempts.push(attempt.attemptId);
			continue;
		}
		if (sendProcessSignal(attempt, signal))
			interruptedAttempts.push(attempt.attemptId);
		else unsupportedAttempts.push(attempt.attemptId);
	}

	if (interruptedAttempts.length === 0) {
		await appendRunEvent(ref, {
			type: "run.interrupt_requested",
			status: record.status,
			message: "interrupt unsupported: no interruptable process metadata",
			data: { signal, unsupportedAttempts },
		});
		return result(
			"unsupported",
			options.runId,
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			record,
		);
	}

	const updated = await recordInterruptRequest(
		ref,
		signal,
		options.reason ?? null,
	);
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: updated.status,
		message: `interrupt requested with ${signal}`,
		data: {
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			reason: options.reason ?? null,
		},
	});

	const termDelay = options.escalateAfterMs ?? 1_000;
	const killDelay = options.killAfterMs ?? 3_000;
	setTimeout(() => void escalate(ref, "SIGTERM"), termDelay).unref?.();
	setTimeout(() => void escalate(ref, "SIGKILL"), killDelay).unref?.();

	return result(
		"interrupt-requested",
		options.runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		updated,
	);
}
