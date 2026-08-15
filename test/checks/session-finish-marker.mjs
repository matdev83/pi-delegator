#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	DEFAULT_RECOVERY_GRACE_SECONDS,
	DEFAULT_RECOVERY_INACTIVITY_SECONDS,
} from "../../src/core/constants.ts";
import {
	normalizeRecoveryInactivityTimeoutMs,
	createRecoverableWatchdog,
} from "../../src/runners/inactivity.ts";
import {
	SESSION_FINISH_MARKER,
	SESSION_FINISH_PROMPT,
	matchesSessionFinishMarker,
	normalizeMarkerText,
} from "../../src/runners/session-finish-marker.ts";

assert.equal(DEFAULT_RECOVERY_INACTIVITY_SECONDS, 5 * 60);
assert.equal(DEFAULT_RECOVERY_GRACE_SECONDS, 3 * 60);

// The probe prompt carries the marker sentence it asks for.
assert.ok(SESSION_FINISH_MARKER.length > 0);
assert.ok(
	SESSION_FINISH_PROMPT.includes(SESSION_FINISH_MARKER),
	"recovery probe prompt must reference the finish marker",
);

// Normalization: case-insensitive, punctuation/whitespace-tolerant.
assert.equal(
	normalizeMarkerText('"I have FULLY finished, all tasks from this session!!"'),
	"I HAVE FULLY FINISHED ALL TASKS FROM THIS SESSION",
);

const markerCases = [
	["exact marker", SESSION_FINISH_MARKER, true],
	["exact marker, lowercase", SESSION_FINISH_MARKER.toLowerCase(), true],
	["marker with punctuation", "I have fully finished all tasks from this session!", true],
	["marker across lines", "I have fully finished\nall tasks from\nthis session.", true],
	["marker inside reply", `Sure.\n${SESSION_FINISH_MARKER}\nGoodbye.`, true],
	["quoted marker", `"${SESSION_FINISH_MARKER}."`, true],
	["keyword combo", "Fully finished. All tasks from this session are done.", true],
	["finished-all-tasks phrase", "I have finished all tasks from this session.", true],
	["no remaining tasks", "There are no remaining tasks in this session.", true],
	["no more tasks", "No more tasks to execute.", true],
	["all tasks complete", "All tasks complete.", true],
	["all tasks completed", "All tasks completed now.", true],
	["all tasks done", "All tasks done.", true],
];
for (const [name, input, expected] of markerCases) {
	assert.equal(
		matchesSessionFinishMarker(input),
		expected,
		`marker match: ${name}`,
	);
}

const nearMissCases = [
	["empty", "", false],
	["whitespace only", "   \n  ", false],
	["unrelated text", "I am still working on the feature.", false],
	["partial phrase", "I have fully finished.", false],
	["wrong session wording", "I have fully finished all tasks from this project.", false],
	["finished some", "I have finished some tasks in this session.", false],
	["starting work", "I will now finish all tasks from this session.", false],
];
for (const [name, input, expected] of nearMissCases) {
	assert.equal(
		matchesSessionFinishMarker(input),
		expected,
		`marker near-miss: ${name}`,
	);
}

// Normalization defaults and opt-out.
assert.equal(normalizeRecoveryInactivityTimeoutMs(undefined), 300_000);
assert.equal(normalizeRecoveryInactivityTimeoutMs(0), 0);
assert.equal(normalizeRecoveryInactivityTimeoutMs(90_000), 90_000);
assert.throws(() => normalizeRecoveryInactivityTimeoutMs(-1));

// Recoverable watchdog: fires, can be re-armed, and fires again.
await new Promise((resolve) => {
	let firings = 0;
	const watchdog = createRecoverableWatchdog(20, () => {
		firings += 1;
		if (firings === 1) {
			setTimeout(() => watchdog.rearm(), 5);
		} else {
			watchdog.dispose();
			assert.equal(firings, 2, "watchdog fires once per silent window");
			resolve();
		}
	});
	setTimeout(() => watchdog.touch(), 10);
});

// Touch re-arms the watchdog: with 15ms delay and touches at 8ms and 16ms,
// the earliest legal fire is 23ms after start (8ms + 15ms), never at 15ms.
await new Promise((resolve) => {
	const start = Date.now();
	let firstFireAt = 0;
	const watchdog = createRecoverableWatchdog(15, () => {
		if (firstFireAt === 0) firstFireAt = Date.now();
	});
	setTimeout(() => watchdog.touch(), 8);
	setTimeout(() => watchdog.touch(), 16);
	setTimeout(() => {
		watchdog.dispose();
		if (firstFireAt === 0) {
			resolve();
			return;
		}
		assert.ok(
			firstFireAt - start >= 20,
			"touching re-arms the watchdog (fire must be at least 20ms in)",
		);
		resolve();
	}, 24);
});

console.log(
	JSON.stringify(
		{
			name: "check-session-finish-marker",
			status: "completed",
			markerCases: markerCases.length,
			nearMissCases: nearMissCases.length,
		},
		null,
		2,
	),
);
