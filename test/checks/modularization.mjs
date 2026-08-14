#!/usr/bin/env node
import assert from "node:assert/strict";
import { isEscapeKey, isArrowKey } from "../../src/core/keyboard.ts";
import { fmtAge, fmtDuration, fmtElapsed } from "../../src/core/formatters.ts";
import { PiJsonStreamParser } from "../../src/runners/stream-parser.ts";

console.log("Running modularization checks...");

// Test Keyboard utilities
assert.equal(isEscapeKey("\u001b"), true, "Escape character should be identified");
assert.equal(isEscapeKey("escape"), true, "escape string should be identified");
assert.equal(isEscapeKey("abc"), false, "Non-escape should be false");

assert.equal(isArrowKey("up", "up"), true, "up arrow key matched");
assert.equal(isArrowKey("\u001b[A", "up"), true, "legacy up arrow key matched");
assert.equal(isArrowKey("down", "up"), false, "non-matching arrow key should be false");

// Test Formatters
assert.equal(fmtAge(Date.now() - 5000, Date.now()), "5s ago", "fmtAge formats seconds");
assert.equal(fmtDuration(12500), "12s", "fmtDuration formats duration in seconds");
assert.equal(fmtElapsed(new Date(1000).toISOString(), new Date(5000).toISOString()), "00:04", "fmtElapsed computes elapsed time");

// Test Stream Parser
const parser = new PiJsonStreamParser();
parser.push('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}]}}\n');
assert.equal(parser.parsed.finalAssistantText, "hello world", "PiJsonStreamParser parses assistant message end event");

console.log("Modularization checks passed!");
