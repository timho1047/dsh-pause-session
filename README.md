# dsh-pause

English | [中文](README.zh.md)

<p align="center"><img src="icon.svg" width="64" height="64" alt="dsh-pause icon"></p>

Pause every running DSH session and its subagents before you leave, then resume
them later.

dsh-pause stops each session at the same point: the tool call that is already
running finishes, then the next model request is held. Subagent trees are
included, and the pause survives a DSH restart.

> Status: beta. Tested against DSH `0.2.2-alpha.2`; the end-to-end rehearsal is
> tracked in [REHEARSAL.md](REHEARSAL.md).

## Quick start

1. If you are installing from a checkout rather than a packaged release, run
   `pnpm run build` first. Then open the **Plugins** page in the DSH Web sidebar
   and install this directory as a bundle. From a session in that profile,
   `plugin_manager` can do the same with `install_bundle` and the directory's
   absolute path. The local development layout is in
   [DEVELOPMENT.md](DEVELOPMENT.md).
2. Open the session you want to pause. Press the pause button beside its title
   to pause that session and its subagents, or press the pill on the right side
   of the header to pause every running session tree.
3. The control shows **Pausing** until the running tools finish and the next
   model requests are held. When the global pill shows **All Paused**, every
   registered session is stopped.
4. Next time, press **All Paused** to resume every cleanly paused session, or
   press the session button to resume that session and its subagents.

## The two controls

| Control | Scope | What it does |
|---|---|---|
| Session header button | One session and its subagents | Pauses the current session tree, then resumes the same tree. |
| Global pill | All running session trees | Pauses every registered session, then resumes every cleanly paused session. |

A session with an unfinished tool is shown as **Pausing**. It moves to
**Paused** only after the tool returns, the next model request is held, and the
session state is saved.

## What pause actually does

- A tool call already running is allowed to finish. No new tool call or model
  request is sent after the pause is taken.
- The next model request is held before it reaches the provider.
- Subagents already under the paused tree are stopped with the same rules.
- The pause state is durable. If DSH exits or restarts, the sessions are held
  again on the next mount.
- The composer stays usable; the pause is released by the same control, not by
  sending a message.

## What is not stopped

- Background jobs and shell tasks outside the agent loop are not stopped. The
  global control names them as a caveat.
- External one-shot subagent routes, such as Codex, Claude Code, ACP, and DSH
  SDK executions, cannot accept another turn or be cold-resumed. They are
  reported as unresumable and are not registered as paused local sessions.
- A paused session still looks `running` to parts of DSH's session lifecycle.
  Exit may take about five seconds; archiving, context compaction, and
  `wait_agent` can behave differently while a session is held.

## Resume and goals

Cleanly paused sessions resume from the point where they stopped. A session
goal is re-opened by default, which means it can continue running rounds and
spending money on its own. Before leaving, turn off the goal switch on the
session control if you do not want that. The setting is recorded in the pause
record and applies when that session is resumed.

Sessions that did not stop cleanly are never resumed silently. The global
control opens a decision list where each row can be continued, continued with a
note that the tool result is unknown, opened for review without running, or
left paused.

## Commands

The buttons drive these commands; they are useful for scripts and for
keyboard-first use:

| Command | Purpose |
|---|---|
| `/pause` | Pause the current session and its subagents. |
| `/pause-resume` | Resume the current paused session tree. |
| `/pause-resume-all` | Resume every paused session that stopped cleanly. |
| `/pause-all` | Pause every running session tree. |
| `/pause-state` | Report the current session tree's pause state. |
| `/pause-state-all` | Report the whole-app pause state. |
| `/pause-goal` | Toggle the current session's goal re-arm on resume. |
| `/pause-triage` | Read the decision list for sessions that did not pause cleanly. |
| `/pause-triage-continue`, `note`, `review`, `leave`, `goal` | Take one decision on a listed session. |

Status reads are commands too, so they appear as command rows in the session
transcript.

## Requirements

- DSH `>=0.2.2-alpha.2 <0.3.0-0`. The package declares this as `engines.dsh`;
  the Plugin Manager refuses an older runtime instead of starting an
  incompatible resume path.
- The standard Web profile. It mounts `sessionQuery` and `agentPresets`, which
  the resume path uses to rebuild each session's scoped Agent composition.
- Building from this repository requires the local development layout described
  in [DEVELOPMENT.md](DEVELOPMENT.md).

The plugin makes no network calls. Pause records live in the profile's storage
and session state stays in the existing session logs.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the workspace layout, build commands,
test suite, and the local DeepSeek Harness dependency links. The end-to-end
manual acceptance run lives in [REHEARSAL.md](REHEARSAL.md).

## License

MIT. See [LICENSE](LICENSE).
