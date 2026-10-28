import assert from "node:assert/strict";
import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { withSandboxedArgv } from "../../src/sandbox/srt.ts";

// Exercise the real upstream schemas: Zod 4 must retain the v3 record API.
const config = {
  network: { allowedDomains: ["api.openai.com"], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: ["/tmp"], denyWrite: [] },
  ignoreViolations: { "*": ["/tmp/cache"] },
  allowPty: false,
};
assert.equal(SandboxRuntimeConfigSchema.safeParse(config).success, true);
assert.equal(SandboxRuntimeConfigSchema.safeParse({ ...config, ignoreViolations: { "*": [123] } }).success, false);
assert.equal(SandboxRuntimeConfigSchema.safeParse({ ...config, network: { allowedDomains: ["*.com"], deniedDomains: [] } }).success, false);
assert.equal(typeof SandboxManager.wrapWithSandboxArgv, "function");

// Stub OS setup only; keep the actual schema and delegator wrapper in use.
const original = { ...SandboxManager };
let initialized = 0;
let cleaned = 0;
Object.assign(SandboxManager, {
  isSupportedPlatform: () => true,
  checkDependencies: () => ({ warnings: [], errors: [] }),
  initialize: async (value) => {
    assert.equal(SandboxRuntimeConfigSchema.safeParse(value).success, true);
    initialized++;
  },
  wrapWithSandboxArgv: async (command) => ({ argv: ["/bin/sh", "-c", command], env: { FIXTURE: "1" } }),
  cleanupAfterCommand: () => {},
  reset: async () => { cleaned++; },
});
try {
  const oversized = Array(1025);
  Object.defineProperty(oversized, 0, { get() { assert.fail("oversized list elements must not be accessed"); } });
  for (const options of [
    { sandbox: { allowedDomains: oversized }, cwd: "/tmp" },
    { sandbox: { allowedDomains: Array(1025).fill("a.com") }, cwd: "/tmp" },
    { sandbox: true, cwd: "a".repeat(4097) },
    { sandbox: true, cwd: "/tmp", writablePaths: Array(1025).fill("/tmp") },
    { sandbox: true, cwd: "/tmp", writablePaths: Array(300).fill("a".repeat(4096)) },
  ]) {
    await assert.rejects(withSandboxedArgv(["/bin/true"], options, () => assert.fail("oversized config ran")), /sandbox configuration/);
  }
  assert.equal(initialized, 0);
  const result = await withSandboxedArgv(["/bin/echo", "quote's\nvalue"], { sandbox: { allowedDomains: ["api.openai.com"] }, cwd: "/tmp" }, async (launch) => {
    assert.equal(launch.env.FIXTURE, "1");
    assert.equal(launch.argv[0], "/bin/sh");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(initialized, 1);
  assert.equal(cleaned, 1);
  console.log("sandbox runtime compatibility and configuration bounds passed");
} finally {
  Object.assign(SandboxManager, original);
}
