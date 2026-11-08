import { z } from "zod";
import { SessionId, deriveEventMessage, foldRequestHeader, foldSurface, interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { applyChildComposition, foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { DomainError, defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region lib/types/history.js
/**
* The message history a session's log derives to, and the one rule that reads
* whether it still owes the model an answer.
*
* That question is asked twice and must have one answer: the clean wake asks it
* before it hands a session an input (an input nobody owes an answer to would
* open a turn of its own), and the decision list publishes it as the row's
* `wake` field. A published promise that the wake then declines to keep is the
* report lying, so both read the same derivation and the same rule.
*
* The derivation is the harness's own: the surface fold the loop reads its
* history through, with the same message projections this process has
* registered, and an interrupted tail closed exactly as the harness closes it
* on the next read. `resume.ts` reads the live form of it
* (`Session.deriveMessages()`); {@link derivedHistory} is the cold form over a
* stored log, which is all the decision list may claim — it opens a log to read
* it and never activates a session.
* @module dsh-pause-session/history
*/
/**
* Whether one derived history ends owing the model an answer: the last thing
* said on the model-visible surface is not an assistant message.
* @param messages - a derived history, in model-visible order.
* @returns whether a model still owes that history a reply.
*/
function owesReply(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === void 0 || message.role === "system" || message.role === "developer") continue;
		return message.role !== "assistant";
	}
	return false;
}
/**
* The messages one stored log derives to, as the harness would read them on the
* session's next activation: the open tail turn is closed with the harness's
* own synthetic results first, then the log is folded into its surface.
* @param events - the stored events, exactly as they are stored and in sequence order.
* @param projections - this process's registered message projections.
* @returns the derived history, in model-visible order.
* @throws when the log cannot be folded — an event this build has no interpreter
* for, or surface metadata that does not apply to this history.
*/
function derivedHistory(events, projections) {
	const stored = [...events, ...interruptedTurnClosers(events)];
	const fold = foldSurface(stored, projections);
	return fold.nodes.flatMap((seq) => {
		const event = stored[seq];
		if (event === void 0) return [];
		const message = deriveEventMessage(event, fold.projectedMessages);
		return message === null ? [] : [message];
	});
}
/**
* Whether one stored log names the route a wake would be addressed to. The wake
* needs a provider and a model to build a request at all, and the request
* header the session itself persisted is the only place that names them.
* @param events - the stored events, in sequence order.
* @returns whether the log's last request header carries both route fields.
*/
function routeNamed(events) {
	const config = foldRequestHeader(events)?.config;
	return config !== void 0 && config.provider.length > 0 && config.model.length > 0;
}
//#endregion
//#region lib/types/shared.js
/**
* The identities both halves of dsh-pause-session name, the phase vocabulary
* they share, and the one spelling a host log line gives a caught value.
*
* The browser bundle may value-import only the shell's baseline module table,
* so this module imports nothing. The native Remote payloads are the live
* vocabulary; there is no command encoding or slash-command surface here.
* @module dsh-pause-session/shared
*/
/**
* One log line's text for a caught value.
* @param error - the caught value.
* @returns the error's message, or the value's own spelling.
*/
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The four park outcomes, listed in the order a park walks them — and the one
* vocabulary the live status, the durable registry, and the published words all
* derive from, so they cannot drift apart:
*
* - `draining`: paused, and the session is still working — a tool is running, or
*   a turn is between steps.
* - `parking`: standing still at the park point; the session-level flush has
*   not resolved yet.
* - `safe`: parked and flushed, so it is safe to walk away. The only clean one.
* - `flush-failed`: parked, but the flush failed — the durable promise is not
*   kept, and it must never be read as clean.
*/
const PARK_PHASES = [
	"draining",
	"parking",
	"safe",
	"flush-failed"
];
/**
* How far along a phase is, worst first. The direction is not the order a park
* walks: it orders how much of the promise each outcome keeps, which is what a
* fold over several sessions has to compare. `safe` keeps all of it, `draining`
* and `parking` are on their way, `flush-failed` has stopped trying — a park
* that failed its flush is further from clean than one that is still working at
* it, so it must never be the outcome a report rounds down to.
*/
const PHASE_SEVERITY = {
	safe: 0,
	draining: 1,
	parking: 2,
	"flush-failed": 3
};
/**
* Fold several records into the one verdict that speaks for all of them: the
* worst phase any of them reached, and whether every one of them is clean.
*
* This is how a session's control answers for its tree. "Safe to close" is a
* promise about everything the press registered, so it may be said only when
* every member reached the flushed park point; anything else is reported as the
* least-clean state in the set, never rounded up to the session's own.
* @param phases - the durable phases of the records being spoken for.
* @returns the worst phase, and whether that verdict is the clean one.
*/
function foldTreePhases(phases) {
	let worst = "safe";
	for (const phase of phases) if (PHASE_SEVERITY[phase] > PHASE_SEVERITY[worst]) worst = phase;
	return {
		phase: worst,
		safe: worst === "safe"
	};
}
//#endregion
//#region lib/types/coldlog.js
/**
* Reading one parked session's stored log through a bound, and the facts the
* morning list may claim from what it read.
*
* The decision list reads the same log the wake reads, but for the opposite
* reason: the wake has to reproduce the session, so it reads everything. The
* list only has to name where the session stopped, which tool call the log
* never heard back from, and whether an answer is still owed — all of them
* facts about the log's END. Reading from seq 0 to the end for every row, on
* every time the panel opens, would make a long
* session's cost grow with a log nobody is asking about.
*
* WHAT THE BOUND BUYS. A stored log is append-only, so the tail is stable: the
* read takes the last {@link TRIAGE_WINDOW_EVENTS} events, or the whole log when
* it is shorter, and the answer is derived from that. The window is complete
* whenever the log fits inside it, which is the common case; the fold the rest
* of this plugin reads history through is then the harness's own, over exactly
* the events the harness would fold.
*
* WHAT THE TAIL ALONE PROVES. A truncated window still answers the list's
* questions, for one reason the harness guarantees: a dangling tool call exists
* only inside the step that is still open, because a step's end is written
* after its results. So an unanswered call is always inside the final open
* span, and the tail that contains that span contains every one of them. What
* the window cannot prove — a log a replacement event rewrote from further back
* — is not guessed at: {@link logFacts} reports `undefined` and the row says
* `unreadable`, because a list that invents a stop position is worse than a
* list that says it could not read one.
* @module dsh-pause-session/coldlog
*/
/**
* Events the read looks at before it gives up. Sized to hold a whole final
* step — the model exchange, its tool calls, and their results — with room to
* spare, at a cost that does not grow with the session.
*/
const TRIAGE_WINDOW_EVENTS = 2e3;
/**
* The longest log the read will walk while locating where its tail starts.
*
* The window's start is found by probing for the log's length, so a log longer
* than this cannot be located from its end at a cost worth paying for a panel
* left open. Such a log — a million stored events — is reported unreadable
* rather than read from the front, which is the read this module exists to
* avoid.
*/
const TRIAGE_LOG_MAX_EVENTS = 1e6;
/**
* Events that are not the session's own story: the bookkeeping of the pause
* pre-0.2.0 command records the user pressed, and the pending-input splices the
* inbox writes. They are real and durable, but "it stopped right after the
* action finished"
* is not what "where did it stop" means.
*/
const BOOKKEEPING_EVENTS = /* @__PURE__ */ new Set([
	"command/run",
	"command/done",
	"agent/inbox/spliced"
]);
/**
* The turn and step an event belongs to, when it carries them.
* @param event - one stored event.
* @returns the position fields the event has, and nothing for the fields it does not.
*/
function positionOf(event) {
	const data = event.data;
	if (typeof data !== "object" || data === null) return {};
	const turn = "turn" in data && typeof data.turn === "number" ? data.turn : void 0;
	const step = "step" in data && typeof data.step === "number" ? data.step : void 0;
	return {
		...turn === void 0 ? {} : { turn },
		...step === void 0 ? {} : { step }
	};
}
/**
* Every tool call the STORED events record and no stored result answers.
*
* Deliberately the stored prefix rather than the repaired view: what a row
* reports is the state of the session's own log, and the harness's synthetic
* unknown-outcome results are exactly what that log is missing. Taking the
* repaired view here would subtract the very traces the row exists to show.
*
* A call is answered only by a result the SAME window holds, which is what the
* harness's own repair rule reads too: an unanswered call lives in the step
* that is still open, so it is inside this window or it is answered.
* @param events - the stored events the read returned, in sequence order.
* @returns one trace per call with no result, in call order.
*/
function unansweredCalls(events) {
	const names = /* @__PURE__ */ new Map();
	const answered = /* @__PURE__ */ new Set();
	for (const event of events) {
		if (event.type === "tool/call") {
			names.set(String(event.data.callId), event.data.name);
			continue;
		}
		if (event.type !== "tool/result") continue;
		answered.add(String(event.data.message.toolCallId));
	}
	return [...names].flatMap(([callId, tool]) => answered.has(callId) ? [] : [{
		tool,
		callId
	}]);
}
/**
* Whether a log ends owing the model an answer, read from the tail alone.
*
* This is the harness's own rule — the last thing on the model-visible surface
* is not an assistant message — read the way the harness reads it: the surface
* fold over the events at hand, then the message the last node derives to. The
* fold is handed a window rather than the whole log, so it refuses rather than
* guesses when it meets a replacement it cannot resolve; a log it cannot fold
* falls back to the last event that produces a message at all, which is the
* same answer by a narrower route.
* @param events - the stored events the read returned, in sequence order.
* @param traces - the unanswered calls, as the row reports them.
* @returns whether the session still owes the model a reply.
*/
function tailOwesReply(events, traces) {
	if (traces.length > 0) return true;
	const bySequence = new Map(events.map((event) => [event.seq, event]));
	const lastNode = () => {
		for (const seq of [...foldSurface(events).nodes].reverse()) {
			const event = bySequence.get(seq);
			if (event !== void 0) return event;
		}
	};
	let anchor;
	try {
		anchor = lastNode();
	} catch {
		for (let at = events.length - 1; at >= 0; at -= 1) {
			const event = events[at];
			if (event === void 0 || deriveEventMessage(event) === null) continue;
			anchor = event;
			break;
		}
	}
	if (anchor === void 0) return false;
	const message = deriveEventMessage(anchor);
	if (message === null) return false;
	if (message.role === "system" || message.role === "developer") return false;
	return message.role !== "assistant";
}
/**
* The facts one bounded read of a stored log supports.
*
* A complete read is folded by the harness's own derivation, so the list and
* the wake answer the "does it still owe a reply" question through one rule.
* A truncated read answers from the tail, and only where the tail is proof: a
* replacement event that rewrote a surface range from outside the window is
* not visible here, so a log whose tail a later event could have rewritten is
* reported unreadable rather than guessed at.
* @param events - the stored events the read returned, in sequence order.
* @param complete - whether those events are the whole stored log.
* @param projections - this process's registered message projections.
* @returns the row's facts, or `undefined` when this read cannot support them.
*/
function logFacts(events, complete, projections) {
	let last;
	for (let at = events.length - 1; at >= 0; at -= 1) {
		const event = events[at];
		if (event === void 0 || BOOKKEEPING_EVENTS.has(event.type)) continue;
		last = event;
		break;
	}
	const traces = unansweredCalls(events);
	const wakeableRoute = routeNamed(events);
	if (!complete) {
		if (last === void 0) return void 0;
		const owed = tailOwesReply(events, traces);
		return {
			last,
			traces,
			owed,
			wakeable: owed && wakeableRoute
		};
	}
	let owed;
	try {
		owed = owesReply(derivedHistory(events, projections));
	} catch {
		return;
	}
	return {
		last,
		traces,
		owed,
		wakeable: owed && wakeableRoute
	};
}
/**
* Whether one handle holds at least `count` events, asked without materializing
* more than one of them.
* @param handle - an open read handle onto the log.
* @param count - the event count to test for.
* @param signal - cancellation for the probe.
* @returns whether the log reaches that far.
*/
async function reaches(handle, count, signal) {
	return (await handle.read(count, 1, { ...signal === void 0 ? {} : { signal } })).events.length > 0;
}
/**
* The stored log's own length, found by probing rather than by reading it.
*
* The handle's read seam is the only way to ask a backend anything, and it
* takes an offset — so the count has to be probed for. The probe doubles until
* it passes the end and then bisects, so a log of any length costs a handful
* of one-event reads, and none of them materializes the prefix it skips.
* @param handle - an open read handle onto the log.
* @param signal - cancellation for the probe.
* @returns the event count, or `undefined` when the log is longer than this read will walk.
*/
async function eventCount(handle, signal) {
	let high = 1;
	while (await reaches(handle, high, signal)) {
		if (high >= 1e6) return void 0;
		high = Math.min(high * 2, TRIAGE_LOG_MAX_EVENTS);
	}
	let low = 0;
	while (high - low > 1) {
		const mid = low + Math.floor((high - low) / 2);
		if (await reaches(handle, mid, signal)) low = mid;
		else high = mid;
	}
	return await reaches(handle, 0, signal) ? low + 1 : 0;
}
/**
* Read one session's stored log, bounded to the events the list's facts need.
*
* The window is the last `windowEvents` events, found by probing for the log's
* length and then reading exactly that slice. A short log is returned whole and
* marked complete; a log longer than {@link TRIAGE_LOG_MAX_EVENTS} is reported
* unreadable without being read at all.
* @param ctx - host context carrying the optional persistence service.
* @param sessionId - the stored session to read.
* @param windowEvents - how many events of the log's end one row may fold.
* @param signal - cancellation for the open, probe, and read.
* @returns the bounded read, or `unreadable` when no read seam exists, it refused, or the log is too long to walk.
* @throws the cancellation reason when `signal` aborts the read.
*/
async function coldRead(ctx, sessionId, windowEvents = TRIAGE_WINDOW_EVENTS, signal) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return { kind: "unreadable" };
	let handle;
	try {
		handle = await persistence.open(sessionId, "read", { ...signal === void 0 ? {} : { signal } });
	} catch (error) {
		if (signal?.aborted === true) throw error;
		ctx.logger.warn(`pause: could not open the stored log of "${sessionId}": ${describeError(error)}`);
		return { kind: "unreadable" };
	}
	try {
		const window = Math.max(1, Math.floor(windowEvents));
		const count = await eventCount(handle, signal);
		if (count === void 0) {
			ctx.logger.warn(`pause: the stored log of "${sessionId}" is longer than this read will walk`);
			return { kind: "unreadable" };
		}
		const start = Math.max(0, count - window);
		return {
			kind: "read",
			events: (await handle.read(start, window, { ...signal === void 0 ? {} : { signal } })).events,
			complete: start === 0
		};
	} catch (error) {
		if (signal?.aborted === true) throw error;
		ctx.logger.warn(`pause: could not read the stored log of "${sessionId}": ${describeError(error)}`);
		return { kind: "unreadable" };
	} finally {
		await handle.close();
	}
}
//#endregion
//#region lib/types/composition.js
/**
* Rebuild the scoped Agent composition a parked Session ran under.
*
* Activation is not only a persisted Session: the Agent preset supplies the
* scoped tools, prompt sections, skills, and — for a subagent child — the
* delegation context, persona, and tool restriction that were in force before
* the park. A resume that loads the log without that setup starts a different
* Agent on the same history.
*
* The preset a Session runs is the `agentPreset` projection, never the
* creation-time header alone: a blank Session may select another preset before
* its first turn, and the projection records the selection that actually ran.
* A child with no independent selection joins its live parent's preset
* generation; one that selected independently mounts the projected preset.
* The durable child descriptor supplies the persona, tool filter, and route
* that are reapplied only on cold resume.
*
* Both services are optional. A profile without `agentPresets` has no scoped
* preset composition to restore, and this module leaves the resume unchanged.
* A profile that mounts one but cannot read the Session projection cannot
* prove what composition the Session ran, so it fails the resume instead of
* silently starting a different Agent.
* @module dsh-pause-session/composition
*/
/**
* A stored subagent route that no resume may reactivate.
*
* A one-shot child is terminal by contract; activating it as a root Agent
* would turn a finished delegation into an ordinary conversation that happens
* to share its Session id.
*/
var UnresumableSessionError = class extends Error {
	constructor(sessionId) {
		super(`subagent session "${String(sessionId)}" has a one-shot route and cannot be resumed`);
		this.name = "UnresumableSessionError";
	}
};
/**
* Whether the child's own log selected a preset before its descriptor.
*
* The creation-time selection precedes the first `subagent/descriptor`; a
* selection after the descriptor belongs to the child's own later history and
* does not decide which composition cold resume joins. This mirrors the
* subagent runtime's own cold-resume rule.
* @param events - the child's own log suffix, without the fork-inherited prefix.
* @returns whether the child carries an independent preset selection.
*/
function hasIndependentPresetSelection(events) {
	for (const event of events) {
		if (event.type === "subagent/descriptor") return false;
		if (event.type === "agent-preset/selected") return true;
	}
	return false;
}
/**
* Whether a local Session may be parked under a promise of a later resume.
*
* A normal root Session has no child descriptor and is resumable. A local
* subagent child is resumable only when its own durable descriptor is
* `continuable`; a historical `one-shot` child is terminal and must never be
* registered as a park the morning path would later have to refuse. External
* executions have no local Session, so callers never reach this check.
*
* A profile without the optional Session-query service cannot prove the
* descriptor's mode; it keeps the previous permissive behavior rather than
* dropping every subagent. The web profile mounts the query service.
* @param ctx - host context carrying the optional Session-query service.
* @param sessionId - the local Session to inspect.
* @param signal - cancellation for the observation read.
* @returns whether a park of this Session may be resumed.
* @throws the cancellation reason when `signal` aborts the read.
*/
async function isResumableSession(ctx, sessionId, signal) {
	const query = ctx.get("sessionQuery");
	if (query === void 0) return true;
	const observation = await query.observeSession(sessionId, { ...signal === void 0 ? {} : { signal } });
	try {
		return foldSubagentDescriptor(observation.events.slice(observation.inheritedEventCount))?.mode !== "one-shot";
	} finally {
		observation[Symbol.dispose]();
	}
}
/**
* Read one parked Session's stored composition and build the resume options.
*
* The returned `setup` belongs to the unpublished Agent scope, so all
* registrations exist before `agent/created`. For a root Session the setup
* mounts the Session's projected preset, or the profile's default when the
* Session never selected one. For a child under a live parent it applies the
* child composition: an independent preset mounts separately, while an
* inherited composition joins the parent's current generation; the historical
* descriptor's persona and tool filter are reapplied in both cases.
* @param ctx - host context carrying the optional preset and Session-query services.
* @param sessionId - the parked Session being resumed.
* @param parent - the live direct parent, when a child is resumed under it.
* @param signal - cancellation for the observation read.
* @returns the Agent options and setup to pass to `agents.resume`.
* @throws {UnresumableSessionError} when the stored child route is one-shot.
* @throws when a mounted preset roster cannot read the Session projection, or
* a recorded preset cannot be restored.
*/
async function restoreComposition(ctx, sessionId, parent, signal) {
	const presets = ctx.get("agentPresets");
	const query = ctx.get("sessionQuery");
	if (query === void 0) {
		if (presets !== void 0) throw new Error("resuming a composed Agent requires the session-query service");
		return {};
	}
	const observation = await query.observeSession(sessionId, { ...signal === void 0 ? {} : { signal } });
	try {
		const projections = observation.projections;
		const ownEvents = observation.events.slice(observation.inheritedEventCount);
		const descriptor = foldSubagentDescriptor(ownEvents);
		if (descriptor?.mode === "one-shot") throw new UnresumableSessionError(sessionId);
		if (presets === void 0 || projections === void 0) {
			if (presets !== void 0) throw new Error("resuming a composed Agent requires projected Session state");
			return {};
		}
		if (parent === void 0) {
			const resolved = await presets.resolve(projections.values.agentPreset ?? void 0);
			return { setup: async (agentCtx) => {
				await presets.mount(agentCtx, resolved.id);
			} };
		}
		const independentlySelected = hasIndependentPresetSelection(ownEvents);
		const presetId = independentlySelected ? projections.values.agentPreset : void 0;
		if (independentlySelected && typeof presetId !== "string") throw new Error(`subagent "${String(sessionId)}" has no projected agent preset to restore`);
		const composition = {
			...typeof presetId === "string" ? { agentPreset: presetId } : {},
			...descriptor?.mode === "continuable" && descriptor.persona !== void 0 ? { persona: descriptor.persona } : {},
			...descriptor?.mode === "continuable" && descriptor.toolFilter !== void 0 ? { toolFilter: descriptor.toolFilter } : {}
		};
		const agentOptions = descriptor?.mode === "continuable" ? {
			...descriptor.agentProvider === void 0 ? {} : { provider: descriptor.agentProvider },
			...descriptor.agentModel === void 0 ? {} : { model: descriptor.agentModel },
			...descriptor.agentReasoningEffort === void 0 ? {} : { reasoningEffort: descriptor.agentReasoningEffort }
		} : void 0;
		return {
			...agentOptions === void 0 ? {} : { agentOptions },
			setup: async (agentCtx) => {
				await applyChildComposition(agentCtx, parent, composition);
			}
		};
	} finally {
		observation[Symbol.dispose]();
	}
}
//#endregion
//#region lib/types/tree.js
/**
* One session's subagent tree, read from the parent catalogs.
*
* "This session's work" includes the subagents it delegated to, nested ones
* included, so the session-header press and the status the header shows both
* need the same answer to "which sessions hang under this one".
* `listDescendants` is the harness's own recursive walk of the parent-owned
* catalogs, and it is the only source: the tree is read from the parents that
* record it, never guessed from session ids.
*
* A walk is read, not remembered. The tree is a fact that grows — a delegation
* in flight publishes its child after the parent's catalog was read — so a
* press walks the tree at press time and a status read walks it at read time.
* `@module dsh-pause-session/tree`
*/
/**
* Read the subagent tree under one session.
*
* A failure to read a branch is reported as unread rather than as an empty
* tree: the difference is what keeps a press from claiming it registered a tree
* it never saw, and keeps a status answer from calling itself safe behind an
* unknown branch.
* @param ctx - host context carrying the optional subagent service.
* @param rootSessionId - the session whose descendants are requested.
* @param signal - cancellation for the catalog walk.
* @returns the descendants found and what of the walk could not be read.
* @throws the cancellation reason when `signal` aborts the walk.
*/
async function walkDescendants(ctx, rootSessionId, signal) {
	const subagents = ctx.get("subagents");
	if (subagents === void 0) return {
		members: [],
		unread: [],
		unreadWhole: false
	};
	try {
		const rows = await subagents.listDescendants(rootSessionId, signal);
		const members = [];
		const unread = [];
		for (const row of rows) {
			if (row.kind === "child") {
				members.push({
					id: row.id,
					mode: row.mode
				});
				continue;
			}
			unread.push({
				id: row.id,
				reason: row.reason
			});
		}
		return {
			members,
			unread,
			unreadWhole: false
		};
	} catch (error) {
		if (signal?.aborted === true) throw error;
		ctx.logger.warn(`pause: could not read the subagent tree of "${rootSessionId}": ${describeError(error)}`);
		return {
			members: [],
			unread: [],
			unreadWhole: true
		};
	}
}
//#endregion
//#region lib/types/global.js
/**
* The whole-app park: one action that registers every running session tree,
* and the aggregate answer to "can I close the lid?".
*
* The per-session control owns one session's park; this module owns the set.
* It reads three real sources and never infers what they can say themselves:
*
* - `ctx.agents.list()` plus the park activity fold decide which sessions are
*   running. A session with no live agent is not running, and a session with
*   nothing unfinished — no tool in flight, no turn open, no delivery the loop
*   has not claimed — is left alone.
* - The subagent runtime's descendant rows decide the tree and the one-shot
*   fact. A row's `mode` is the harness's own durable record of whether that
*   child can be resumed after a restart; a branch the walk could not read is
*   reported as unread rather than assumed clean.
* - The job registry decides which background jobs belong to the registered
*   trees. Those run outside the agent loop: this plugin cannot stop them, so
*   it names them.
*
* The aggregate is derived in one place so the host's answer and the browser's
* reading of it cannot disagree, and it is a promise about the durable
* registry: a session is `safe` only when its recorded phase says so.
* @module dsh-pause-session/global
*/
/**
* How many times one press walks the trees again. A tree can grow while the
* walk runs — a delegation already in flight publishes its child after the
* parent's catalog was read — so the walk repeats until it stops finding a
* running session this action has not pressed yet.
*/
const PRESS_ROUNDS = 4;
/** Fold one shared tree walk into the two doubts this report publishes. */
function readingOf(walk) {
	return {
		members: walk.members.map((member) => member.id),
		unresumable: walk.members.some((member) => member.mode !== "continuable") || walk.unread.some((branch) => branch.reason === "unsupported"),
		unread: walk.unreadWhole || walk.unread.some((branch) => branch.reason !== "unsupported")
	};
}
/**
* Mount the whole-app park.
* @param ctx - host context carrying the agent store and the optional subagent
* and job services.
* @param watch - the activity fold that says whether a session has unfinished work.
* @param registry - the durable list this aggregate is a promise about.
* @param deps - the per-session press and the live phase of every mark.
* @returns the one-press action and the aggregate read.
*/
function mountGlobalPause(ctx, watch, registry, deps) {
	/**
	* Sessions this action tried to press and could not record. They are NOT
	* parked and they keep running, so the aggregate counts them and names them
	* instead of quietly leaving them out of a park it then calls safe.
	*/
	const unrecorded = /* @__PURE__ */ new Set();
	/** Record or clear one session's "pressed and the registry refused" state. */
	const markUnrecorded = (sessionId, flag) => {
		if (flag) unrecorded.add(sessionId);
		else unrecorded.delete(sessionId);
	};
	/** Per-episode tree walks; an entry lives exactly as long as the park owns it. */
	const walks = /* @__PURE__ */ new Map();
	/**
	* Whether a session has unfinished work right now. Three real answers, any
	* of which is enough: the loop says it is driving the session, the activity
	* fold sees a tool in flight or a turn open, or the inbox holds a delivery
	* the loop has not claimed yet.
	*/
	const running = (agent) => {
		if (agent.status === "running") return true;
		const activity = watch.activity(agent.id);
		if (activity.turnOpen || activity.runningTools.length > 0) return true;
		return agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0;
	};
	/**
	* Read one session's subagent tree through the shared walker and remember the
	* reading for this park episode. The tree is a fact about the episode, not
	* about the moment it was asked, and the aggregate reads several sessions per
	* answer; the cache keeps that read from repeating a catalog round-trip it
	* has already paid for.
	*/
	const walkTree = async (sessionId, signal) => {
		signal?.throwIfAborted();
		const cached = walks.get(sessionId);
		if (cached !== void 0) return cached;
		const reading = ctx.get("subagents") === void 0 ? {
			members: [],
			unresumable: false,
			unread: true
		} : readingOf(await walkDescendants(ctx, sessionId, signal));
		walks.set(sessionId, reading);
		return reading;
	};
	/**
	* Every running session and every descendant of one, minus the sessions this
	* pause already owns. Descendants are walked whether or not they are live
	* right now: the tree is the unit the user asked to stop. A member this host
	* has no live session for has nothing to hold and nothing to flush, and the
	* press leaves it alone rather than record a park that could never finish
	* (see `./control.ts`).
	*/
	const runningTargets = async (signal) => {
		const found = /* @__PURE__ */ new Set();
		for (const agent of ctx.agents.list()) if (running(agent)) found.add(agent.id);
		for (const root of [...found]) for (const member of (await walkTree(root, signal)).members) found.add(member);
		return [...found].filter((sessionId) => !deps.isPaused(sessionId));
	};
	/**
	* Live jobs of the registered trees, plus the unowned ones every caller sees.
	*
	* One registry walk per owner is the whole answer the jobs contract allows:
	* `list()` with no caller answers with unowned jobs only, and `list(owner)`
	* answers for exactly one owner, because the registry preflights ownership
	* instead of letting a reader enumerate another session's work.
	*/
	const liveJobs = (owners) => {
		const jobs = ctx.get("jobs");
		if (jobs === void 0) return [];
		const seen = /* @__PURE__ */ new Set();
		const collect = (owner) => {
			for (const view of owner === void 0 ? jobs.list() : jobs.list(owner)) {
				if (view.status !== "running" && view.status !== "stopping") continue;
				seen.add(String(view.id));
			}
		};
		collect();
		for (const owner of owners) collect(owner);
		return [...seen];
	};
	/**
	* The aggregate. Every registered session is accounted for: the ones on
	* their way, the ones that will not get there in this process, the trees
	* that hold work a restart cannot resume, and the jobs nothing here can stop.
	* The park also names the session it belongs to, so a client can address its
	* reads there rather than at whatever session it is showing.
	*/
	const status = async (signal) => {
		const phases = /* @__PURE__ */ new Map();
		for (const [sessionId, record] of registry.parked) phases.set(sessionId, {
			phase: record.phase,
			moving: false
		});
		const live = deps.live();
		for (const [sessionId, park] of live) phases.set(sessionId, park);
		for (const sessionId of unrecorded) phases.set(sessionId, {
			phase: "draining",
			moving: false
		});
		const unheld = deps.unheld();
		for (const sessionId of [...walks.keys()]) if (!phases.has(sessionId)) walks.delete(sessionId);
		let safe = 0;
		let parking = 0;
		const draining = [];
		const stalled = [];
		for (const [sessionId, park] of phases) {
			if (unheld.has(sessionId)) {
				stalled.push(String(sessionId));
				continue;
			}
			if (park.phase === "safe") {
				safe += 1;
				continue;
			}
			(park.moving ? draining : stalled).push(String(sessionId));
			if (park.moving && park.phase === "parking") parking += 1;
		}
		const unresumable = [];
		const unreadTrees = [];
		const owners = [...phases.keys()];
		const parkedAt = owners.find((sessionId) => !unheld.has(sessionId)) ?? owners[0];
		const trees = await Promise.all(owners.map(async (sessionId) => [sessionId, await walkTree(sessionId, signal)]));
		for (const [sessionId, tree] of trees) {
			if (tree.unresumable) unresumable.push(String(sessionId));
			if (tree.unread) unreadTrees.push(String(sessionId));
		}
		const blind = [];
		if (ctx.get("subagents") === void 0) blind.push("trees");
		if (ctx.get("jobs") === void 0) blind.push("jobs");
		const registered = phases.size;
		return {
			verdict: registered === 0 ? "idle" : safe === registered && unreadTrees.length === 0 ? "safe" : "waiting",
			registered,
			safe,
			...parkedAt === void 0 ? {} : { parkedAt: String(parkedAt) },
			draining: draining.sort(),
			parking,
			stalled: stalled.sort(),
			unresumable: unresumable.sort(),
			unreadTrees: unreadTrees.sort(),
			jobs: liveJobs(owners),
			blind
		};
	};
	return {
		pressAll: async (signal) => {
			for (let round = 0; round < PRESS_ROUNDS; round += 1) {
				const targets = await runningTargets(signal);
				if (targets.length === 0) break;
				for (const sessionId of targets) {
					signal?.throwIfAborted();
					switch (await deps.press(sessionId, signal)) {
						case "registered":
							markUnrecorded(sessionId, false);
							deps.look(sessionId);
							break;
						case "unrecordable":
							markUnrecorded(sessionId, true);
							break;
						default: break;
					}
				}
			}
			const aggregate = await status(signal);
			const answer = aggregate.verdict === "safe" ? "Every session is paused." : aggregate.verdict === "idle" ? "Nothing is running." : "Pausing is in progress.";
			return unrecorded.size === 0 ? {
				kind: "success",
				text: answer
			} : {
				kind: "error",
				text: answer
			};
		},
		readState: async (signal) => await status(signal),
		markUnrecorded
	};
}
//#endregion
//#region lib/types/resume.js
/**
* The clean resume path: bring back a session a previous process parked, and
* let it answer the input that was already pending when it stopped.
*
* A resume invents no turn. At the park point the loop had claimed the
* session's pending input onto the surface and built the request the gate then
* held; after a restart that input is still the last thing the session says and
* the model still owes it an answer. What is missing is only a reason for the
* loop to build a request again, and the documented way to ask for one is a
* wake input — a user message the loop claims.
*
* The wake is invisible only on the routes the composition declares in
* `silentWakeRoutes`, whose conversion drops an empty user message. On every
* other route the loop's request carries one visible marker instead, and the
* marker reaches the model; that is an accepted cost of resuming at all.
* Whether an empty user message survives is a property of the route's
* conversion rather than of the loop, so the route is resolved per session —
* from the request header the session itself persisted.
*
* The wake message is attributed to this plugin, never to the user: it is text
* this module synthesized on the session's behalf, in the session's own log and
* in front of the model, and a downstream consumer has to be able to tell it
* apart from something the human typed.
*
* Only a cleanly parked session takes this path. A record that never reached
* the park point, or whose flush did not finish, describes work whose durable
* state nobody knows; waking it would spend its owner's money on a guess, and
* deciding those sessions is the morning list's job, not this path's. That
* holds whether or not the recorded session happens to be live in this process:
* liveness is not the park outcome, and a session can be live without ever
* having stopped.
* @module dsh-pause-session/resume
*/
/**
* The one wake content a route that keeps an empty user message is given. It
* names its producer, because it lands in the same user turn as the input the
* model owes an answer to and must not read as part of it.
*/
const WAKE_MARKER = "[pause: resumed from a pause]";
/** Result copy for a resumed session; the model never sees it. */
const RESUMED_TEXT = "This session resumed from where it paused.";
/**
* Result copy for a registered session this path refuses: its durable state is
* not the outcome of a completed park, so waking it would be a guess.
*/
const UNCLEAN_TEXT = "pause did not resume this session: its pause did not finish cleanly, so it needs your decision.";
/** Result copy when nothing is parked under that session. */
const NOT_PARKED_TEXT = "pause has no pause recorded for this session.";
/** Result copy for a session that is parked but could not be loaded back. */
const ACTIVATION_FAILED_TEXT = "pause could not reopen this session, so it stayed paused.";
/** Result copy for a one-shot subagent route: its Session exists, but no resume may reactivate it. */
const UNRESUMABLE_TEXT = "pause did not resume this session: it is a one-shot subagent route and cannot be resumed.";
/**
* Result copy for the review decision. It is the one answer that promises
* nothing happened, because opening a session to read it is the user's own
* action in their session list — and activating its agent here would start a
* session they asked only to look at.
*/
const REVIEW_TEXT = "pause did not activate this session: it is still parked, and nothing was sent to a model. Open it from your session list when you want to read it.";
/** Result copy for a change the durable registry refused to record. */
const UNRECORDED_TEXT$1 = "pause could not write the pause registry, so it did not change the pause state.";
/** Copy for one goal opt-out change. */
const REARM_GOAL_ON_TEXT = "pause will re-open this session's goal when it resumes it.";
const REARM_GOAL_OFF_TEXT = "pause will leave this session's goal closed when it resumes it.";
/**
* How one tree-wide release answers the person who pressed it. One release, one
* sentence about all of it: what came back, and — by name, because those rows
* are what the morning list is for — what did not.
* @param released - the sessions this release covered, in release order.
* @returns the result text, e.g. `pause resumed 2 sessions from where they stopped; "child" did not pause completely`.
*/
function summarizeTreeRelease(released) {
	const resumed = released.filter((attempt) => attempt.resumed).length;
	const head = resumed === 0 ? "pause resumed nothing from this tree" : resumed === 1 ? "pause resumed 1 session from where it stopped" : `pause resumed ${resumed} sessions from where they stopped`;
	const refused = released.filter((attempt) => !attempt.resumed);
	if (refused.length === 0) return `${head}.`;
	const named = refused.filter((attempt) => attempt.refusal === "not-clean").map((attempt) => `"${String(attempt.sessionId)}"`);
	return `${head}; ${named.length === 0 ? `${String(refused.length)} could not be resumed` : refused.length === named.length ? `${named.join(", ")} did not pause completely` : `${named.join(", ")} did not pause completely, and ${String(refused.length - named.length)} more could not be resumed`}.`;
}
/**
* Build the clean resume path.
* @param ctx - host context carrying the agent store, the session store, and the goal service when one is mounted.
* @param gate - the pause gate the resume releases.
* @param registry - the durable list this path reads and forgets from.
* @param options - the route knowledge the wake content depends on.
* @param deps - the control-owned release order and the adopted-pause fact.
* @returns the path the session control exposes.
*/
function installResumePath(ctx, gate, registry, options, deps) {
	/** The route the session's next request will use, as its own log recorded it. */
	const routeOf = (session) => session.requestHeader()?.config;
	/**
	* Give an agent that was loaded back without one the route its own log
	* recorded. The loop refuses to build a request without a provider and model,
	* and the persisted header is what the app's own activation path uses too, so
	* this resumes onto the route the session stopped on.
	*
	* 0.2.2 replaced the installed route selection with the durable model-selection
	* fold: `agent.model.current()` already returns a route replayed from the
	* Session's own request headers, and `select()` records the header's route when
	* that fold and the Agent options are both empty. The old per-agent
	* `installModelSelection(agentCtx, selection)` no longer accepts a selection.
	*/
	const ensureRoute = (agent) => {
		if (agent.model.current() !== void 0) return;
		const config = routeOf(agent.session);
		if (config === void 0) return;
		agent.model.select({
			provider: config.provider,
			model: config.model,
			...config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort }
		});
	};
	/** What one wake input carries for the route in use. */
	const wakeContent = (provider) => options.silentWakeRoutes.includes(provider) ? [] : [{
		type: "text",
		text: WAKE_MARKER
	}];
	/**
	* Ask the loop for the request it owes this session. Nothing is woken when a
	* request is already standing at the gate or the loop is already running: the
	* continuation is in flight, and a second wake would duplicate it. The content
	* is the route's business only for the silent wake; a note is the user's
	* decision and goes on the wire as written, on every route. Either way the
	* message is attributed to this plugin: the wake is this path speaking on the
	* session's behalf, not the user's own input.
	* @param agent - the live agent to wake.
	* @param request - which wake this resume delivers.
	*/
	const wake = (agent, request) => {
		if (request.kind === "none") return;
		if (gate.isHeld(agent.id) || agent.status !== "idle") return;
		if (!owesReply(agent.session.deriveMessages())) return;
		const provider = routeOf(agent.session)?.provider;
		if (provider === void 0) return;
		const content = request.kind === "message" ? [{
			type: "text",
			text: request.text
		}] : wakeContent(provider);
		agent.followup(createUserMessage({
			content,
			source: { kind: "pause" }
		}));
	};
	/**
	* Re-open one session's goal. Activation is process-local and is not part of
	* the durable goal, so a restart leaves a healthy goal disarmed; only that
	* case is repaired here. A goal the owner paused, blocked, or completed is a
	* decision, and this path does not take decisions back. The wake (when there
	* is one) runs first on purpose: the goal round driver queues the next round
	* as soon as the agent is idle, and that round must not join the request that
	* is answering the input already pending.
	* @param agent - the agent whose goal may be re-armed.
	*/
	const rearmGoal = (agent) => {
		const goals = ctx.get("goals");
		if (goals === void 0) return;
		try {
			const goal = goals.get(agent);
			if (goal === void 0 || goal.phase !== "active" || goal.activation !== "disarmed") return;
			if (goal.roundsStarted >= goal.maxGoalRounds) return;
			goals.resume(agent, {
				id: goal.id,
				revision: goal.revision
			});
		} catch (error) {
			ctx.logger.warn(`pause: could not re-open the goal of "${agent.id}": ${describeError(error)}`);
		}
	};
	/**
	* Load one parked session back from its stored log and hand it the request it
	* stopped in front of. The pause is not released until the durable record is
	* gone, so a record that cannot be dropped leaves the session parked rather
	* than silently running.
	*
	* Activation is what makes a session run again, so nothing but a resume does
	* it: the review answer never reaches this function.
	* @param sessionId - the parked session to bring back.
	* @param request - which wake the decision delivers; see {@link WakeRequest}.
	* @param rearm - whether the record's goal opt-out allows re-opening its goal.
	* @param parentId - the direct parent a batch release already brought back,
	* when there is one. A subagent child resumed under its live parent is the
	* shape the harness's own cold resume uses; with no live parent the session
	* comes back on its own, which is all that can be done with it.
	* @param signal - cancellation for the stored composition read and load.
	*/
	const activate = async (sessionId, request, rearm, parentId, signal) => {
		const parent = parentId === void 0 ? void 0 : ctx.agents.get(parentId);
		let agent;
		try {
			const composition = await restoreComposition(ctx, sessionId, parent, signal);
			agent = (await ctx.root.agents.resume({
				resumeSessionId: sessionId,
				...parent === void 0 ? {} : { parentAgent: parent },
				...composition,
				...signal === void 0 ? {} : { signal }
			})).agent;
		} catch (error) {
			if (error instanceof UnresumableSessionError) return {
				sessionId,
				resumed: false,
				refusal: "unresumable",
				answer: {
					kind: "error",
					text: UNRESUMABLE_TEXT
				}
			};
			ctx.logger.warn(`pause: could not open "${sessionId}" from its stored log: ${describeError(error)}`);
			return {
				sessionId,
				resumed: false,
				refusal: "activation-failed",
				answer: {
					kind: "error",
					text: ACTIVATION_FAILED_TEXT
				}
			};
		}
		ensureRoute(agent);
		wake(agent, request);
		try {
			await registry.forget(sessionId);
		} catch (error) {
			ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
			return {
				sessionId,
				resumed: false,
				refusal: "unrecorded",
				answer: {
					kind: "error",
					text: UNRECORDED_TEXT$1
				}
			};
		}
		gate.resume(sessionId);
		if (rearm) rearmGoal(agent);
		return {
			sessionId,
			resumed: true,
			answer: {
				kind: "success",
				text: RESUMED_TEXT
			}
		};
	};
	/**
	* Load one unclean session back from its stored log.
	*
	* This is the morning list's own entry point, and it exists precisely because
	* the clean path must keep refusing these records: the refusal is the clean
	* path's guarantee, not a guard this entry can borrow. A user who has read the
	* row and chosen one of the decisions that resume it has made the decision the
	* clean path is not allowed to make for them. The release order is the same
	* one: the durable record goes first, then the gate — so a record that cannot
	* be dropped leaves the session parked.
	*
	* A record this process holds no gate for is still this list's to clear: the
	* session is live, so the decision's own wake is what asks for its request,
	* and dropping the record is what stops a later process from re-holding a
	* session the user has already decided.
	* @param sessionId - the listed session to bring back.
	* @param request - which wake the decision delivers; see {@link WakeRequest}.
	* @param finalize - whether the decision continues the session (`'release'`)
	* or only answers it (`'review'`); a review activates nothing and writes
	* nothing.
	* @param parentId - the direct parent a batch release already brought back, when there is one.
	* @param signal - cancellation for the cold load and setup.
	* @returns what happened, and the copy for whoever asked.
	*/
	const decideUnclean = async (sessionId, request, finalize, parentId, signal) => {
		const record = registry.get(sessionId);
		if (record === void 0) return {
			sessionId,
			resumed: false,
			refusal: "not-parked",
			answer: {
				kind: "success",
				text: NOT_PARKED_TEXT
			}
		};
		if (finalize === "review") return {
			sessionId,
			resumed: false,
			refusal: "not-activated",
			answer: {
				kind: "success",
				text: REVIEW_TEXT
			}
		};
		const live = ctx.agents.get(sessionId);
		if (live === void 0) return await activate(sessionId, request, record.rearmGoal, parentId, signal);
		if (!gate.isPaused(sessionId)) {
			ensureRoute(live);
			wake(live, request);
			try {
				await registry.forget(sessionId);
			} catch (error) {
				ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
				return {
					sessionId,
					resumed: false,
					refusal: "unrecorded",
					answer: {
						kind: "error",
						text: UNRECORDED_TEXT$1
					}
				};
			}
			if (record.rearmGoal) rearmGoal(live);
			return {
				sessionId,
				resumed: true,
				answer: {
					kind: "success",
					text: RESUMED_TEXT
				}
			};
		}
		const adopted = deps.adopted(sessionId);
		if (adopted) {
			ensureRoute(live);
			wake(live, request);
		}
		const released = await deps.release(sessionId, RESUMED_TEXT);
		if (released.kind === "error") return {
			sessionId,
			resumed: false,
			refusal: "unrecorded",
			answer: released
		};
		if (adopted && record.rearmGoal) rearmGoal(live);
		return {
			sessionId,
			resumed: true,
			answer: released
		};
	};
	/**
	* Resume one recorded session: the clean path's only entry point.
	*
	* The clean-only rule holds on every branch, live or not: a record that is
	* not `safe` is not a park that finished, so this path neither wakes it nor
	* drops it — whoever holds it stays held, and the row reaches the morning
	* list. A pause this process pressed itself is not a record at all: taking it
	* back is the press's own undo, and it delivers no wake.
	* @param sessionId - the recorded session to resume.
	* @param request - which wake this resume delivers; see {@link WakeRequest}.
	* @param parentId - the direct parent a batch release already brought back, when there is one.
	* @param signal - cancellation for the cold load and setup.
	* @returns what happened, and the copy for whoever asked.
	*/
	const resumeSession = async (sessionId, request, parentId, signal) => {
		const record = registry.get(sessionId);
		const live = ctx.agents.get(sessionId);
		if (live !== void 0) {
			if (!gate.isPaused(sessionId)) {
				if (record !== void 0 && record.phase !== "safe") return {
					sessionId,
					resumed: false,
					refusal: "not-clean",
					answer: {
						kind: "error",
						text: UNCLEAN_TEXT
					}
				};
				if (record === void 0) return {
					sessionId,
					resumed: false,
					refusal: "not-parked",
					answer: {
						kind: "success",
						text: NOT_PARKED_TEXT
					}
				};
				try {
					await registry.forget(sessionId);
				} catch (error) {
					ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
					return {
						sessionId,
						resumed: false,
						refusal: "unrecorded",
						answer: {
							kind: "error",
							text: UNRECORDED_TEXT$1
						}
					};
				}
				ensureRoute(live);
				wake(live, request);
				if (record.rearmGoal) rearmGoal(live);
				return {
					sessionId,
					resumed: true,
					answer: {
						kind: "success",
						text: RESUMED_TEXT
					}
				};
			}
			const adopted = deps.adopted(sessionId);
			if (adopted && record !== void 0 && record.phase !== "safe") return {
				sessionId,
				resumed: false,
				refusal: "not-clean",
				answer: {
					kind: "error",
					text: UNCLEAN_TEXT
				}
			};
			if (adopted) {
				ensureRoute(live);
				wake(live, request);
			}
			const released = await deps.release(sessionId, RESUMED_TEXT);
			if (released.kind === "error") return {
				sessionId,
				resumed: false,
				refusal: "unrecorded",
				answer: released
			};
			if (adopted && (record?.rearmGoal ?? true)) rearmGoal(live);
			return {
				sessionId,
				resumed: true,
				answer: released
			};
		}
		if (record === void 0) return {
			sessionId,
			resumed: false,
			refusal: "not-parked",
			answer: {
				kind: "success",
				text: NOT_PARKED_TEXT
			}
		};
		if (record.phase !== "safe") return {
			sessionId,
			resumed: false,
			refusal: "not-clean",
			answer: {
				kind: "error",
				text: UNCLEAN_TEXT
			}
		};
		return await activate(sessionId, request, record.rearmGoal, parentId, signal);
	};
	/**
	* Order the recorded sessions so a session is released after the parent it
	* hangs from: waking a child needs its direct parent to be live first. The
	* relation is read from the parent catalogs themselves (which children this
	* session actually has), never guessed from ids; a branch whose catalog
	* cannot be read simply has no known parent and is released with the roots.
	* @param sessionIds - every recorded session, in registry order.
	* @param signal - cancellation for each catalog read.
	* @returns the parent of each child, and one list per depth level, shallowest first.
	*/
	const releaseOrder = async (sessionIds, signal) => {
		const owned = new Set(sessionIds);
		const parentOf = /* @__PURE__ */ new Map();
		const subagents = ctx.get("subagents");
		if (subagents !== void 0) for (const sessionId of sessionIds) {
			signal?.throwIfAborted();
			try {
				for (const child of await subagents.listChildren(sessionId, signal)) if (owned.has(child.id)) parentOf.set(child.id, sessionId);
			} catch (error) {
				if (signal?.aborted === true) throw error;
				ctx.logger.warn(`pause: could not read the children of "${sessionId}": ${describeError(error)}`);
			}
		}
		const depthOf = (sessionId) => {
			let steps = 0;
			const seen = /* @__PURE__ */ new Set([sessionId]);
			for (let at = parentOf.get(sessionId); at !== void 0; at = parentOf.get(at)) {
				if (seen.has(at)) break;
				seen.add(at);
				steps += 1;
			}
			return steps;
		};
		const levels = /* @__PURE__ */ new Map();
		for (const sessionId of sessionIds) {
			const level = depthOf(sessionId);
			const bucket = levels.get(level);
			if (bucket === void 0) levels.set(level, [sessionId]);
			else bucket.push(sessionId);
		}
		return {
			parents: parentOf,
			levels: [...levels.keys()].sort((left, right) => left - right).map((level) => levels.get(level) ?? [])
		};
	};
	return {
		resumeSession,
		decideUnclean,
		releaseTree: async (sessionId, signal) => {
			const registered = [sessionId, ...(await walkDescendants(ctx, sessionId, signal)).members.map((member) => member.id)].filter((member) => registry.get(member) !== void 0);
			if (registered.length === 0) return {
				members: 0,
				resumed: 0,
				refusals: [],
				answer: {
					kind: "success",
					text: NOT_PARKED_TEXT
				}
			};
			const cancelling = registered.every((member) => registry.get(member)?.phase !== "safe");
			const released = [];
			if (cancelling) for (const member of registered) {
				signal?.throwIfAborted();
				const answer = await deps.release(member, RESUMED_TEXT);
				released.push(answer.kind === "error" ? {
					sessionId: member,
					resumed: false,
					refusal: "unrecorded",
					answer
				} : {
					sessionId: member,
					resumed: true,
					answer
				});
			}
			else {
				const release = await releaseOrder(registered, signal);
				for (const level of release.levels) {
					signal?.throwIfAborted();
					for (const member of level) {
						const record = registry.get(member);
						if (record !== void 0 && record.phase !== "safe") {
							released.push({
								sessionId: member,
								resumed: false,
								refusal: "not-clean",
								answer: {
									kind: "error",
									text: UNCLEAN_TEXT
								}
							});
							continue;
						}
						released.push(await resumeSession(member, { kind: "silent" }, release.parents.get(member), signal));
					}
				}
			}
			const root = released.find((attempt) => attempt.sessionId === sessionId);
			const refusals = released.filter((attempt) => !attempt.resumed && attempt.refusal !== void 0).map((attempt) => ({
				sessionId: attempt.sessionId,
				refusal: attempt.refusal
			}));
			return {
				members: released.length,
				resumed: released.filter((attempt) => attempt.resumed).length,
				refusals,
				answer: root === void 0 ? {
					kind: "success",
					text: NOT_PARKED_TEXT
				} : {
					kind: refusals.length === 0 && root.resumed ? "success" : "error",
					text: summarizeTreeRelease(released)
				}
			};
		},
		resumeParked: async (signal) => {
			const release = await releaseOrder(registry.list().map((entry) => entry.sessionId), signal);
			const attempts = [];
			for (const level of release.levels) {
				signal?.throwIfAborted();
				attempts.push(...await Promise.all(level.map((sessionId) => resumeSession(sessionId, { kind: "silent" }, release.parents.get(sessionId), signal))));
			}
			return attempts;
		},
		setRearmGoal: async (sessionId, rearmGoal) => {
			try {
				await registry.setRearmGoal(sessionId, rearmGoal);
			} catch (error) {
				ctx.logger.warn(`pause: could not record the goal opt-out of "${sessionId}": ${describeError(error)}`);
				return {
					kind: "error",
					text: UNRECORDED_TEXT$1
				};
			}
			return {
				kind: "success",
				text: rearmGoal ? REARM_GOAL_ON_TEXT : REARM_GOAL_OFF_TEXT
			};
		}
	};
}
//#endregion
//#region lib/types/triage.js
/**
* The morning decision list: every session that did not stop cleanly, the facts
* its own log carries about where it stopped, and the listed verbs the user can
* take on it.
*
* A session gets here by NOT being on the clean path. A record whose phase is
* `safe` is woken silently by `./resume.ts` and never appears here; the other
* three phases describe work nobody can vouch for, and guessing on them would
* spend the owner's money on a guess. This module is the other half of that
* rule, not a second copy of it: the reading is taken from the session's own
* stored log through a read handle that claims no ownership and writes nothing,
* so asking what happened cannot itself change what happened.
*
* WHAT ONE READ COSTS. The list is read when the panel opens and when a native
* action changes the park, and what it publishes is about the end of a log that
* only grows, so `./coldlog.ts` bounds each row's read to that end. A row whose
* facts the bound cannot hold reports itself unreadable rather than publishing
* a fragment.
*
* WHAT A ROW REPORTS. "Where it stopped" is the last event of the stored log
* with the turn and step it belongs to. "Which tool was in flight" is the
* `tool/call` events that no durable `tool/result` answers — a call event is
* only written once the loop reached the dispatch, so an unanswered one is
* exactly a tool the real world ran and the log never heard back from. The
* harness turns each of those into a synthetic `TOOL_OUTCOME_UNKNOWN` error
* result when it next reads the log; this module derives the same answer from
* the stored events instead of writing it back. Nothing here is inferred from
* the fact that the session is listed.
*
* WHAT THE ROW PROMISES. `wake` says the host can hand this session the request
* it owes, and the wake that keeps that promise is `./resume.ts`'s. Both read
* one rule from `./history.ts` over the same derivation the loop reads, so a
* promise this list publishes is a promise that wake keeps. When the log cannot
* be folded into that derivation, the promise is withheld and the reading is
* reported; a withheld promise costs a user nothing, a broken one spends their
* money.
*
* WHO MAY DECIDE. A decision carries the calling session and its target as wire
* input, so this list acts only on rows its most recent read published to the
* calling session: the caller's own read is what makes a target actionable.
* Anything else is refused, not looked up.
*
* TWO OF THE FIVE VERBS PUT THE SESSION BACK ON THE CLEAN PATH. Continue and
* continue-with-the-note go through `ResumePath.decideUnclean`, which activates
* the session, wakes it and drops the durable record before the gate opens.
*
* THE OTHER THREE TOUCH NOTHING. Leave writes nothing at all: the record stays,
* the session stays held, and the row is still on tomorrow's list. Review
* answers without activating anything or writing anything — opening a session
* to read it is the user's own action in their session history, and starting an
* agent on their behalf is precisely what they declined. Goal flips the row's
* own re-arm opt-out: it is the user path for the one thing a resume can spend
* without the user watching it, and it takes effect on whatever resume comes
* next. All five carry the same binding — the row must be one this caller was
* shown — because each changes, or declines to change, durable state of a
* parked session.
* @module dsh-pause-session/triage
*/
/** Result copy for leaving one listed session alone. */
const TRIAGE_LEFT_TEXT = "pause left this session paused; it is still on the list.";
/** Result copy for a decision aimed at a session that is not on the list. */
const TRIAGE_NOT_LISTED_TEXT = "pause has no unfinished pause for this session.";
/**
* Result copy for a decision aimed at a row the calling session was not shown.
* The list is the only thing that legitimizes a target, so a target nobody read
* is refused rather than acted on.
*/
const TRIAGE_UNSHOWN_TEXT = "pause did not act: this Session has not been shown that row. Read the decision list first.";
/**
* Model-facing text that goes with a wake when the user chooses to continue
* with a note.
*
* It is written the way the harness writes its own recovery text: the same two
* facts the synthetic tool result states (the call's outcome was never recorded;
* verify before retrying anything with side effects), in the same voice, with no
* mention of the stop mechanism. The harness's own version lives in the tool
* result for that call, which is why this one does not repeat the call's name —
* it warns about the step as a whole, and the specific result sits directly
* above it in the history.
*/
const UNKNOWN_OUTCOME_NOTE = "A tool call from this step was interrupted: its call was recorded but no result was durably recorded, so its outcome is unknown. If it had side effects, verify the external state before doing anything else, and do not retry it blindly. Then continue with what I asked for.";
/**
* One row's facts, as the session's own log reports them.
* @param ctx - host context carrying the registered message projections.
* @param entry - the durable park record this row is built from.
* @param events - the events the bounded read returned, in sequence order.
* @param complete - whether those events are the whole stored log.
* @returns the row, ready to publish, or `undefined` when the read cannot support it.
*/
function rowOf(ctx, entry, events, complete) {
	const { sessionId, phase, updatedAt, rearmGoal } = entry;
	const facts = logFacts(events, complete, ctx.sessions.messageProjections);
	if (facts === void 0) return void 0;
	const { last, traces, owed, wakeable } = facts;
	return {
		sessionId: String(sessionId),
		phase,
		updatedAt,
		reading: "read",
		...last === void 0 ? {} : {
			lastEvent: last.type,
			...positionOf(last)
		},
		traces,
		owed,
		rearmGoal,
		wakeable
	};
}
/**
* Mount the decision list over the durable registry and the clean resume path.
*
* The list is the registry's own complement: it asks for every record whose
* phase is not `safe`, so a session that cleaned up is off the list by the same
* fact that puts it on the silent path, and nothing has to be reconciled.
* @param ctx - host context carrying the optional persistence service.
* @param registry - the durable list of park outcomes.
* @param resumePath - the path all three resuming decisions go through.
* @param windowEvents - how many events of each stored log one read may fold.
* @returns the list read and the decision verbs.
*/
function mountTriageList(ctx, registry, resumePath, windowEvents = TRIAGE_WINDOW_EVENTS) {
	/**
	* The rows each calling session was last shown by its own read. A decision
	* names its target as command input, and the command channel carries no
	* origin of its own, so this is what ties a target to the list the user read:
	* only a row this caller has been shown is acted on.
	*/
	const shown = /* @__PURE__ */ new Map();
	const unreadable = (entry) => ({
		sessionId: String(entry.sessionId),
		phase: entry.phase,
		updatedAt: entry.updatedAt,
		reading: "unreadable",
		traces: [],
		owed: false,
		wakeable: false,
		rearmGoal: entry.rearmGoal
	});
	const readable = async (entry, signal) => {
		const read = await coldRead(ctx, entry.sessionId, windowEvents, signal);
		if (read.kind === "unreadable") return unreadable(entry);
		return rowOf(ctx, entry, read.events, read.complete) ?? unreadable(entry);
	};
	/**
	* One decision, as the resume path's own verbs plus the two local verbs that
	* change nothing but the record. Review is the list's own "do not run it"
	* answer: it activates nothing and writes nothing, so the park is exactly as
	* it was. The goal toggle is the user path for the one thing a resume can
	* spend unasked.
	*/
	const decide = async (caller, sessionId, action, signal) => {
		if (!(shown.get(caller)?.has(String(sessionId)) ?? false)) return {
			kind: "error",
			text: TRIAGE_UNSHOWN_TEXT
		};
		const record = registry.get(sessionId);
		if (record === void 0 || record.phase === "safe") return {
			kind: "error",
			text: TRIAGE_NOT_LISTED_TEXT
		};
		if (action === "leave") return {
			kind: "success",
			text: TRIAGE_LEFT_TEXT
		};
		if (action === "goal") return await resumePath.setRearmGoal(sessionId, !record.rearmGoal);
		if (action === "review") return (await resumePath.decideUnclean(sessionId, { kind: "none" }, "review", void 0, signal)).answer;
		const wake = action === "continue" ? { kind: "silent" } : {
			kind: "message",
			text: UNKNOWN_OUTCOME_NOTE
		};
		return (await resumePath.decideUnclean(sessionId, wake, "release", void 0, signal)).answer;
	};
	return {
		read: async (caller, signal) => {
			signal?.throwIfAborted();
			const rows = await Promise.all([...registry.parked.values()].flatMap((entry) => entry.phase === "safe" ? [] : [readable({
				...entry,
				phase: entry.phase
			}, signal)]));
			shown.set(caller, new Set(rows.map((row) => row.sessionId)));
			return { rows };
		},
		decide
	};
}
//#endregion
//#region lib/types/control.js
/**
* The session control the browser half drives: the pause verb, the park state
* machine behind it, and the live state channel that accompanies both.
*
* The host exposes this control through the native Typert Remote namespace:
* `observe` streams snapshots and `act` / `triage` / `decide` drive the UI. No
* slash command is registered. Phase changes wake the Remote stream through a
* local listener set; the durable registry remains the source of truth for what
* the snapshot reports.
* @module dsh-pause-session/control
*/
/** Result copy for a press or a release the durable registry refused to record. */
const UNRECORDED_TEXT = "pause could not write the pause registry, so it did not change the pause state.";
/**
* Whether this host can read one recorded session at all — a live session, or a
* stored log the persistence backend can observe.
* @param ctx - host context carrying the session store and the optional persistence service.
* @param sessionId - the recorded session to look for.
* @returns whether the session can be acted on here.
*/
async function sessionReadable(ctx, sessionId) {
	if (ctx.sessions.get(sessionId) !== void 0) return true;
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return false;
	try {
		return await persistence.stat(sessionId) !== void 0;
	} catch (error) {
		ctx.logger.warn(`pause: could not look for the stored log of "${sessionId}": ${describeError(error)}`);
		return true;
	}
}
/** How resuming all parked sessions answers the command that asked for it. */
function summarizeResume(attempts) {
	const resumed = attempts.filter((attempt) => attempt.resumed).length;
	const refused = attempts.length - resumed;
	const head = resumed === 0 ? "pause resumed no session" : resumed === 1 ? "pause resumed 1 session from where it stopped" : `pause resumed ${resumed} sessions from where they stopped`;
	if (refused === 0) return `${head}.`;
	return `${head}; ${attempts.filter((attempt) => attempt.refusal === "not-clean").length === refused ? `${refused} did not pause completely and need your decision` : `${refused} could not be resumed`}.`;
}
/**
* Contribute the session control: the pause verb, the per-session status read,
* the global resume verb, and — for every paused session that has a live agent
* — the resume marker.
* @param ctx - host context carrying the command registry, the agent store, the
* session store, and the projection registry.
* @param gate - the pause gate this control drives and reflects.
* @param watch - the per-session activity fold the park predicate reads.
* @param registry - the durable pause list every phase change is written to.
* @param options - route knowledge the clean resume path needs, and the decision list's read bound.
* @returns the mount-time adoption step and the morning resume path.
*/
function installSessionControl(ctx, gate, watch, registry, options) {
	/** Marks per paused session; presence here mirrors the gate's own membership. */
	const marks = /* @__PURE__ */ new Map();
	/** Host listeners the native Remote stream wakes after a visible change. */
	const listeners = /* @__PURE__ */ new Set();
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	/**
	* Records this process did not hold again because the session behind them
	* cannot be read here. Nothing can be parked, released, or decided for them
	* from this process, so they are not marks — and the aggregate names them
	* instead of counting them among the sessions this park owns.
	*/
	const unheld = /* @__PURE__ */ new Set();
	/** Bumped by every mark and every cancel; a stale generation publishes nothing. */
	let generation = 0;
	const drop = (sessionId) => {
		marks.delete(sessionId);
		notify();
	};
	/**
	* Write one phase to the durable registry, then publish it on the mark and
	* announce it on the command channel.
	*
	* The order is the whole point: a phase is published only once a later
	* process would read it back. A failed write leaves the mark on its previous
	* phase, which is never cleaner than what the registry holds — the direction
	* that matters, because "safe to close" is a promise about surviving the
	* process, not about this process's memory.
	*
	* A phase that actually changed is also the moment every client is owed a
	* fresh read: the announcement is what carries `parking` → `safe` out of this
	* process, since the flush that resolves it changes no registration by
	* itself. Announcing only on a change is also what keeps the channel quiet —
	* a write that repeats the phase a mark already holds tells a reader nothing,
	* so it must not cost one.
	* @param sessionId - the paused session.
	* @param mark - its live mark, updated in place on success.
	* @param phase - the phase to record and publish.
	* @returns whether the phase became durable.
	*/
	const commit = async (sessionId, mark, phase) => {
		try {
			await registry.record(sessionId, phase);
		} catch (error) {
			ctx.logger.warn(`pause: could not record the park state of "${sessionId}" as ${phase}: ${describeError(error)}`);
			return false;
		}
		const changed = mark.phase !== phase;
		mark.phase = phase;
		if (changed) notify();
		return true;
	};
	/** Whether this session is standing still at the park point. */
	const parked = (sessionId) => {
		const activity = watch.activity(sessionId);
		if (activity.runningTools.length > 0) return false;
		return gate.isHeld(sessionId) || !activity.turnOpen;
	};
	/**
	* The phase a durable record holds for one session right now, whether or not
	* this process holds it. A member whose session this host cannot read still
	* has a record, and that record is the only thing anyone knows about it.
	*/
	const recordedPhase = (sessionId) => marks.get(sessionId)?.phase ?? registry.get(sessionId)?.phase;
	/**
	* The state this session's header reports: the worst phase among the members
	* the session's own press registered, folded with the session's own.
	*
	* The control speaks for a tree, so it may not say "safe to close" while a
	* member of that tree is still draining, stalled, or not readable — the user
	* would close the lid on work this press started. A branch the walk could not
	* read may hold a member nobody can see, so an unread branch counts as
	* unfinished rather than as empty.
	* @param mark - the session's own mark, whose phase the fold starts from.
	* @returns the phase to publish and the goal opt-out that rides beside it.
	*/
	const treeStatus = async (sessionId, mark, signal) => {
		const walk = await walkDescendants(ctx, sessionId, signal);
		const phases = [mark.phase];
		for (const member of walk.members) {
			const phase = recordedPhase(member.id);
			if (phase !== void 0) phases.push(phase);
		}
		for (let at = 0; at < walk.unread.length + (walk.unreadWhole ? 1 : 0); at += 1) phases.push("parking");
		const folded = foldTreePhases(phases);
		const record = registry.get(sessionId);
		return {
			phase: folded.phase,
			safe: folded.safe,
			runningTools: mark.phase === "draining" ? watch.activity(sessionId).runningTools : [],
			...record === void 0 ? {} : { rearmGoal: record.rearmGoal }
		};
	};
	/**
	* Walk one session's mark as far forward as its current activity allows.
	*
	* The move is published by `settle`, once the write that makes `parking`
	* durable has resolved; until then the mark keeps answering with `draining`,
	* which is less than the truth rather than more than the record can back.
	* @param sessionId - the marked session to re-derive.
	* @returns whether this call moved the mark out of `draining` (and so owes a flush).
	*/
	const advance = (sessionId) => {
		const mark = marks.get(sessionId);
		if (mark === void 0 || mark.phase !== "draining" || mark.advancing) return false;
		if (mark.origin === "registry") return false;
		if (!parked(sessionId)) return false;
		mark.advancing = true;
		return true;
	};
	/**
	* Flush a parked session at the session level and publish what actually
	* happened.
	*
	* The flush is the promise that survives a crash: a handle's own flush would
	* leave the routed live buffer — the pending input — in memory. `safe` is
	* therefore reserved for a flush this process ran and that resolved; a
	* session that is no longer in the store cannot be flushed at all, so its
	* park stops at the phase that says the flush never happened.
	*/
	const settle = async (sessionId, attempt) => {
		const mark = marks.get(sessionId);
		if (mark === void 0 || mark.generation !== attempt) return;
		/** Whether this attempt still owns the mark: a cancel or a newer press replaces or drops it. */
		const owned = () => marks.get(sessionId) === mark && mark.generation === attempt;
		const session = ctx.sessions.get(sessionId);
		try {
			if (session === void 0) {
				await commit(sessionId, mark, "parking");
				return;
			}
			await commit(sessionId, mark, "parking");
			if (!owned()) return;
			try {
				await ctx.sessions.flush(session);
			} catch (error) {
				if (!owned()) return;
				ctx.logger.warn(`pause: flush failed for "${sessionId}": ${describeError(error)}`);
				await commit(sessionId, mark, "flush-failed");
				return;
			}
			if (!owned()) return;
			await commit(sessionId, mark, "safe");
		} finally {
			if (marks.get(sessionId) === mark && mark.phase === "draining") mark.advancing = false;
		}
	};
	/** Look at one marked session and act on what it is doing. */
	const look = (sessionId) => {
		if (!advance(sessionId)) return;
		const attempt = marks.get(sessionId)?.generation;
		if (attempt !== void 0) settle(sessionId, attempt);
	};
	/**
	* Press one session's pause and make it durable.
	*
	* The press IS a durable promise: a pause that cannot be recorded is taken
	* back here rather than left as one a restart silently forgets. A session a
	* pause already owns is left exactly where it is — including one adopted
	* from an earlier process, whose outcome is not this process's to re-derive.
	*
	* A session with nothing live is left alone entirely. It has no request to
	* hold and no session-level flush to run, so a record for it could only be
	* one of two lies: `safe`, a park that never happened but that the clean path
	* would silently resume, or a phase that never settles, which would keep
	* "safe to close" from ever appearing. Registering the running tree therefore
	* means registering the members a pause can actually hold and flush.
	* @param sessionId - the session to pause.
	* @param signal - cancellation for the resumability read and registry write.
	* @param knownResumable - whether the caller already proved the local route is
	* `continuable` from the parent catalog, avoiding a second Session read.
	* @returns what the press did; only `registered` created a new park.
	*/
	const press = async (sessionId, signal, knownResumable = false) => {
		if (ctx.sessions.get(sessionId) === void 0) return "not-live";
		if (!knownResumable && !await isResumableSession(ctx, sessionId, signal)) return "not-resumable";
		if (!gate.pause(sessionId)) return "already-paused";
		const mark = {
			phase: "draining",
			generation: ++generation,
			origin: "press",
			advancing: false
		};
		marks.set(sessionId, mark);
		if (await commit(sessionId, mark, "draining")) {
			unheld.delete(sessionId);
			notify();
			return "registered";
		}
		drop(sessionId);
		gate.resume(sessionId);
		return "unrecordable";
	};
	/**
	* Press one session's pause and register its whole tree behind it.
	*
	* "One session's work" includes the subagents it delegated to, nested ones
	* included, and the user does not pause them one by one. So the press walks
	* the session's own catalog tree and gives every member the same durable
	* treatment the session gets: {@link press} registers what it can hold, and a
	* member whose record cannot be written is named here rather than counted as
	* paused.
	*
	* A tree the walk could not read is the one case where the press does less
	* than the tree: the session itself is still registered — the user pressed a
	* session, and its park is real — and the answer says the subagents were not
	* covered rather than counting a tree nobody read.
	* @param sessionId - the session whose tree the user pressed.
	* @returns which members are registered and which could not be.
	*/
	const pressTree = async (sessionId, signal) => {
		if (ctx.sessions.get(sessionId) === void 0) return {
			members: 0,
			registered: 0,
			rootRegistered: false,
			unrecorded: [],
			unread: false
		};
		const walk = await walkDescendants(ctx, sessionId, signal);
		if (walk.unreadWhole) {
			const pressed = await press(sessionId, signal);
			if (pressed === "registered") look(sessionId);
			globalPause.markUnrecorded(sessionId, pressed === "unrecordable");
			return {
				members: pressed === "registered" ? 1 : 0,
				registered: pressed === "registered" ? 1 : 0,
				rootRegistered: pressed === "registered",
				unrecorded: pressed === "unrecordable" ? [sessionId] : [],
				unread: true
			};
		}
		const registered = [];
		const unrecorded = [];
		const members = walk.members.filter((member) => member.mode === "continuable");
		for (const id of [sessionId, ...members.map((member) => member.id)]) {
			const pressed = await press(id, signal, id !== sessionId);
			if (pressed === "registered") {
				registered.push(id);
				look(id);
			} else if (pressed === "unrecordable") unrecorded.push(id);
			globalPause.markUnrecorded(id, pressed === "unrecordable");
		}
		return {
			members: registered.length + unrecorded.length,
			registered: registered.length,
			rootRegistered: registered.includes(sessionId),
			unrecorded,
			unread: false
		};
	};
	const sync = (sessionId) => {
		if (!gate.isPaused(sessionId)) {
			drop(sessionId);
			return;
		}
	};
	/**
	* Take the pause back: the durable record goes first, so a process that dies
	* in between does not re-hold a session the user has already released. A
	* record that cannot be dropped leaves the session paused, which is the state
	* the registry still describes.
	*/
	const release = async (sessionId, text) => {
		if (!gate.isPaused(sessionId)) return {
			kind: "success",
			text
		};
		try {
			await registry.forget(sessionId);
		} catch (error) {
			ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
			return {
				kind: "error",
				text: UNRECORDED_TEXT
			};
		}
		gate.resume(sessionId);
		notify();
		return {
			kind: "success",
			text
		};
	};
	const resumePath = installResumePath(ctx, gate, registry, options, {
		release,
		adopted: (sessionId) => marks.get(sessionId)?.origin === "registry"
	});
	const triage = mountTriageList(ctx, registry, resumePath, options.maxListedLogEvents);
	/**
	* The one handler the four decision verbs share. The list is addressed by
	* session like every other command on this channel, so the row the user
	* decided on travels as the command's own input. The calling session is what
	* makes that row a target: the list acts only on rows it published to this
	* caller, and never on a model's command.
	*/
	const globalPause = mountGlobalPause(ctx, watch, registry, {
		isPaused: (sessionId) => gate.isPaused(sessionId),
		press,
		look,
		live: () => new Map([...marks].map(([sessionId, mark]) => [sessionId, {
			phase: mark.phase,
			moving: mark.origin === "press" && mark.phase !== "flush-failed" && ctx.sessions.get(sessionId) !== void 0
		}])),
		unheld: () => unheld
	});
	/**
	* Read the whole app and every live paused session in one pass. The browser
	* status route is the only caller: it replaces the command reads that used
	* to write `command/run` and `command/done` into an address Session's log.
	* @param signal - cancellation for the tree walks and the whole-app read.
	* @returns the JSON-safe snapshot.
	*/
	const readSnapshot = async (signal) => {
		const sessions = {};
		await Promise.all([...marks].map(async ([sessionId, mark]) => {
			sessions[String(sessionId)] = await treeStatus(sessionId, mark, signal);
		}));
		return {
			global: await globalPause.readState(signal),
			sessions
		};
	};
	ctx.effect(function* () {
		yield gate.onChange((sessionId) => {
			sync(sessionId);
		});
		yield gate.onHeld((sessionId) => {
			queueMicrotask(() => {
				look(sessionId);
			});
		});
		yield watch.onChange((sessionId) => {
			look(sessionId);
		});
		yield ctx.on("agent/created", ({ agent }) => {
			sync(agent.id);
		});
		yield async () => {
			marks.clear();
		};
	}, "pause: session events");
	return {
		readSnapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		pressTree: async (sessionId, signal) => await pressTree(sessionId, signal),
		releaseTree: async (sessionId, signal) => await resumePath.releaseTree(sessionId, signal),
		pauseAll: async (signal) => {
			const answer = await globalPause.pressAll(signal);
			notify();
			return answer;
		},
		resumeAll: async (signal) => {
			const answer = {
				kind: "success",
				text: summarizeResume(await resumePath.resumeParked(signal))
			};
			notify();
			return answer;
		},
		toggleGoal: async (sessionId) => {
			const record = registry.get(sessionId);
			if (record === void 0) return {
				kind: "error",
				text: NOT_PARKED_TEXT
			};
			const answer = await resumePath.setRearmGoal(sessionId, !record.rearmGoal);
			notify();
			return answer;
		},
		readTriage: async (caller, signal) => await triage.read(caller, signal),
		decideTriage: async (caller, target, action, signal) => {
			const answer = await triage.decide(caller, target, action, signal);
			notify();
			return answer;
		},
		adopt: async () => {
			for (const entry of registry.list()) {
				if (!await sessionReadable(ctx, entry.sessionId)) {
					unheld.add(entry.sessionId);
					ctx.logger.warn(`pause: the pause recorded for "${entry.sessionId}" is not held: this host cannot read that session`);
					continue;
				}
				if (gate.pause(entry.sessionId)) marks.set(entry.sessionId, {
					phase: entry.phase,
					generation: ++generation,
					origin: "registry",
					advancing: false
				});
			}
			for (const agent of ctx.agents.list()) sync(agent.id);
		}
	};
}
//#endregion
//#region lib/types/gate.js
/**
* The pause gate: one session's hold at the model-request waterfall.
*
* The hold sits on the `llm/stream` waterfall, which is the only point that
* satisfies all four conditions at once: the previous step's tool calls have
* drained, the request is already built, the session's pending input is
* committed, and — because nothing pulls the adapter — no timer is armed
* anywhere. Machine sleep, network loss, and the adapter's stream-idle
* watchdog therefore cannot touch a parked request.
* @module dsh-pause-session/gate
*/
/** Message of the failure a held request ends with when its plugin unloads first. */
const PLUGIN_UNLOADED = "pause: plugin lifetime ended while a request was held";
/** The abort signal's own error, or a stable one when the abort carried no reason. */
function abortError(signal) {
	return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("pause: request aborted while held");
}
/** A latch without `Promise.withResolvers`, which this project's ES2022 lib predates. */
function latch() {
	let open = () => {};
	return {
		promise: new Promise((resolve) => {
			open = resolve;
		}),
		open
	};
}
/**
* Resolve once the session is released or any of `signals` aborts. No timer is
* armed: the wait ends only by release or by an abort, so a parked request
* cannot be woken by the clock. Listeners are removed once the wait settles.
*/
function raceRelease(released, signals) {
	const wake = latch();
	const onAbort = () => {
		wake.open();
	};
	const watching = signals.filter((signal) => !signal.aborted);
	if (watching.length !== signals.length) wake.open();
	for (const signal of watching) signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([released, wake.promise]).finally(() => {
		for (const signal of watching) signal.removeEventListener("abort", onAbort);
	});
}
/** Per-session pause state and the waterfall listener that enforces it. */
var PauseGate = class {
	options;
	/** Paused sessions; membership IS the pause state. */
	paused = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	heldListeners = /* @__PURE__ */ new Set();
	/**
	* @param options - the plugin-lifetime signal every held request races.
	*/
	constructor(options) {
		this.options = options;
	}
	/**
	* Subscribe to pause-state changes.
	* @param listener - called with the session whose state changed and its new state.
	* @returns the unsubscribe function.
	*/
	onChange(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/**
	* Subscribe to "a request arrived at / left the gate" for a paused session.
	*
	* This is the moment a session can become parked, so it is also the moment a
	* park observer has to look. Listeners run synchronously inside the request
	* path: they must only record that a look is owed.
	* @param listener - called with the session and whether it now holds a request.
	* @returns the unsubscribe function.
	*/
	onHeld(listener) {
		this.heldListeners.add(listener);
		return () => {
			this.heldListeners.delete(listener);
		};
	}
	/**
	* @param sessionId - session to inspect.
	* @returns whether the session is currently paused.
	*/
	isPaused(sessionId) {
		return this.paused.has(sessionId);
	}
	/**
	* @param sessionId - session to inspect.
	* @returns whether a model request of that session is waiting at the gate
	* right now. False for a session that is paused but whose loop has not built
	* its next request yet — a running tool, for instance, is still draining.
	*/
	isHeld(sessionId) {
		return (this.paused.get(sessionId)?.holding ?? 0) > 0;
	}
	/**
	* Enter one request that is about to wait. The count rises synchronously with
	* {@link hold}, so an observer notified at that moment reads `isHeld` as true.
	* @param pause - the session's pause record.
	* @returns the exit that lowers the count again.
	*/
	enter(pause) {
		pause.holding += 1;
		this.notifyHeld(pause.sessionId, true);
		return () => {
			pause.holding -= 1;
			if (pause.holding === 0) this.notifyHeld(pause.sessionId, false);
		};
	}
	/**
	* Pause one session: its next model request is held until {@link resume}. A
	* request already past the waterfall keeps running — pausing never
	* interrupts a model call or a tool call that has started.
	* @param sessionId - session to pause.
	* @returns whether this call changed the state.
	*/
	pause(sessionId) {
		if (this.paused.has(sessionId)) return false;
		const release = latch();
		this.paused.set(sessionId, {
			sessionId,
			released: release.promise,
			release: release.open,
			holding: 0
		});
		this.notify(sessionId, true);
		return true;
	}
	/**
	* Resume one session: release everything it holds and stop holding what
	* follows. The requests sent from then on are the ones built before the
	* hold, so a resumed session continues from the point it stopped.
	* @param sessionId - session to resume.
	* @returns whether this call changed the state.
	*/
	resume(sessionId) {
		const pause = this.paused.get(sessionId);
		if (pause === void 0) return false;
		this.paused.delete(sessionId);
		pause.release();
		this.notify(sessionId, false);
		return true;
	}
	/**
	* The wait one model request must finish before it may delegate, and the exit
	* that reports the request as no longer waiting.
	* @param request - the request reaching the waterfall.
	* @returns the wait plus its release, or `undefined` when this gate does not
	* hold that request.
	*/
	hold(request) {
		if (request.purpose !== void 0) return void 0;
		const sessionId = request.sessionId;
		if (sessionId === void 0) return void 0;
		const pause = this.paused.get(sessionId);
		if (pause === void 0) return void 0;
		const left = this.enter(pause);
		return {
			wait: raceRelease(pause.released, request.signal === void 0 ? [this.options.lifetime] : [request.signal, this.options.lifetime]),
			left
		};
	}
	/**
	* The `llm/stream` listener.
	*
	* `ctx.waterfall` composes listeners synchronously, so this returns an async
	* iterator synchronously — an `async` listener would hand the loop a promise
	* where it iterates a stream. One generator body reaches `next()` at most
	* once, which is what makes delegation single-shot per HELD request; a flag
	* shared across requests would also short-circuit everything issued after
	* the release.
	* @param request - the full request, already built and frozen by the loop.
	* @param next - the downstream waterfall chain.
	* @returns the stream, delayed until this request may delegate.
	*/
	stream = (request, next) => {
		const gate = this;
		return (async function* gated() {
			const held = gate.hold(request);
			try {
				if (held !== void 0) await held.wait;
				if (request.signal?.aborted === true) throw abortError(request.signal);
				if (gate.options.lifetime.aborted) throw new Error(PLUGIN_UNLOADED);
				yield* next();
			} finally {
				held?.left();
			}
		})();
	};
	notify(sessionId, paused) {
		for (const listener of [...this.listeners]) listener(sessionId, paused);
	}
	notifyHeld(sessionId, held) {
		for (const listener of [...this.heldListeners]) listener(sessionId, held);
	}
};
//#endregion
//#region lib/types/park.js
/**
* What a session is doing between "pause was asked for" and "its next model
* request is standing still at the gate".
*
* Two facts decide that, and each has its own owner:
*
* - Whether a turn is open is derived state the harness already maintains:
*   the agent registry owns the `turnBoundary` session projection, which folds
*   `turn/start`, `turn/end`, `step/start`, and `step/end` into
*   `openTurnStartSeq`. Reading it through `ctx.agents` is a synchronous
*   projection read, not a scan of the event log (synchronous history reads are
*   prohibited for new code).
* - Which tool is in flight is a log-derived per-session fact, so it is a
*   session projection too. The projection folds each committed
*   `tool/call` → `tool/result` pairing and keeps the calls in order; the
*   framework owns replay, caching, and disposal. This module listens only to
*   committed events so it can wake the control, never to keep a second copy
*   of the state itself.
* @module dsh-pause-session/park
*/
/** One tool call the session has committed but not yet answered. */
const openCallSchema = z.object({
	/** The provider-issued id pairing the call with the result that has not arrived. */
	callId: z.string(),
	/** The tool's own name, as the model called it. */
	name: z.string()
});
/**
* The host-only fold behind {@link ParkWatch}. It is registered on the
* plugin's fiber; unload removes it with every other registration.
*/
const parkActivityProjection = {
	key: "dsh-pause-session/activity",
	stateSchema: z.array(openCallSchema),
	init: () => [],
	apply: (state, event) => {
		if (event.type === "tool/call") return [...state, {
			callId: String(event.data.callId),
			name: event.data.name
		}];
		if (event.type === "tool/result") {
			const callId = String(event.data.message.toolCallId);
			const at = state.findIndex((call) => call.callId === callId);
			if (at < 0) return state;
			return [...state.slice(0, at), ...state.slice(at + 1)];
		}
		return state;
	},
	stateVersion: 1
};
/** Whether the agent registry's `turnBoundary` fold reports an open turn. */
function turnOpen(ctx, session) {
	return ctx.agents.turnBoundaryOf(session).openTurnStartSeq !== null;
}
/**
* Mount the per-session activity projection and its notification edge.
* @param ctx - host context carrying the session store and the projection registry.
* @returns the watch the park state is derived from.
*/
async function mountParkWatch(ctx) {
	const activity = await ctx.sessionProjections.register(parkActivityProjection);
	const listeners = /* @__PURE__ */ new Set();
	const notify = (sessionId) => {
		for (const listener of [...listeners]) listener(sessionId);
	};
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		switch (event.type) {
			case "tool/call":
			case "tool/result":
				notify(session.id);
				return;
			case "turn/start":
			case "turn/end":
				notify(session.id);
				return;
			default: return;
		}
	}), "pause: session activity changes");
	return {
		activity: (sessionId) => {
			const session = ctx.sessions.get(sessionId);
			if (session === void 0) return {
				turnOpen: false,
				runningTools: []
			};
			return {
				turnOpen: turnOpen(ctx, session),
				runningTools: activity.stateOf(session).map((call) => call.name)
			};
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
//#endregion
//#region lib/types/remote.js
/**
* Native Remote transport for the pause controls.
*
* This module is deliberately self-contained: it imports only Cordis and the
* Typert decorators. The Typert generator analyzes this file alone so a
* third-party package can emit its Host reflection and Client contribution
* without pulling the plugin's DSH-typed modules into the generation face.
*
* The UI uses this namespace on Web and Desktop alike. No slash command is
* registered; the stream is the live status channel and the methods below are
* the button actions.
* @module dsh-pause-session/remote
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Host service exposed to the browser as the `pauseSession` Remote namespace. */
let PauseRemote = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _observe_decorators;
	let _act_decorators;
	let _triage_decorators;
	let _decide_decorators;
	return class PauseRemote extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_observe_decorators = [Remote({ mode: "stream" })];
			_act_decorators = [Remote("act")];
			_triage_decorators = [Remote("triage")];
			_decide_decorators = [Remote("decide")];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _observe_decorators, {
				kind: "method",
				name: "observe",
				static: false,
				private: false,
				access: {
					has: (obj) => "observe" in obj,
					get: (obj) => obj.observe
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _act_decorators, {
				kind: "method",
				name: "act",
				static: false,
				private: false,
				access: {
					has: (obj) => "act" in obj,
					get: (obj) => obj.act
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _triage_decorators, {
				kind: "method",
				name: "triage",
				static: false,
				private: false,
				access: {
					has: (obj) => "triage" in obj,
					get: (obj) => obj.triage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _decide_decorators, {
				kind: "method",
				name: "decide",
				static: false,
				private: false,
				access: {
					has: (obj) => "decide" in obj,
					get: (obj) => obj.decide
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		api = __runInitializers(this, _instanceExtraInitializers);
		/**
		* @param ctx - host context owning the service.
		* @param api - the pause engine behind the wire methods.
		*/
		constructor(ctx, api) {
			super(ctx, "pauseSession", { namespace: "pauseSession" });
			this.api = api;
		}
		/**
		* One exact snapshot, used by tests and by a reconnect that cannot wait for
		* the first stream item.
		* @param signal - carrier cancellation.
		* @returns the current aggregate and session states.
		*/
		async snapshot(signal) {
			return await this.api.snapshot(signal);
		}
		/**
		* Live status: the opening snapshot, then one new snapshot whenever the host
		* reports a change.
		* @param signal - stream cancellation.
		* @returns the snapshot stream.
		*/
		async *observe(signal) {
			let version = 0;
			let seen = -1;
			let wake;
			const unsubscribe = this.api.subscribe(() => {
				version += 1;
				wake?.();
				wake = void 0;
			});
			try {
				for (;;) {
					signal?.throwIfAborted();
					if (version !== seen) {
						seen = version;
						yield await this.api.snapshot(signal);
						continue;
					}
					await new Promise((resolve, reject) => {
						const finish = () => {
							signal?.removeEventListener("abort", onAbort);
							wake = void 0;
							resolve();
						};
						const onAbort = () => {
							wake = void 0;
							signal?.removeEventListener("abort", onAbort);
							reject(signal?.reason);
						};
						wake = finish;
						signal?.addEventListener("abort", onAbort, { once: true });
						if (version !== seen) finish();
					});
				}
			} finally {
				unsubscribe();
			}
		}
		/**
		* Pause, resume, press every tree, resume every clean park, or flip one
		* Session's goal re-arm.
		* @param request - the button action.
		* @param signal - carrier cancellation.
		* @returns the user-facing outcome.
		*/
		async act(request, signal) {
			return await this.api.act(request, signal);
		}
		/**
		* Read the morning decision list.
		* @param request - the calling Session whose list is read.
		* @param signal - read cancellation.
		* @returns the listed rows.
		*/
		async triage(request, signal) {
			return await this.api.triage(request, signal);
		}
		/**
		* Take one decision on one listed Session.
		* @param request - the caller, target, and decision.
		* @param signal - load cancellation.
		* @returns the user-facing outcome.
		*/
		async decide(request, signal) {
			return await this.api.decide(request, signal);
		}
	};
})();
//#endregion
//#region lib/types/remote-adapter.js
/**
* Wire adapter between the pause engine and the generated Remote namespace.
*
* The engine speaks in branded Session ids and CommandResult copy; the Remote
* contract is plain JSON. Mapping lives here so neither side depends on the
* other's types.
* @module dsh-pause-session/remote-adapter
*/
/** Map the engine's aggregate status to the wire shape. */
function globalOf(status) {
	return {
		verdict: status.verdict,
		registered: status.registered,
		safe: status.safe,
		...status.parkedAt === void 0 ? {} : { parkedAt: String(status.parkedAt) },
		draining: status.draining.map(String),
		parking: status.parking,
		stalled: status.stalled.map(String),
		unresumable: status.unresumable.map(String),
		unreadTrees: status.unreadTrees.map(String),
		jobs: status.jobs.map(String),
		blind: [...status.blind]
	};
}
/** Map one engine status to the wire shape. */
function sessionOf(status) {
	return {
		phase: status.phase,
		runningTools: [...status.runningTools],
		...status.rearmGoal === void 0 ? {} : { rearmGoal: status.rearmGoal }
	};
}
/** Map one engine triage row to the wire shape. */
function triageRowOf(row) {
	return {
		sessionId: row.sessionId,
		phase: row.phase,
		updatedAt: row.updatedAt,
		reading: row.reading,
		...row.lastEvent === void 0 ? {} : { lastEvent: row.lastEvent },
		...row.turn === void 0 ? {} : { turn: row.turn },
		...row.step === void 0 ? {} : { step: row.step },
		traces: row.traces.map((trace) => ({
			tool: trace.tool,
			...trace.callId === void 0 ? {} : { callId: trace.callId }
		})),
		owed: row.owed,
		wakeable: row.wakeable,
		rearmGoal: row.rearmGoal
	};
}
/** Map the engine's snapshot to the wire shape. */
function snapshotOf(snapshot) {
	return {
		global: globalOf(snapshot.global),
		sessions: Object.fromEntries(Object.entries(snapshot.sessions).map(([id, status]) => [id, sessionOf(status)]))
	};
}
/** Convert one CommandResult-like answer to the wire outcome. */
function outcomeOf(answer) {
	return {
		ok: answer.kind === "success",
		message: answer.text ?? (answer.kind === "success" ? "Done." : "Pause action failed.")
	};
}
/** Convert a press outcome to the wire outcome. */
function pressOutcomeOf(outcome) {
	if (outcome.unrecorded.length > 0) return {
		ok: false,
		message: "pause could not record this session tree."
	};
	if (!outcome.rootRegistered) return {
		ok: false,
		message: "pause did not register this session."
	};
	return {
		ok: true,
		message: `Paused ${String(outcome.registered)} session${outcome.registered === 1 ? "" : "s"}.` + (outcome.unread ? " The subagent tree could not be fully read." : "")
	};
}
/**
* Build the Remote callbacks over the mounted pause control.
* @param control - the engine's host control surface.
* @returns the wire API.
*/
function remoteApiOf(control) {
	return {
		snapshot: async (signal) => snapshotOf(await control.readSnapshot(signal)),
		subscribe: (listener) => control.subscribe(listener),
		act: async (request, signal) => {
			const sessionId = SessionId(request.sessionId);
			switch (request.action) {
				case "pause": return pressOutcomeOf(await control.pressTree(sessionId, signal));
				case "resume": return outcomeOf((await control.releaseTree(sessionId, signal)).answer);
				case "pause-all": return outcomeOf(await control.pauseAll(signal));
				case "resume-all": return outcomeOf(await control.resumeAll(signal));
				case "goal": return outcomeOf(await control.toggleGoal(sessionId, signal));
			}
		},
		triage: async (request, signal) => {
			return (await control.readTriage(SessionId(request.caller), signal)).rows.map(triageRowOf);
		},
		decide: async (request, signal) => {
			const action = request.decision;
			return outcomeOf(await control.decideTriage(SessionId(request.caller), SessionId(request.target), action, signal));
		}
	};
}
/**
* The registry declaration. `version: 1` and no `compatibleVersions`: the
* domain layer rejects a stored unit stamped with any other version rather than
* migrating it, so an unrecognized registry fails loud at open. Validation is
* the rejecting default for the same reason — a record this build cannot read
* must stop the mount, not disappear from the list.
*/
const parkRegistryDomain = defineDomain({
	name: "pause_registry",
	version: 1,
	tables: { sessions: domainTable(z.object({
		/** How far that session got before its process ended; only `safe` is clean. */
		phase: z.enum(PARK_PHASES),
		/** When this record was last written — a phase change, or a goal opt-out flip. */
		updatedAt: z.number().int().nonnegative(),
		/**
		* Whether resuming this session may re-arm its goal. Re-arming is opt-OUT
		* because a re-armed goal continues on its own and spends the owner's money;
		* a record written before this field existed reads as `true`, which is the
		* product default (a goal session comes back running its rounds).
		*
		* Every phase write of one park episode folds through the stored record, so
		* the opt-out a user sets while the session is still draining survives the
		* `parking` and `safe` writes that follow it.
		*/
		rearmGoal: z.boolean().default(true)
	})) }
});
/**
* Open the registry over the mounted storage. The caller owns the handle's
* lifetime; this registers the close as an effect on `ctx`, so the unit is
* released with the plugin.
* @param ctx - plugin context carrying `storageDomain`.
* @returns the open registry.
* @throws whatever `open` rejects with — a `StorageError` for an unreadable
* unit, a `DomainError('invalid-record')` for a record this build cannot read.
*/
async function openParkRegistry(ctx) {
	const domain = await ctx.storageDomain.open(parkRegistryDomain);
	ctx.effect(() => () => domain.close(), "pause: registry");
	const sessions = domain.table("sessions");
	/** The entries the cached view was built from; replaced whenever they differ. */
	let cachedFrom = [];
	let cached;
	const entryOf = (sessionId) => {
		const record = sessions.get(sessionId);
		return record === void 0 ? void 0 : {
			sessionId,
			phase: record.phase,
			updatedAt: record.updatedAt,
			rearmGoal: record.rearmGoal
		};
	};
	const entriesNow = () => [...sessions.entries()].map(([sessionId, record]) => ({
		sessionId,
		phase: record.phase,
		updatedAt: record.updatedAt,
		rearmGoal: record.rearmGoal
	}));
	return {
		list: entriesNow,
		get parked() {
			const entries = entriesNow();
			if (cached !== void 0 && entries.length === cachedFrom.length && entries.every((entry, at) => entry === cachedFrom[at])) return cached;
			cachedFrom = entries;
			cached = new Map(entries.map((entry) => [entry.sessionId, entry]));
			return cached;
		},
		get: entryOf,
		record: async (sessionId, phase) => {
			const updatedAt = Date.now();
			if (sessions.get(sessionId) !== void 0) try {
				await sessions.update(sessionId, (current) => ({
					...current,
					phase,
					updatedAt
				}));
				return;
			} catch (error) {
				if (!(error instanceof DomainError) || error.code !== "missing-key") throw error;
			}
			await sessions.put(sessionId, {
				phase,
				updatedAt,
				rearmGoal: true
			});
		},
		setRearmGoal: async (sessionId, rearmGoal) => {
			await sessions.update(sessionId, (current) => ({
				...current,
				rearmGoal,
				updatedAt: Date.now()
			}));
		},
		forget: async (sessionId) => {
			await sessions.delete(sessionId);
		}
	};
}
//#endregion
//#region lib/types/index.js
/**
* Host half of dsh-pause-session.
*
* Mounts the pause gate — the per-session hold at the model-request waterfall —
* the activity fold the park predicate reads, the durable park registry, the
* session control the browser half drives, and the clean resume path that
* answers the input a parked session left pending.
*
* The registry is read before anything is gated, so a session a previous
* process left parked is held again by this one without any user action; a
* registry this build cannot read fails the mount loudly rather than silently
* resuming every session it named.
* @module dsh-pause-session
*/
/** Plugin name; the Loader row and the bundle patch both use it. */
const name = "dsh-pause-session";
/**
* Required host services: the model runtime to gate, the stores the control
* needs, the projection registry the park predicate reads turn state from, and
* the profile's storage, which holds the pause registry.
*/
const inject = [
	"llm",
	"agents",
	"sessions",
	"sessionProjections",
	"storageDomain"
];
/**
* Provider routes whose request conversion drops an empty user message, so the
* clean resume path's wake input never reaches the model on them.
*
* The list is deployment knowledge, not a constant this plugin may assume:
* whether an empty user message survives is decided by the adapter (and, for
* the pi-ai family, by the provider API that adapter is configured for), and a
* plugin cannot introspect an adapter. The default names the routes the shipped
* DeepSeek adapter registers; a profile that routes a session elsewhere gets
* the visible marker instead of a silent empty turn until it declares that
* route here.
*/
const DEFAULT_SILENT_WAKE_ROUTES = ["deepseek-official", "deepseek-account"];
/** Validated plugin configuration. */
const ConfigShape = z.object({
	/** Provider routes known to drop an empty user message; see {@link DEFAULT_SILENT_WAKE_ROUTES}. */
	silentWakeRoutes: z.array(z.string()).default([...DEFAULT_SILENT_WAKE_ROUTES]),
	/**
	* How many events of a parked session's stored log the morning list folds per
	* row, counted back from the end. The list reads a session's stop position
	* and its unknown tool outcomes, both facts about the log's end, so this
	* bounds what a panel left open costs without changing what a row says about
	* a log that fits inside it. A row whose log needs more than this is reported
	* unreadable rather than guessed at; see `./coldlog.ts`.
	*/
	maxListedLogEvents: z.number().int().min(1).max(TRIAGE_LOG_MAX_EVENTS).default(TRIAGE_WINDOW_EVENTS)
});
/**
* The Loader hands a row's config through this schema, and an empty row config
* arrives as `undefined`; folding it to `{}` first is what lets the field
* defaults above apply instead of failing the mount.
*/
const Config = z.preprocess((value) => value ?? {}, ConfigShape);
/**
* Mount the durable pause registry, the pause gate, the activity fold, their
* session control, and the clean resume path.
*
* The registry opens first on purpose: if it cannot be read, nothing else is
* registered, so a failed mount leaves no half-installed control behind.
* @param ctx - the plugin's host context.
* @param config - validated route knowledge for the resume path's wake content.
*/
async function apply(ctx, config = Config.parse({})) {
	const registry = await openParkRegistry(ctx);
	const lifetime = new AbortController();
	ctx.effect(() => () => {
		lifetime.abort(/* @__PURE__ */ new Error("pause: plugin unloaded"));
	}, "pause: lifetime");
	const gate = new PauseGate({ lifetime: lifetime.signal });
	ctx.effect(() => ctx.on("llm/stream", (request, next) => gate.stream(request, next)), "pause: pause gate");
	const control = installSessionControl(ctx, gate, await mountParkWatch(ctx), registry, {
		silentWakeRoutes: config.silentWakeRoutes,
		maxListedLogEvents: config.maxListedLogEvents
	});
	new PauseRemote(ctx, remoteApiOf(control));
	await control.adopt();
}
//#endregion
export { Config, DEFAULT_SILENT_WAKE_ROUTES, PauseRemote, apply, inject, name };

//# sourceMappingURL=index.js.map