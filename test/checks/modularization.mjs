#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isEscapeKey, isArrowKey } from "../../src/core/keyboard.ts";
import { fmtAge, fmtDuration, fmtElapsed } from "../../src/core/formatters.ts";
import { PiJsonStreamParser } from "../../src/runners/stream-parser.ts";

console.log("Running modularization checks...");

// ---- 1. Shared keyboard utilities (de-duplicated from watch.ts/panel.ts) ----

// Test Keyboard utilities
assert.equal(isEscapeKey("\u001b"), true, "Escape character should be identified");
assert.equal(isEscapeKey("escape"), true, "escape string should be identified");
assert.equal(isEscapeKey("abc"), false, "Non-escape should be false");

assert.equal(isArrowKey("up", "up"), true, "up arrow key matched");
assert.equal(isArrowKey("\u001b[A", "up"), true, "legacy up arrow key matched");
assert.equal(isArrowKey("down", "up"), false, "non-matching arrow key should be false");

// ---- 2. Shared formatters ----

// Test Formatters
assert.equal(fmtAge(Date.now() - 5000, Date.now()), "5s ago", "fmtAge formats seconds");
assert.equal(fmtDuration(12500), "12s", "fmtDuration formats duration in seconds");
assert.equal(fmtElapsed(new Date(1000).toISOString(), new Date(5000).toISOString()), "00:04", "fmtElapsed computes elapsed time");

// ---- 3. Stream parser ----

// Test Stream Parser
const parser = new PiJsonStreamParser();
parser.push('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}]}}\n');
assert.equal(parser.parsed.finalAssistantText, "hello world", "PiJsonStreamParser parses assistant message end event");

// Deeply nested usage objects come from untrusted child-process stdout and
// must not overflow the stack when accumulated (livePayloadChars bounds depth
// the same way; a RangeError here would escape parser.push entirely).
const deepNestedUsage = '{"a":'.repeat(10000) + "1" + "}".repeat(10000);
const deepParser = new PiJsonStreamParser();
deepParser.push(
	`{"type":"message_end","message":{"role":"assistant","content":[],"usage":${deepNestedUsage}}}\n`,
);
assert.equal(
	typeof deepParser.parsed.metadata.usage,
	"object",
	"deep usage accumulates without stack overflow",
);

// ---- 4. Presumptive blockers: file-size limits ----
// The thermonuclear review blocks any PR that keeps the decomposed entry
// points over 1,000 lines (index.ts is stricter: pure extension bootstrap).
const fileLimits = [
	["src/index.ts", 400],
	["src/panel.ts", 1000],
	["src/watch.ts", 1000],
	["src/runners/headless-model.ts", 1000],
];
for (const [rel, limit] of fileLimits) {
	const src = await readFile(new URL(`../../${rel}`, import.meta.url), "utf8");
	const lines = src.split("\n").length;
	assert.ok(
		lines <= limit,
		`${rel} is ${lines} lines; modularization limit is ${limit}`,
	);
}

// ---- 5. Presumptive blocker: no duplicate helper definitions ----
// Shared key mapping and text formatting live in src/core/ only. watch.ts and
// panel.ts must import them, never re-define them.
const sharedHelpers = [
	"isEscapeKey",
	"isArrowKey",
	"isTabKey",
	"isPageKey",
	"isEnterKey",
	"fmtAge",
	"fmtDuration",
	"fmtElapsed",
];
for (const rel of ["src/panel.ts", "src/watch.ts"]) {
	const src = await readFile(new URL(`../../${rel}`, import.meta.url), "utf8");
	for (const helper of sharedHelpers) {
		assert.ok(
			!src.includes(`function ${helper}`),
			`${rel} re-defines ${helper}; import it from src/core/keyboard.ts or src/core/formatters.ts instead`,
		);
	}
}

// ---- 6. Module contracts: extraction targets stay the home of the logic ----
// Each decomposed entry point must delegate to the module the review plan
// extracted. If an implementation is inlined back into an entry point, this
// contract fails and forces a new extraction instead of file sprawl.
// Imports are parsed from import declarations so comments or string literals
// cannot satisfy the contract.
function importSpecifiers(source) {
	const specifiers = [];
	for (const match of source.matchAll(
		/import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
	)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

const contracts = [
	["src/index.ts", ["./core/components.ts", "./orchestrate/tool-executor.ts"]],
	[
		"src/panel.ts",
		[
			"./core/keyboard.ts",
			"./core/formatters.ts",
			"./orchestrate/runs-loader.ts",
		],
	],
	["src/runners/headless-model.ts", ["./argv-builder.ts", "./stream-parser.ts"]],
];
for (const [rel, deps] of contracts) {
	const src = await readFile(new URL(`../../${rel}`, import.meta.url), "utf8");
	const specifiers = importSpecifiers(src);
	for (const dep of deps) {
		assert.ok(
			specifiers.includes(dep),
			`${rel} must import ${dep} (module contract for decomposition)`,
		);
	}
}

console.log("Modularization checks passed!");
