#!/usr/bin/env node
// Regression coverage: a durable worker must survive an interrupt that arrives
// while it is still booting.
//
// The worker spends roughly a second loading jiti and the plugin before it can
// write a terminal result. Until then it had installed no SIGINT/SIGTERM
// handlers, so the default disposition killed it and the run stayed "running"
// forever: every wait timed out and only a manual reconcile could recover it.
// The worker now captures signals during bootstrap and applies them as soon as
// the cancellation machinery is ready.
//
// Platform note: Windows cannot deliver POSIX signals to a detached worker, so
// an interrupt there is cooperative - the marker file is polled by the worker
// after it boots. Both mechanisms install their handler before the worker starts
// the task, and each case holds the worker in that window with the existing
// start-delay hook, so the only reachable terminal outcome is the cancellation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTree } from "./rm-tree.mjs";
import { startAsyncSubagentRun } from "../../src/orchestrate/async.ts";
import { getSubagentStatus, interruptSubagent } from "../../api.mjs";

// Real dispatches in checks opt out of auxiliary session-title requests.
process.env.PI_DELEGATOR_TITLE = "off";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-delegator-worker-signal-"));
process.env.PI_DELEGATOR_RUN_INDEX_DIR = join(tempRoot, "run-index");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function waitForTerminal(cwd, runId, attemptId, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let snapshot = null;
	while (Date.now() < deadline) {
		snapshot = await getSubagentStatus({ cwd, runId, attemptId });
		if (TERMINAL.has(snapshot?.status)) return snapshot;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`${label}: run stayed ${snapshot?.status ?? "unknown"} for ${timeoutMs}ms: ` +
			JSON.stringify(snapshot),
	);
}

/**
 * Start a detached run, interrupt it while the worker is still in its startup
 * window, and require the run to reach a terminal state.
 */
async function interruptDuringBootstrap(label, options = {}) {
	const cwd = join(tempRoot, `case-${label}`);
	await mkdir(cwd, { recursive: true });
	process.env.PI_DELEGATOR_DURABLE_WORKER_BOOTSTRAP_DELAY_MS =
		String(options.bootstrapDelayMs ?? 0);
	// The worker must not reach its task before the cancellation lands, or it
	// could settle the run by itself and hide what this check is asserting.
	process.env.PI_DELEGATOR_DURABLE_WORKER_START_DELAY_MS = "10000";
	try {
		const started = await startAsyncSubagentRun({
			cwd,
			backend: "inline",
			input: {
				task: `Interrupted during worker bootstrap (${label}).`,
				onComplete: "detach",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, options.interruptAfterMs ?? 300));
		const interrupted = await interruptSubagent({
			cwd,
			runId: started.runId,
			attemptId: started.attemptId,
			reason: `worker signal regression (${label})`,
			// Generous escalation: this asserts bootstrap robustness, not that a
			// slow worker is force-killed within a few hundred milliseconds.
			escalateAfterMs: 200,
			killAfterMs: 20_000,
		});
		assert.notEqual(
			interrupted.status,
			"unsupported",
			`${label}: the worker must be interruptable`,
		);
		const snapshot = await waitForTerminal(
			cwd,
			started.runId,
			started.attemptId,
			options.timeoutMs ?? 25_000,
			label,
		);
		assert.equal(
			snapshot.status,
			"cancelled",
			`${label}: a bootstrap interrupt must cancel the run, got ${snapshot.status}`,
		);
		assert.equal(
			snapshot.failureKind,
			"user_cancelled",
			`${label}: cancellation must be recorded as user_cancelled`,
		);
		return snapshot;
	} finally {
		delete process.env.PI_DELEGATOR_DURABLE_WORKER_BOOTSTRAP_DELAY_MS;
		delete process.env.PI_DELEGATOR_DURABLE_WORKER_START_DELAY_MS;
	}
}

try {
	// No artificial delay: signal lands while jiti and the plugin are loading.
	await interruptDuringBootstrap("immediate", { interruptAfterMs: 50 });

	// The same race with a pinned bootstrap window, so the signal provably
	// arrives before the worker can write a terminal result.
	await interruptDuringBootstrap("pinned-window", {
		bootstrapDelayMs: 2_000,
		interruptAfterMs: 250,
	});

	// Repeat: the window is a race, and a single pass proves little.
	for (const attempt of [1, 2]) {
		await interruptDuringBootstrap(`pinned-window-repeat-${attempt}`, {
			bootstrapDelayMs: 1_000,
			interruptAfterMs: 150,
		});
	}

	console.log(
		JSON.stringify(
			{ name: "check-durable-worker-signals", status: "completed" },
			null,
			2,
		),
	);
} finally {
	await rmTree(tempRoot);
}
