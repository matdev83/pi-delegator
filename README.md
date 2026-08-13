# pi-delegator

**Cross-platform subagent delegation runtime for Pi.**

[![CI](https://github.com/matdev83/pi-delegator/actions/workflows/ci.yml/badge.svg)](https://github.com/matdev83/pi-delegator/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-delegator.svg)](https://www.npmjs.com/package/pi-delegator)

`pi-delegator` adds one focused tool, `subagent`, plus lifecycle commands and live TUI observability. It supports isolated worker runs, parallel fan-out, sandbox/worktree controls, durable artifacts, async execution, native Windows workers, and visible Herdr or tmux backends.

This is an independently maintained derivative of [AgwaB/pi-subagent](https://github.com/AgwaB/pi-subagent), based on upstream `v0.4.8`. It is not affiliated with or endorsed by the original project. See [NOTICE.md](./NOTICE.md) for provenance and attribution.

npm package: [`pi-delegator`](https://www.npmjs.com/package/pi-delegator)

## Installation

```bash
pi install npm:pi-delegator
```

Then reload Pi.

Requires Node.js `>=22.19.0`.

Platform support:

- **Linux / macOS** — fully supported. Visible workers use `tmux` (must be installed and on `PATH`).
- **Windows (native)** — `inline` and `headless` backends work out of the box. Visible workers use **`herdr`** ([herdr.dev](https://herdr.dev), a terminal workspace manager for coding agents) instead of tmux; request them with `backend: "herdr"` (or `visible: true` together with `backend: "herdr"`). The `tmux` backend is not available on native Windows; WSL2 is an option if you prefer tmux.

Do not install `pi-delegator` alongside another extension that registers the `subagent` tool or `/subagent` commands. Remove or disable the other extension first, then reload Pi.

For local development, add this package as a Pi extension source and reload Pi.

### Migrating from `@agwab/pi-subagent`

Remove the original package before installing `pi-delegator`; both extensions register the same `subagent` tool and `/subagent` command namespace. Existing run artifacts and the historical `.pi-subagent-worktrees` directory remain readable. New configuration should use `PI_DELEGATOR_*` environment variables; the previous `PI_SUBAGENT_*` names remain accepted as fallback aliases.

## Quick usage

Use it when you want Pi to spin up a separate worker instead of doing everything in the parent session:

```text
Run three reviewers in parallel for this change.
```

```text
Run this check in a sandboxed worker and report the artifact paths.
```

```text
Start a background audit and let me inspect it in /subagent panel.
```

## What it does

Tool: `subagent`

### Backends

Workers run in one of four backends:

| Backend | Platforms | Visible | Notes |
|---------|-----------|---------|-------|
| `inline` (default) | all | no | In-process SDK session; no child process |
| `headless` | all | no | Spawns a `pi --mode json` child process |
| `tmux` | Linux / macOS | yes | Worker runs in a detached tmux session |
| `herdr` | Windows, Linux, macOS | yes | Worker runs in a herdr workspace/pane |

`backend` defaults to `auto`: `visible` → `tmux`, `sandbox` → `headless`, otherwise `inline`. Pass `backend` explicitly to force one. On native Windows, `herdr` is the only visible backend:

```json
{
  "backend": "herdr",
  "agent": "worker",
  "task": "Run the tests and report the results."
}
```

The result envelope reports `herdr: { workspaceId, tabId, paneId }` for herdr runs. Requires the `herdr` CLI and a running herdr server (automatic once Herdr is installed).

### Sandbox

Run workers in an isolated local execution boundary.

```json
{
  "sandbox": true,
  "agent": "checker",
  "task": "Run a local check and report the artifact paths."
}
```

`sandbox: true` denies all network access. Model-backed sandboxed runs must allow their provider endpoint explicitly:

```json
{
  "sandbox": { "allowedDomains": ["api.anthropic.com"] },
  "agent": "implementer",
  "task": "Make the requested local change and run the checks."
}
```

### Worktree

Isolate parallel or mutating tasks in managed git worktrees. Workspaces default to shared; request `worktree: true` explicitly for tasks that mutate files in parallel.

```json
{
  "worktree": true,
  "agent": "implementer",
  "task": "Make the requested local change in an isolated worktree."
}
```

### Agent

Inject Pi subagent markdown definitions from global or project agent directories.

```json
{
  "agent": "reviewer-security",
  "task": "Review the current diff for security risks."
}
```

Agent markdown can live in `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`. Agent-level `tools` declarations are an authority ceiling; call-level `tools` can narrow them but not expand them. A `systemPrompt` override replaces the agent prompt body, not the agent's frontmatter policy.

### Type

Use one structured schema for single, parallel, async, and existing-run calls. `action` defaults to `run`. Each execution is a run; each launch is an attempt.

Single:

```json
{
  "agent": "reviewer",
  "task": "Review the current diff and summarize the highest-risk issues."
}
```

Parallel launches independent runs concurrently:

```json
{
  "tasks": [
    { "agent": "reviewer-security", "task": "Review the current diff for security risks." },
    { "agent": "reviewer-performance", "task": "Review the current diff for performance risks." },
    { "agent": "reviewer-test-coverage", "task": "Review the current diff for missing tests." }
  ]
}
```

Existing run:

```json
{ "action": "status", "runId": "run_..." }
```

Recent runs can be addressed by `runId` even when they were launched from another cwd; legacy records still resolve from the explicit or current cwd.

### Panel

Inspect runs, attempts, artifacts, and log tails in a live TUI. The panel defaults to the current Pi session, can switch to current cwd or all indexed runs, and includes status filters plus a scrollable detail pane. It shows active and recent terminal runs by default, with in-panel `m` to show more, and counts stale/malformed run pointers without exposing raw session ids.

Open the run monitor:

```text
/subagent panel
```

![/subagent panel](./assets/subagent-panel.png)

### Live progress

While a subagent runs, the tool row in the transcript shows live progress (elapsed time and the last output line, refreshed every second) instead of staying static until completion. Works for sync, async, headless, and herdr runs.

### Watch a run

`Alt+Shift+1` … `Ctrl+9` (and `Ctrl+Alt+1` … `Ctrl+Alt+9` as a fallback) open a modal overlay with the live progress of the 1st … 9th most recent subagent run of the current session: status, elapsed time, last activity, task text, and a live tail of the run's output. `↑`/`↓`/`j`/`k` scroll, `q`/`esc` close. Shortcuts fire only while the input editor is focused.

## Code API

Orchestrators can use the same runtime directly:

```ts
import { runSubagent, getSubagentStatus } from "pi-delegator/api";

const run = await runSubagent({ agent: "reviewer", task: "Review this diff.", async: true });
const status = await getSubagentStatus({ runId: run.runId });
```

## Detailed docs

- [`docs/usage.md`](./docs/usage.md) — full argument reference, code API, `action` behavior, backend selection, sandbox/worktree behavior, artifacts, and validation notes.

## Attribution

`pi-delegator` contains software originally developed for [`@agwab/pi-subagent`](https://github.com/AgwaB/pi-subagent) by AgwaB and distributed under the MIT License. The original copyright and license notice are retained in [LICENSE](./LICENSE). Subsequent cross-platform, lifecycle, observability, backend, and UX work is maintained independently by Mateusz (`matdev83`).
