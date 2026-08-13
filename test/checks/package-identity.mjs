import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readDelegatorEnv } from "../../src/core/env.ts";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const notice = await readFile("NOTICE.md", "utf8");
const license = await readFile("LICENSE", "utf8");

assert.equal(pkg.name, "pi-delegator");
assert.equal(pkg.version, "0.1.0");
assert.deepEqual(pkg.author, {
	name: "matdev83",
	email: "github@matdev83.anonaddy.com",
});
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages?.[""]?.name, pkg.name);
assert.equal(lock.packages?.[""]?.version, pkg.version);
assert.match(pkg.repository?.url ?? "", /matdev83\/pi-delegator/);
assert.match(pkg.homepage ?? "", /matdev83\/pi-delegator/);
assert.match(pkg.bugs?.url ?? "", /matdev83\/pi-delegator/);
assert.match(notice, /AgwaB\/pi-subagent/);
assert.match(notice, /daa7b83819116a62008ad17aa65fcd50fefbafd0/);
assert.match(license, /Copyright \(c\) 2026 AgwaB/);
assert.match(license, /Copyright \(c\) 2026 matdev83/);

assert.equal(
	readDelegatorEnv("EXAMPLE", {
		PI_DELEGATOR_EXAMPLE: "new-name",
		PI_SUBAGENT_EXAMPLE: "legacy-name",
	}),
	"new-name",
);
assert.equal(
	readDelegatorEnv("EXAMPLE", { PI_SUBAGENT_EXAMPLE: "legacy-name" }),
	"legacy-name",
);

console.log("package identity checks passed");
