#!/usr/bin/env node
// Contract checks for automatic, human-readable subagent session titles.
//
// Titles are an auxiliary, best-effort annotation: a title must never change a
// dispatch outcome, and every failure path (disabled config, unknown model,
// provider error, timeout, unusable response, unwritable registry) must degrade
// to the six-word dispatch proxy instead of surfacing an error.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import {
	DEFAULT_TITLE_MODEL,
	DEFAULT_TITLE_TIMEOUT_MS,
	FALLBACK_TITLE_WORDS,
	MAX_TITLE_TIMEOUT_MS,
	MIN_TITLE_TIMEOUT_MS,
	abortPendingSessionTitles,
	dispatchFallbackTitle,
	generateSessionTitle,
	normalizeGeneratedTitle,
	resolveSessionTitleSettings,
	scheduleSessionTitle,
} from "../../src/orchestrate/session-title.ts";
import {
	beginRunRecord,
	readRunEvents,
	readRunRecord,
	setRunTitle,
} from "../../src/artifacts/index.ts";


const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});

// lifecycle.ts pulls in the TUI modules, which use non-erasable TypeScript
// syntax, so it has to be transpiled rather than strip-loaded.
const lifecycle = await jiti.import(resolve("src/orchestrate/lifecycle.ts"));

const tempRoot = await mkdtemp(join(tmpdir(), "pi-delegator-titles-"));
const INDEX_DIR = join(tempRoot, "run-index");
const previousIndexDir = process.env.PI_DELEGATOR_RUN_INDEX_DIR;
process.env.PI_DELEGATOR_RUN_INDEX_DIR = INDEX_DIR;

let runCounter = 0;
async function seedRun(options = {}) {
	const cwd = options.cwd ?? join(tempRoot, "workspace");
	const runId = options.runId ?? `run_title_${(runCounter += 1)}`;
	const attemptId = options.attemptId ?? `attempt_${runCounter}`;
	await mkdir(cwd, { recursive: true });
	await beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: "inline",
		startedAt: new Date(),
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: "inline",
				startedAt: new Date().toISOString(),
			},
		],
	});
	return { cwd, runId, attemptId, ref: { cwd, runId } };
}

try {
	// ---- 1. Configuration ------------------------------------------------
	const defaults = resolveSessionTitleSettings({});
	assert.equal(defaults.enabled, true, "auto titles are enabled by default");
	assert.equal(
		defaults.model,
		DEFAULT_TITLE_MODEL,
		"default title model is the free-model router",
	);
	assert.equal(
		defaults.model,
		"openrouter/free",
		"documented default model id",
	);
	assert.equal(
		defaults.timeoutMs,
		DEFAULT_TITLE_TIMEOUT_MS,
		"default title timeout",
	);

	for (const value of ["off", "false", "0", "no", "disabled"]) {
		assert.equal(
			resolveSessionTitleSettings({ PI_DELEGATOR_TITLE: value }).enabled,
			false,
			`PI_DELEGATOR_TITLE=${value} disables title generation`,
		);
	}
	for (const value of ["on", "true", "1", "yes", "enabled"]) {
		assert.equal(
			resolveSessionTitleSettings({ PI_DELEGATOR_TITLE: value }).enabled,
			true,
			`PI_DELEGATOR_TITLE=${value} enables title generation`,
		);
	}
	assert.equal(
		resolveSessionTitleSettings({ PI_DELEGATOR_TITLE: "perhaps" }).enabled,
		true,
		"unrecognized toggle values fall back to the default",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_SUBAGENT_TITLE: "off" }).enabled,
		false,
		"legacy PI_SUBAGENT_* alias is honored",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_SUBAGENT_TITLE_MODEL: "openai/gpt-5" })
			.model,
		"openai/gpt-5",
		"legacy model alias is honored",
	);
	assert.equal(
		resolveSessionTitleSettings({
			PI_SUBAGENT_TITLE_MODEL: "legacy/model",
			PI_DELEGATOR_TITLE_MODEL: "openai/gpt-5",
		}).model,
		"openai/gpt-5",
		"PI_DELEGATOR_* wins over the legacy alias",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_DELEGATOR_TITLE_MODEL: "  " }).model,
		DEFAULT_TITLE_MODEL,
		"blank model values fall back to the default",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_DELEGATOR_TITLE_TIMEOUT_MS: "2500" })
			.timeoutMs,
		2500,
		"explicit timeouts are honored",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_DELEGATOR_TITLE_TIMEOUT_MS: "abc" })
			.timeoutMs,
		DEFAULT_TITLE_TIMEOUT_MS,
		"non-numeric timeouts fall back to the default",
	);
	assert.equal(
		resolveSessionTitleSettings({ PI_DELEGATOR_TITLE_TIMEOUT_MS: "1" })
			.timeoutMs,
		MIN_TITLE_TIMEOUT_MS,
		"timeouts clamp to the minimum",
	);
	assert.equal(
		resolveSessionTitleSettings({
			PI_DELEGATOR_TITLE_TIMEOUT_MS: String(MAX_TITLE_TIMEOUT_MS * 10),
		}).timeoutMs,
		MAX_TITLE_TIMEOUT_MS,
		"timeouts clamp to the maximum",
	);

	// ---- 2. Failover title (first six dispatch words) --------------------
	assert.equal(FALLBACK_TITLE_WORDS, 6, "failover uses the first six words");
	assert.equal(
		dispatchFallbackTitle(
			"Refactor the auth module so tokens refresh automatically",
		),
		"Refactor the auth module so tokens",
		"failover truncates to six words",
	);
	assert.equal(
		dispatchFallbackTitle("  one   two\tthree\nfour five six seven "),
		"one two three four five six",
		"failover collapses whitespace before truncating",
	);
	assert.equal(dispatchFallbackTitle("   "), "", "empty dispatch has no proxy");
	assert.equal(dispatchFallbackTitle(undefined), "", "missing dispatch has no proxy");

	// ---- 3. Model output normalization ----------------------------------
	assert.equal(
		normalizeGeneratedTitle('"Refactor auth token refresh"'),
		"Refactor auth token refresh",
		"wrapping quotes are stripped",
	);
	assert.equal(
		normalizeGeneratedTitle("**Refactor auth** tokens"),
		"Refactor auth tokens",
		"markdown emphasis is stripped",
	);
	assert.equal(
		normalizeGeneratedTitle("Title: Refactor auth tokens"),
		"Refactor auth tokens",
		"label prefixes are stripped",
	);
	assert.equal(
		normalizeGeneratedTitle("Refactor auth tokens\n\nExtra commentary here"),
		"Refactor auth tokens",
		"only the first line is kept",
	);
	assert.equal(
		normalizeGeneratedTitle("one two three four five six seven eight"),
		"one two three four five six",
		"titles longer than six words are truncated",
	);
	assert.equal(normalizeGeneratedTitle("   "), null, "blank output is unusable");
	assert.equal(normalizeGeneratedTitle(""), null, "empty output is unusable");
	assert.equal(
		normalizeGeneratedTitle("x".repeat(500))?.length,
		60,
		"single long words are clipped",
	);

	// ---- 4. Generation is fail-open -------------------------------------
	const generated = await generateSessionTitle({
		dispatch: "Refactor the auth module so tokens refresh automatically",
		model: DEFAULT_TITLE_MODEL,
		timeoutMs: 1_000,
		generate: async () => '"Refactor auth token refresh"',
	});
	assert.equal(generated.source, "model", "valid model output is used");
	assert.equal(generated.title, "Refactor auth token refresh");

	let requestedModel;
	let requestedSignal;
	const failing = await generateSessionTitle({
		dispatch: "Refactor the auth module so tokens refresh automatically",
		model: "openrouter/free",
		timeoutMs: 1_000,
		generate: async (request) => {
			requestedModel = request.model;
			requestedSignal = request.signal;
			throw new Error("provider unavailable");
		},
	});
	assert.equal(failing.source, "dispatch", "generator errors fall back");
	assert.equal(
		failing.title,
		"Refactor the auth module so tokens",
		"failover title is the six-word dispatch proxy",
	);
	assert.equal(requestedModel, "openrouter/free", "generator receives the model");
	assert.equal(requestedSignal?.aborted, false, "generator receives a live signal");

	const blankResponse = await generateSessionTitle({
		dispatch: "Add caching to the resolver layer",
		model: DEFAULT_TITLE_MODEL,
		timeoutMs: 1_000,
		generate: async () => "   ",
	});
	assert.equal(blankResponse.source, "dispatch", "unusable responses fall back");
	assert.equal(
		blankResponse.title,
		"Add caching to the resolver layer",
		"blank output yields the dispatch proxy",
	);

	let timeoutSignal;
	const started = Date.now();
	const timedOut = await generateSessionTitle({
		dispatch: "Investigate the flaky integration suite failure",
		model: DEFAULT_TITLE_MODEL,
		timeoutMs: 30,
		generate: ({ signal }) => {
			timeoutSignal = signal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});
		},
	});
	assert.equal(timedOut.source, "dispatch", "timeouts fall back");
	assert.equal(
		timedOut.title,
		"Investigate the flaky integration suite failure",
		"timeout yields the dispatch proxy",
	);
	assert.ok(
		Date.now() - started < 5_000,
		"timeout does not wait for the model call to settle",
	);
	assert.equal(
		timeoutSignal?.aborted,
		true,
		"the generator signal is aborted on timeout",
	);

	// ---- 5. Registry title persistence ----------------------------------
	const titled = await seedRun();
	const record = await setRunTitle({
		...titled.ref,
		title: "Refactor auth token refresh",
		source: "model",
		model: DEFAULT_TITLE_MODEL,
	});
	assert.equal(record.title, "Refactor auth token refresh", "title is stored");
	assert.equal(record.titleSource, "model", "title source is stored");
	assert.equal(record.titleModel, DEFAULT_TITLE_MODEL, "title model is stored");
	assert.equal(record.runId, titled.runId, "title writes preserve the run id");
	assert.equal(record.status, "running", "title writes preserve run status");
	assert.equal(
		record.attempts.length,
		1,
		"title writes preserve attempts",
	);
	const titledEvents = await readRunEvents({ ...titled.ref }, 50);
	const titledEvent = titledEvents.find((event) => event.type === "run.titled");
	assert.ok(titledEvent, "run.titled event is appended");
	assert.equal(titledEvent.data?.title, "Refactor auth token refresh");
	assert.equal(titledEvent.data?.source, "model");
	assert.equal(
		(await readRunRecord({ ...titled.ref }))?.title,
		"Refactor auth token refresh",
		"the title survives a reload",
	);
	const upgraded = await setRunTitle({
		...titled.ref,
		title: "Refactor auth tokens",
		source: "model",
		model: DEFAULT_TITLE_MODEL,
	});
	assert.equal(
		upgraded.title,
		"Refactor auth tokens",
		"a later title replaces an earlier one",
	);
	await assert.rejects(
		() => setRunTitle({ ...titled.ref, title: "   ", source: "dispatch" }),
		/must not be blank/,
		"blank titles are rejected",
	);

	// ---- 6. Scheduling is background and fail-open ----------------------
	const disabledRun = await seedRun();
	const disabled = await scheduleSessionTitle({
		ref: disabledRun.ref,
		dispatch: "Fix the flaky snapshot test",
		env: { PI_DELEGATOR_TITLE: "off" },
		generate: async () => {
			throw new Error("generator must not run when titles are disabled");
		},
	});
	assert.equal(disabled, null, "disabled configuration skips title generation");
	assert.equal(
		(await readRunRecord({ ...disabledRun.ref }))?.title,
		undefined,
		"disabled configuration writes no title",
	);

	const emptyRun = await seedRun();
	assert.equal(
		await scheduleSessionTitle({
			ref: emptyRun.ref,
			dispatch: "   ",
			generate: async () => "should not run",
		}),
		null,
		"a dispatch without task text has nothing to title",
	);

	const modelRun = await seedRun();
	const modelOutcome = await scheduleSessionTitle({
		ref: modelRun.ref,
		dispatch: "Refactor the auth module so tokens refresh automatically",
		generate: async () => '"Refactor auth token refresh"',
	});
	assert.equal(modelOutcome?.source, "model", "model titles are recorded");
	const modelRecord = await readRunRecord({ ...modelRun.ref });
	assert.equal(modelRecord?.title, "Refactor auth token refresh");
	assert.equal(modelRecord?.titleSource, "model");
	assert.equal(
		modelRecord?.titleModel,
		DEFAULT_TITLE_MODEL,
		"the configured model is recorded with the title",
	);

	const failedRun = await seedRun();
	const failedOutcome = await scheduleSessionTitle({
		ref: failedRun.ref,
		dispatch: "Refactor the auth module so tokens refresh automatically",
		generate: async () => {
			throw new Error("no credentials configured");
		},
	});
	assert.equal(
		failedOutcome?.source,
		"dispatch",
		"generator failures fail open to the dispatch proxy",
	);
	const failedRecord = await readRunRecord({ ...failedRun.ref });
	assert.equal(failedRecord?.title, "Refactor the auth module so tokens");
	assert.equal(failedRecord?.titleSource, "dispatch");
	assert.equal(
		failedRecord?.status,
		"running",
		"a failed title generation leaves the run untouched",
	);

	const missingRun = await seedRun();
	const missingOutcome = await scheduleSessionTitle({
		ref: { ...missingRun.ref, runId: "run_title_absent" },
		dispatch: "Generate a title for a run that vanished",
		generate: async () => "Vanished run title",
	});
	assert.equal(
		missingOutcome?.source,
		"model",
		"an unwritable registry still resolves an outcome",
	);

	// Background: the title lands after the dispatch continues, so a slow or
	// stuck model can never delay a subagent launch.
	const slowRun = await seedRun();
	let releaseSlow;
	const slowGate = new Promise((resolveGate) => {
		releaseSlow = resolveGate;
	});
	let slowSettled = false;
	const scheduled = scheduleSessionTitle({
		ref: slowRun.ref,
		dispatch: "Write the migration guide for the new schema",
		generate: async () => {
			await slowGate;
			return "Document new schema migration";
		},
	}).then((outcome) => {
			slowSettled = true;
			return outcome;
	});
	assert.equal(slowSettled, false, "scheduling does not block the caller");
	assert.equal(
		(await readRunRecord({ ...slowRun.ref }))?.title,
		undefined,
		"the title is not written before the model answers",
	);
	releaseSlow();
	assert.equal(
		(await scheduled)?.title,
		"Document new schema migration",
		"the background title lands once the model answers",
	);
	assert.equal(
		(await readRunRecord({ ...slowRun.ref }))?.title,
		"Document new schema migration",
	);

	abortPendingSessionTitles();

	// ---- 7. Dispatch paths schedule titles in the background -----------
	for (const rel of [
		"src/orchestrate/run.ts",
		"src/orchestrate/async.ts",
	]) {
		const source = await import("node:fs/promises").then(({ readFile }) =>
			readFile(resolve(rel), "utf8"),
		);
		assert.ok(
			source.includes('from "./session-title.ts"'),
			`${rel} must import the session title module`,
		);
		assert.ok(
			source.includes("void scheduleSessionTitle("),
			`${rel} must schedule titles without awaiting them`,
		);
	}

	// ---- 8. UI plumbing: runs listing carries the title ------------------
	const listedCwd = join(tempRoot, "listed");
	await mkdir(join(listedCwd, ".pi/agent/runs/run_listed/attempts/attempt_1"), {
		recursive: true,
	});
	const { writeFile } = await import("node:fs/promises");
	await writeFile(
		join(listedCwd, ".pi/agent/runs/run_listed/run.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId: "run_listed",
			mode: "single",
			status: "running",
			backend: "inline",
			title: "Refactor auth token refresh",
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			completedAt: null,
			latestAttemptId: "attempt_1",
			attempts: [],
		}),
	);
	const listedRuns = await lifecycle.lifecycleAction(
		{ action: "runs", scope: "cwd" },
		listedCwd,
		undefined,
	);
	const listedEntry = JSON.parse(
		listedRuns.content.find((item) => item.type === "text").text,
	).runs[0];
	assert.equal(
		listedEntry.title,
		"Refactor auth token refresh",
		"the runs listing exposes session titles",
	);

	console.log(
		JSON.stringify(
			{ name: "check-session-titles", status: "completed" },
			null,
			2,
		),
	);
} finally {
	abortPendingSessionTitles();
	if (previousIndexDir === undefined)
		delete process.env.PI_DELEGATOR_RUN_INDEX_DIR;
	else process.env.PI_DELEGATOR_RUN_INDEX_DIR = previousIndexDir;
	await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
