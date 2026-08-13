import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [readme, usage, herdr] = await Promise.all([
	readFile("README.md", "utf8"),
	readFile("docs/usage.md", "utf8"),
	readFile("src/runners/herdr.ts", "utf8"),
]);

for (const command of [
	"/subagent enable",
	"/subagent disable",
	"/subagent panel",
	"/subagent watch [1-9]",
	"/subagent kill [runId]",
	"/subagent kill all",
]) {
	assert.match(readme, new RegExp(command.replace(/[()[\]]/g, "\\$&")));
}

assert.match(readme, /pi install git:github\.com\/matdev83\/pi-delegator/);
assert.match(readme, /pi install npm:pi-delegator/);
assert.match(
	readme,
	/powershell -ExecutionPolicy Bypass -c "irm https:\/\/herdr\.dev\/install\.ps1 \| iex"/,
);
assert.match(readme, /herdr --version/);
assert.match(readme, /herdr status/);
assert.match(usage, /pi install git:github\.com\/matdev83\/pi-delegator/);
assert.match(usage, /\/subagent kill \[runId\|all\]/);
assert.match(usage, /herdr status/);
assert.match(herdr, /execFileAsync\("herdr", \["status"\]/);
assert.match(herdr, /timeout: 5000/);
assert.match(herdr, /herdr is not available/);

console.log("documentation checks passed");
