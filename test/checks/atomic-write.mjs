#!/usr/bin/env node
// Regression coverage for atomic artifact writes.
//
// Every run/attempt record is published by writing a scratch file and renaming
// it over the destination. The scratch name used to be `<path>.<pid>.<ms>.tmp`,
// so two writers in the same process that landed in the same millisecond
// aliased one scratch file: the first rename consumed it and the second failed
// with ENOENT. Interrupting an async run triggers exactly that (the durable
// worker finalises the attempt while the cancelled runner finalises the same
// file), which silently dropped the terminal commit and left the run stuck in
// `running` forever.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicTempPath, atomicWriteFile } from "../../src/core/atomic-file.ts";
import { createAttemptArtifactStore } from "../../src/artifacts/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-delegator-atomic-"));
try {
  // 1. Scratch names are unique even inside a single millisecond.
  const first = atomicTempPath("result.json");
  const second = atomicTempPath("result.json");
  const third = atomicTempPath("result.json");
  assert.notEqual(first, second, "concurrent scratch names must not alias");
  assert.notEqual(second, third, "scratch names must stay unique per write");
  for (const path of [first, second, third]) {
    assert.ok(path.startsWith("result.json."), "scratch name keeps the destination as prefix");
    assert.ok(path.endsWith(".tmp"), "scratch name keeps the .tmp suffix");
  }

  // 2. Concurrent publishes to one destination all succeed and leave no litter.
  const cwd = join(tempRoot, "concurrent");
  const store = await createAttemptArtifactStore({
    cwd,
    runId: "run_atomic_check",
    attemptId: "attempt_atomic_check",
  });
  const envelopes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.writeResult({
        backend: "inline",
        status: index === 0 ? "completed" : "cancelled",
        failureKind: index === 0 ? null : "abort",
        cwd,
        startedAt: new Date(0),
        completedAt: new Date(1_000),
        workspace: { mode: "shared", cwd },
        sandbox: { enabled: false },
        exitCode: null,
        signal: index === 0 ? null : "ABORT",
      }),
    ),
  );
  assert.equal(envelopes.length, 8, "every concurrent publish must resolve");
  const persisted = JSON.parse(await readFile(store.pathFor("result"), "utf8"));
  assert.equal(persisted.runId, "run_atomic_check");
  assert.ok(
    envelopes.some((envelope) => envelope.status === persisted.status),
    "the surviving file must be one of the published envelopes",
  );
  const leftovers = (await readdir(store.attemptDir)).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, [], "successful publishes must not leave scratch files behind");

  // 3. Repeated publishes from the same process never fail (the interrupt race).
  for (let index = 0; index < 25; index += 1) {
    await store.writeResult({
      backend: "inline",
      status: "cancelled",
      failureKind: "abort",
      cwd,
      startedAt: new Date(0),
      completedAt: new Date(2_000),
      workspace: { mode: "shared", cwd },
      sandbox: { enabled: false },
      exitCode: null,
      signal: "ABORT",
    });
  }
  assert.equal(
    JSON.parse(await readFile(store.pathFor("result"), "utf8")).status,
    "cancelled",
    "the last publish wins",
  );
  assert.deepEqual(
    (await readdir(store.attemptDir)).filter((name) => name.endsWith(".tmp")),
    [],
    "no scratch file may survive a serial publish loop",
  );

  // 4. A failed rename cleans up its scratch file instead of leaking it.
  const leaking = join(tempRoot, "leak");
  await assert.rejects(
    atomicWriteFile(leaking, "payload", {
      platform: "win32",
      retries: 0,
      renameFile: async () => {
        const error = new Error("boom");
        error.code = "EPERM";
        throw error;
      },
    }),
    /boom/,
    "a rename failure must propagate",
  );
  const { readdir: listDir } = await import("node:fs/promises");
  assert.deepEqual(
    (await listDir(tempRoot)).filter((name) => name.startsWith("leak.")),
    [],
    "a failed publish must remove its scratch file",
  );

  console.log(JSON.stringify({ name: "check-atomic-write", status: "completed" }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
