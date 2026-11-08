# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-06

### Changed

- Both controls now use a native DSH Remote namespace and stream. The plugin
  registers no slash commands, so a status refresh never appends
  `command/run`/`command/done` records to a Session.
- Pause, resume, goal, and decision-list actions travel through the same
  native namespace on Web and Desktop.

### Added

- Global progress names every draining session and its running tools, and the
  in-progress action is **Cancel this pause**.
- The global pill can be dragged, remembers its position, and can be reset from
  the decision panel.
- The Remote namespace is owner-only.
- The client bundle uses a build-time codec-builder shim instead of bundling the full Zod runtime.
- One snapshot is shared by every connected Remote observer, and the snapshot projection shares its tree walks.
- The park episode machine, snapshot projection, release ordering, and resume copy now live in separate modules; `control.ts` is composition only.
- State-changing Remote actions are recorded with a structured host log entry and the caller principal.

### Fixed

- A park reaches `safe` only when the session-level flush actually ran; an
  unreadable record and a partially unread tree are reported instead of being
  counted clean.
- A restart-adopted park is no longer cancelled by the per-session button; it
  stays on the decision path.
- Stream and triage failures render as unavailable instead of stale rows, and
  triage decisions that the host refuses show the refusal.

### Removed

- The `/pause`, `/pause-resume`, `/pause-state`, `/pause-goal`, and
  `/pause-triage*` command surface.
- The command-era `ReadBurst`/JSON-status-route client machinery and the
  `@deepseek-ai/dsh-commands` dependency.

## [0.1.0] - 2026-11-02

### Added

- Pause every running DSH session and its subagents at the next model-request
  boundary, after the tool already running finishes.
- Session-header and whole-app controls, with `Pausing`, `Paused`, and
  `All Paused` states.
- Durable pause registry that re-holds parked sessions after a DSH restart.
- Clean resume that restores the recorded Agent preset composition, including
  subagent delegation context and tool restrictions.
- Goal re-arm toggle for cleanly paused sessions.
- Decision list for sessions that did not pause cleanly, with continue,
  continue-with-note, review-only, leave, and goal actions.
- Localized English and Chinese UI copy, plugin-manager metadata, and a
  user-facing README screenshot.
- `/pause`, `/pause-resume`, `/pause-all`, `/pause-state`, `/pause-goal`, and
  `/pause-triage*` command surface.

### Changed

- The package is published as `dsh-pause-session`; the slash-command namespace
  remains `/pause*`.
- One-shot and external subagent routes are reported as unresumable and are not
  registered as local pause records.

### Known Limitations

- Background jobs and shell tasks outside the agent loop are not stopped.
- A paused session still appears `running` to parts of DSH's session lifecycle;
  exit, archive, compaction, and `wait_agent` can behave differently while held.
- External one-shot subagent routes cannot be cold-resumed.

[0.2.0]: https://github.com/timho1047/dsh-pause-session/releases/tag/v0.2.0
[0.1.0]: https://github.com/timho1047/dsh-pause-session/releases/tag/v0.1.0
