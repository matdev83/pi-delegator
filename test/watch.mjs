// Smoke test for the watch modal: listSessionRuns + SubagentWatch render.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const watch = await jiti.import("../src/watch.ts");
const liveTranscript = await jiti.import("../src/live-transcript.ts");
initTheme(undefined, false);

const results = [];
function check(name, cond, extra = "") {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pi-watch-test-"));
const cwd = join(root, "repo");
const runsDir = join(cwd, ".pi", "agent", "runs");
const runId = "run_watch_001";
const attemptId = "attempt_watch_001";
const runDir = join(runsDir, runId);
const attemptDir = join(runDir, "attempts", attemptId);
mkdirSync(attemptDir, { recursive: true });

const startedAt = new Date(Date.now() - 90000).toISOString();
writeFileSync(
	join(runDir, "run.json"),
	JSON.stringify({
		schemaVersion: 2, runId, mode: "single", status: "running",
		backend: "herdr", parentSessionId: "session-abc", startedAt,
		sessionOrdinal: 1,
		updatedAt: new Date().toISOString(), completedAt: null,
		latestAttemptId: attemptId, attempts: [],
	}),
);
writeFileSync(
	join(attemptDir, "worker.json"),
	JSON.stringify({ runId, attemptId, input: { agent: "worker", task: "Run the tests" }, cwd }),
);
writeFileSync(
	join(attemptDir, "output.log"),
	`line one\nline two\n${"long output marker ".repeat(8)}\nAll tests passed.\n`,
);

// listSessionRuns scoped to the session.
const all = await watch.listSessionRuns(cwd, undefined);
check("listSessionRuns finds fabricated run", all.length === 1 && all[0].runId === runId, JSON.stringify(all.map(r => r.runId)));
check("task extracted from worker.json", all[0]?.task === "Run the tests", all[0]?.task);
check("lastLine from output.log", all[0]?.lastLine === "All tests passed.", all[0]?.lastLine);
check("status running", all[0]?.status === "running");

const scoped = await watch.listSessionRuns(cwd, "session-abc");
check("session scope includes matching session", scoped.length === 1);
const other = await watch.listSessionRuns(cwd, "session-other");
check("session scope excludes other session", other.length === 0);

// Render the modal component.
let closed = false;
const theme = {
	fg: (color, text) => `[${color}]${text}[/${color}]`,
	bold: (text) => `*${text}*`,
};
const tui = { requestRender: () => {} };
const modal = new watch.SubagentWatch(cwd, theme, tui, () => { closed = true; }, all[0], 1);
const lines = modal.render(80);
const joined = lines.join("\n");
check("render produces lines", lines.length >= 6, `lines=${lines.length}`);
check("title shows subagent #1", joined.includes("subagent #1"), lines[1]);
check(
	"content has one-character horizontal padding",
		lines[1].startsWith("[border]│[/border] "),
		lines[1],
	);
check("status shown", joined.includes("running"));
check(
	"run identity or status shown in narrow render",
	joined.includes("run_w") || joined.includes("running"),
	lines[1],
);
check("output tail shown", joined.includes("All tests passed."));
check(
	"long output is preserved for modal wrapping",
	all[0]?.outputTail.some((line) => line.length > 90) === true,
);
check("footer shows close hint", joined.includes("q/esc"));

const renderRequests = [];
tui.requestRender = (force) => renderRequests.push(force);
writeFileSync(join(attemptDir, "output.log"), "fresh progress marker\n");
await modal.refresh();
const refreshed = modal.render(80).join("\n");
check("refresh loads newly appended output", refreshed.includes("fresh progress marker"));
check("refresh requests a forced render", renderRequests.at(-1) === true);

writeFileSync(
	join(attemptDir, "pi-events.jsonl"),
	[
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Starting checks." } },
		{ type: "tool_execution_start", toolCallId: "tool-live-1", toolName: "bash" },
		{ type: "tool_execution_update", toolCallId: "tool-live-1", toolName: "bash", progressChars: 4096 },
	]
		.map((event) => JSON.stringify(event))
		.join("\n") + "\n",
);
for (const event of [
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Starting checks." } },
	{ type: "tool_execution_start", toolCallId: "tool-live-1", toolName: "bash", args: { command: "npm test" } },
	{ type: "tool_execution_update", toolCallId: "tool-live-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "visible live test output" }] } },
]) liveTranscript.publishLiveTranscriptEvent(runId, attemptId, event);
await modal.refresh();
const toolProgress = modal.render(80).join("\n");
check("inline transcript shows assistant progress", toolProgress.includes("Starting checks."));
check(
	"inline transcript shows native live tool output",
	toolProgress.includes("visible live test output") && !toolProgress.includes("content hidden"),
);

modal.handleInput("q");
check("q closes modal", closed === true);

// Cleanup the interval by disposing.
modal.dispose();
liveTranscript.resetLiveTranscripts();

// Stable numbering is chronological and independent of directory mtimes or
// completion order. The default listing remains newest-first for lifecycle API
// compatibility, while the watcher requests oldest-first.
for (const [number, offset] of [[2, 60_000], [3, 30_000]]) {
	const numberedRunId = `run_watch_00${number}`;
	const numberedAttemptId = `attempt_watch_00${number}`;
	const numberedRunDir = join(runsDir, numberedRunId);
	mkdirSync(join(numberedRunDir, "attempts", numberedAttemptId), { recursive: true });
	writeFileSync(
		join(numberedRunDir, "run.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId: numberedRunId,
			mode: "single",
			status: "completed",
			backend: "headless",
			parentSessionId: "session-abc",
			sessionOrdinal: number,
			startedAt: new Date(Date.now() - offset).toISOString(),
			updatedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			latestAttemptId: numberedAttemptId,
			attempts: [],
		}),
	);
}
const chronological = await watch.listSessionRuns(cwd, "session-abc", "oldest");
check(
	"oldest ordering follows stable session numbers",
	JSON.stringify(chronological.map((run) => run.sessionOrdinal)) === "[1,2,3]",
	JSON.stringify(chronological.map((run) => run.sessionOrdinal)),
);
const newest = await watch.listSessionRuns(cwd, "session-abc");
check(
	"default lifecycle ordering remains newest first",
	JSON.stringify(newest.map((run) => run.sessionOrdinal)) === "[3,2,1]",
	JSON.stringify(newest.map((run) => run.sessionOrdinal)),
);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.some(r => !r.ok) ? 1 : 0);
