# Changelog

## Unreleased

### Changed

- Target Pi harness v1.x only. Backward compatibility with pre-v1 releases will
  not be maintained; the coding-agent peer dependency now requires `^1.0.0`.

### Fixed

- Temporarily pin the sandbox runtime's Forge dependency to upstream security
  fix commit `ceba34402e329f0365134f23fe19898756527d65` for Git-source installs.
  Document npm's root-only override scope for dependency consumers.
- Standalone API callers pin their disk-backed runtime SDK before global `PATH`
  discovery, preserving SDK versions between synchronous and detached runs.
- Compiled Pi hosts retain native CLI invocation even with an SDK-root pin;
  JavaScript entry paths are no longer passed to the Pi binary as prompt text.
- Windows MSYS-form SDK roots are normalized for inline imports as well as CLI
  selection.
- Process-backed runners (`headless`, `tmux`, and `herdr`) select the CLI from
  the pinned SDK root before running-script or `PATH` discovery, including the
  legacy SDK-root alias. Detached workers now honor the pin for CLI execution
  as well as inline SDK imports.
- Compiled/embedded hosts retain their live virtual SDK for inline runs before
  falling back to an unrelated Pi installation on `PATH`. Detached workers
  continue to receive explicit disk-root pins because virtual modules cannot
  be inherited across processes.
- Restored detached (`async` / `onComplete`) runs on Pi 1.0. The durable worker
  is a plain `node` process with no access to the host's virtualised module
  graph, so it used to load the plugin's nested peer copy of
  `@earendil-works/pi-coding-agent`. Once the harness upgraded, that stale copy
  carried an outdated model catalog and every detached run failed immediately
  with `model "<profile model>" was not found or is not available`. Child
  processes now receive the resolved harness SDK package root, and SDK
  resolution prefers the SDK that belongs to the running `pi` CLI over any
  nested copy.
- Pi CLI discovery now reads the CLI entry point from the package's declared
  `bin.pi` field instead of assuming `dist/cli.js`; Pi 1.0 ships the entry at
  `dist/bundle/cli.js`.
- The running harness is identified by its owning package's `name` field rather
  than by the path shape of `process.argv[1]`. A path heuristic could not see
  source-style installs (`packages/coding-agent/dist/bundle/cli.js`) and fell
  back to whatever `pi` was on `PATH`, pinning children to an unrelated SDK
  version.
- Fixed a lost terminal commit when a run is interrupted. Publishing
  `result.json`/`run.json` used a `<path>.<pid>.<ms>.tmp` scratch name, so two
  writers in the same process that landed in the same millisecond aliased one
  scratch file and the second rename failed with `ENOENT`. Interrupting an async
  run triggers exactly that race, which left the run stuck in `running` with a
  dead worker. Scratch names are now unique per write and a failed rename cleans
  up after itself.
- Fixed agentless runs (`"agent"` omitted). They fell back to the
  `defaultModel` setting, which Pi 1.0's own session no longer honours, and
  usually pointed at a provider registered by an extension. The `inline` backend
  builds its own model runtime and cannot authenticate such a provider, so the
  SDK returned an empty assistant turn and the run failed with no explanation.
  A run with no model now inherits the parent session's model, and the
  no-output failure names the model it used plus the workaround.

## 0.1.0 - 2026-08-13

First independent `pi-delegator` release, derived from
`@agwab/pi-subagent` v0.4.8.

### Added

- Native Windows support, including durable process cancellation.
- Herdr as a visible cross-platform worker backend.
- Live tool-row progress and the `/subagent watch` modal.
- Session-scoped run discovery, lifecycle reconciliation, and `/subagent kill`.
- Headless event persistence with bounded, redacted streaming diagnostics.
- Bounded final-output previews for synchronous and detached runs.
- Agent catalog refresh, profile backend defaults, and unrestricted-tool wildcard support.

### Changed

- Strengthened lifecycle tracking so terminal artifacts override stale process state.
- Isolated transcript widgets by tool-call identity.
- Restored native live tool output in `/subagent watch` through a bounded,
  process-local transcript channel without persisting tool payload bodies.
- Assigned stable, monotonically increasing subagent numbers per Pi session and aligned `/subagent watch N` with those numbers.
- Expanded model routing to preserve extension-provided provider/model identifiers.

See `NOTICE.md` for upstream provenance and attribution.
