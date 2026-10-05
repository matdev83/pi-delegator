#!/usr/bin/env node
// Regression coverage for the default model of a run that names none.
//
// When no `model` is given and the agent profile pins none, the run used to
// fall back to `settings.defaultModel`. Pi 1.0's own session does not honour
// that key, so the value is routinely stale or names a provider registered by an
// extension — which an inline worker's private model runtime cannot
// authenticate against. The SDK then reports the turn as an assistant message
// with no content and the run fails with an unexplained empty result.
//
// A run must instead inherit the model the host Pi session is already using.
// These cases use deliberately unresolvable model references so the assertion is
// hermetic: the run fails at model resolution, before any network call, and the
// error text names whichever model the engine actually selected.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

// These checks dispatch real subagent runs. Automatic session titles would
// issue an auxiliary model request per dispatch, so the feature is switched
// off here: title behavior is covered hermetically by check:session-titles.
process.env.PI_DELEGATOR_TITLE = "off";

// The tool definition pulls in src/panel.ts, which uses TypeScript parameter
// properties that Node's strip-only loader rejects; jiti compiles it instead.
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
});
const { buildSubagentToolDefinition } = await jiti.import(
	resolve("src/orchestrate/tool-executor.ts"),
);
const { resetProgress } = await jiti.import(resolve("src/live-progress.ts"));

const HOST_MODEL = { provider: "host-provider", id: "host-model" };

const tempRoot = await mkdtemp(join(tmpdir(), "pi-delegator-host-model-"));
let oldIndexDir;
try {
  oldIndexDir = process.env.PI_SUBAGENT_RUN_INDEX_DIR;
  process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(tempRoot, "run-index");

  const cwd = join(tempRoot, "workspace");
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "agents", "pinned.md"),
    "---\nname: pinned\nmodel: profile-provider/profile-model\n---\nPinned profile.\n",
  );
  await writeFile(
    join(cwd, ".pi", "agents", "unpinned.md"),
    "---\nname: unpinned\n---\nUnpinned profile.\n",
  );

  const tool = buildSubagentToolDefinition("host-model check", []);
  let callCounter = 0;
  // The inline runner records model-resolution failures on the attempt's
  // stderr artifact rather than as a thrown tool error, so assert there.
  async function selectedModelEvidence(params) {
    const result = await tool.execute(
      `tool-call-host-model-${(callCounter += 1)}`,
      { cwd, ...params },
      () => {},
      { cwd, model: HOST_MODEL, sessionManager: { getSessionId: () => "sess-host" } },
      new AbortController().signal,
    );
    const payload = JSON.parse(result.content[0].text);
    // Parallel results nest the per-run envelopes under `runs`.
    const target = Array.isArray(payload.runs) ? payload.runs[0] : payload;
    assert.equal(target.status, "failed", `expected failure for ${JSON.stringify(params)}`);
    assert.equal(target.failureKind, "model");
    assert.equal(typeof target.runId, "string");
    return await readFile(
      join(cwd, ".pi", "agent", "runs", target.runId, "attempts", target.attemptId, "stderr.log"),
      "utf8",
    );
  }

  // 1. Agentless run with no model inherits the host session's model.
  const inherited = await selectedModelEvidence({ task: "no agent, no model" });
  assert.match(
    inherited,
    /host-provider\/host-model/,
    "an agentless run must inherit the host session's model",
  );

  // 2. An explicit call-level model wins.
  const explicit = await selectedModelEvidence({
    task: "explicit model",
    model: "call-provider/call-model",
  });
  assert.match(explicit, /call-provider\/call-model/);
  assert.doesNotMatch(
    explicit,
    /host-provider\/host-model/,
    "an explicit call-level model must not be replaced by the host model",
  );

  // 3. An agent profile's frontmatter model wins over the host model.
  const profiled = await selectedModelEvidence({ agent: "pinned", task: "profile model" });
  assert.match(profiled, /profile-provider\/profile-model/);
  assert.doesNotMatch(
    profiled,
    /host-provider\/host-model/,
    "an agent profile model must not be replaced by the host model",
  );

  // 4. An agentless call-level model still beats the host model per task.
  const parallel = await selectedModelEvidence({
    mode: "parallel",
    tasks: [{ task: "first", model: "task-provider/task-model" }],
    failFast: true,
  });
  assert.match(parallel, /task-provider\/task-model/);

  // 5. An agentless parallel task inherits the host model when it names none.
  const parallelInherited = await selectedModelEvidence({
    mode: "parallel",
    tasks: [{ task: "no model here" }],
    failFast: true,
  });
  assert.match(parallelInherited, /host-provider\/host-model/);

  // 6. A host model without a usable provider or id is ignored rather than
  //    turned into a malformed reference. Kept hermetic by naming a call-level
  //    model, so resolution fails before any network call.
  for (const malformed of [
    { provider: "", id: "host-model" },
    { provider: "host-provider", id: "" },
    { provider: "host-provider" },
    "not-a-model",
    null,
  ]) {
    const malformedResult = await tool.execute(
      `tool-call-host-model-malformed-${(callCounter += 1)}`,
      { cwd, task: "malformed host model", model: "call-provider/call-model" },
      () => {},
      { cwd, model: malformed, sessionManager: { getSessionId: () => "sess-host" } },
      new AbortController().signal,
    );
    const malformedPayload = JSON.parse(malformedResult.content[0].text);
    assert.equal(malformedPayload.failureKind, "model");
    const stderr = await readFile(
      join(
        cwd,
        ".pi",
        "agent",
        "runs",
        malformedPayload.runId,
        "attempts",
        malformedPayload.attemptId,
        "stderr.log",
      ),
      "utf8",
    );
    assert.match(stderr, /call-provider\/call-model/);
    assert.doesNotMatch(
      stderr,
      /host-provider|host-model/,
      `a malformed host model must be ignored, got ${JSON.stringify(malformed)}`,
    );
  }

  console.log(
    JSON.stringify({ name: "check-host-model", status: "completed", cases: 6 }, null, 2),
  );
} finally {
  resetProgress();
  if (oldIndexDir === undefined) delete process.env.PI_SUBAGENT_RUN_INDEX_DIR;
  else process.env.PI_SUBAGENT_RUN_INDEX_DIR = oldIndexDir;
  await rm(tempRoot, { recursive: true, force: true });
}
