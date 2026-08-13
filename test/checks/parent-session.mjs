#!/usr/bin/env node
// Verifies parentSessionId is persisted into run.json by beginRunRecord and
// preserved across subsequent attempt upserts. This is the session-ownership
// signal pi-panel uses to scope footer subagent rows to the launching session.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginRunRecord, upsertRunAttempt, runPaths } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-subagent-parent-session-"));
const oldRunIndexDir = process.env.PI_DELEGATOR_RUN_INDEX_DIR;
process.env.PI_DELEGATOR_RUN_INDEX_DIR = join(tempRoot, "run-index");

try {
  const cwd = join(tempRoot, "workspace");
  await mkdir(cwd, { recursive: true });

  const runId = "run_parent_001";
  const attemptId = "attempt_parent_001";
  const parentSessionId = "session_abc123";

  await beginRunRecord({
    cwd,
    runId,
    mode: "single",
    backend: "headless",
    startedAt: "2026-06-15T00:00:00.000Z",
    dependency: null,
    parentSessionId,
    activeAttemptId: attemptId,
    attempts: [{ attemptId, status: "running", backend: "headless", startedAt: "2026-06-15T00:00:00.000Z" }],
  });

  const runJsonPath = runPaths({ cwd, runId }).runJsonPath;
  const afterBegin = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(afterBegin.parentSessionId, parentSessionId, "parentSessionId should be written by beginRunRecord");
  assert.equal(afterBegin.sessionOrdinal, 1, "the first run in a session should be #1");

  // Concurrent launches must serialize ordinal allocation without duplicates.
  const concurrentRuns = ["run_parent_003", "run_parent_004"];
  await Promise.all(concurrentRuns.map((concurrentRunId, index) => beginRunRecord({
    cwd,
    runId: concurrentRunId,
    mode: "single",
    backend: "headless",
    startedAt: `2026-06-15T00:00:0${index + 1}.000Z`,
    dependency: null,
    parentSessionId,
    activeAttemptId: `attempt_concurrent_${index}`,
    attempts: [{
      attemptId: `attempt_concurrent_${index}`,
      status: "running",
      backend: "headless",
      startedAt: `2026-06-15T00:00:0${index + 1}.000Z`,
    }],
  })));
  const concurrentOrdinals = await Promise.all(concurrentRuns.map(async (concurrentRunId) => {
    const record = JSON.parse(await readFile(runPaths({ cwd, runId: concurrentRunId }).runJsonPath, "utf8"));
    return record.sessionOrdinal;
  }));
  assert.deepEqual(concurrentOrdinals.sort((a, b) => a - b), [2, 3], "concurrent runs should receive unique rising numbers");

  const otherCwd = join(tempRoot, "other-workspace");
  await mkdir(otherCwd, { recursive: true });
  await beginRunRecord({
    cwd: otherCwd,
    runId: "run_parent_cross_cwd",
    mode: "single",
    backend: "headless",
    dependency: null,
    parentSessionId,
    activeAttemptId: "attempt_cross_cwd",
    attempts: [{ attemptId: "attempt_cross_cwd", status: "running", backend: "headless" }],
  });
  const crossCwd = JSON.parse(await readFile(runPaths({ cwd: otherCwd, runId: "run_parent_cross_cwd" }).runJsonPath, "utf8"));
  assert.equal(crossCwd.sessionOrdinal, 4, "the session sequence should continue across target working directories");

  // Subsequent attempt update (as durable workers / finishers do) must not drop it.
  await upsertRunAttempt({
    cwd,
    runId,
    attemptId,
    status: "completed",
    backend: "headless",
    completedAt: "2026-06-15T00:00:05.000Z",
  });

  const afterUpsert = JSON.parse(await readFile(runJsonPath, "utf8"));
  assert.equal(afterUpsert.parentSessionId, parentSessionId, "parentSessionId should survive upsertRunAttempt");
  assert.equal(afterUpsert.sessionOrdinal, 1, "sessionOrdinal should survive upsertRunAttempt");
  assert.equal(afterUpsert.status, "completed");

  // A run begun WITHOUT a parentSessionId must omit the field (back-compat:
  // pre-patch records have no field; panel treats missing as unowned).
  const runId2 = "run_parent_002";
  await beginRunRecord({
    cwd,
    runId: runId2,
    mode: "single",
    backend: "headless",
    startedAt: "2026-06-15T00:00:00.000Z",
    dependency: null,
    activeAttemptId: "attempt_x",
    attempts: [{ attemptId: "attempt_x", status: "running", backend: "headless", startedAt: "2026-06-15T00:00:00.000Z" }],
  });
  const noParent = JSON.parse(await readFile(runPaths({ cwd, runId: runId2 }).runJsonPath, "utf8"));
  assert.equal("parentSessionId" in noParent, false, "records without a parent session must omit the field");
  assert.equal("sessionOrdinal" in noParent, false, "records without a parent session must omit the ordinal");

  console.log(JSON.stringify({ name: "check-parent-session", status: "completed", parentSessionId }, null, 2));
} finally {
  if (oldRunIndexDir === undefined) delete process.env.PI_DELEGATOR_RUN_INDEX_DIR;
  else process.env.PI_DELEGATOR_RUN_INDEX_DIR = oldRunIndexDir;
  await rm(tempRoot, { recursive: true, force: true });
}
