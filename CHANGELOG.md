# Changelog

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
