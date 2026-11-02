window.__ModuleLoader__.load({
	id: "dsh-pause-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/shared.js
		/**
		* The identities both halves of dsh-pause-session name, the status encodings they
		* share, and the one spelling a host log line gives a caught value.
		*
		* The browser bundle may value-import only the shell's baseline module table,
		* so this module imports nothing: the client half reads command names and the
		* decode functions from it directly, and the host half derives the branded
		* identities from the same strings.
		*
		* A third-party plugin's only live channel to the browser is the command
		* registry — it can add neither a `ctx.remote` namespace nor a forwarded event,
		* both of which are compiled into the harness's own API assembly. A command
		* descriptor's only free-form field is its `description`, and a command
		* result's only free-form field is its `text`, so the park state travels as a
		* prefix plus `;`-separated fields on one of those. The text stays
		* human-readable: the same words are what the slash-command menu shows.
		*
		* Every value inside a field is escaped, so a decoded name is the exact name
		* that was encoded. Session ids, tool names, and call ids are the host's own
		* data and may contain the `;`, `,`, `/`, or newline a field is separated by; a
		* folded spelling would decode as a different name — a different row, looked up
		* again.
		* @module dsh-pause-session/shared
		*/
		/** Command that pauses the receiving session before its next model request. */
		const PAUSE_COMMAND = "pause";
		/** Command that resumes the receiving session; registered only while that session is paused. */
		const RESUME_COMMAND = "pause-resume";
		/** Command that resumes every parked session the registry remembers. */
		const RESUME_ALL_COMMAND = "pause-resume-all";
		/** Command that registers and parks every running session tree in one action. */
		const PAUSE_ALL_COMMAND = "pause-all";
		/** Command that reports the whole-app park state; registered globally, always. */
		const STATE_ALL_COMMAND = "pause-state-all";
		/** Command that reports the receiving session's park state; registered only while it is paused. */
		const STATUS_COMMAND = "pause-state";
		/** Command that turns the receiving session's own goal re-arm on or off; registered only while it is paused. */
		const GOAL_COMMAND = "pause-goal";
		/** Command that reports every session that did not stop cleanly. */
		const TRIAGE_COMMAND = "pause-triage";
		/** Command that resumes one session from the decision list exactly as the clean path would. */
		const TRIAGE_CONTINUE_COMMAND = "pause-triage-continue";
		/** Command that resumes one session from the decision list with the unknown-outcome note. */
		const TRIAGE_NOTE_COMMAND = "pause-triage-note";
		/** Command that opens one session from the decision list without spending a request. */
		const TRIAGE_REVIEW_COMMAND = "pause-triage-review";
		/** Command that leaves one session from the decision list exactly as it is. */
		const TRIAGE_LEAVE_COMMAND = "pause-triage-leave";
		/** Command that turns one listed session's goal re-arm on or off. */
		const TRIAGE_GOAL_COMMAND = "pause-triage-goal";
		/**
		* One list field's text when the list is empty. A value that would itself spell
		* this marker is escaped by {@link escapeField}, so an empty list and a list
		* holding the marker stay different texts.
		*/
		const EMPTY_FIELD = "-";
		/**
		* One value previously written by {@link escapeField}.
		* @param text - the encoded value, escapes included.
		* @returns the value the host holds.
		*/
		function unescapeField(text) {
			return text.replace(/\\(.)/g, (_escape, character) => character === "n" ? "\n" : character);
		}
		/**
		* Split one encoded text on the separators that are not escaped, keeping each
		* escape beside the character it protects so {@link unescapeField} can read it.
		* @param text - an encoded text, without its prefix.
		* @param separator - the single character to split on.
		* @returns the parts, in order; always at least one.
		*/
		function splitFields(text, separator) {
			const parts = [];
			let part = "";
			for (let at = 0; at < text.length; at += 1) {
				const character = text[at] ?? "";
				if (character === "\\") {
					part += character + (text[at + 1] ?? "");
					at += 1;
					continue;
				}
				if (character === separator) {
					parts.push(part);
					part = "";
					continue;
				}
				part += character;
			}
			parts.push(part);
			return parts;
		}
		/**
		* One field of an encoded text, by its key.
		* @param fields - the separated fields of one encoded text.
		* @param key - the field's key, without its `:`.
		* @returns the field's value with its escapes still in place, or `undefined`
		* when the text does not carry that field.
		*/
		function fieldOf(fields, key) {
			const prefix = `${key}:`;
			const at = fields.findIndex((field) => field.trim().startsWith(prefix));
			return at < 0 ? void 0 : fields[at]?.trim().slice(prefix.length).trim();
		}
		/** The one word each phase is published as, and the whole decoding vocabulary. */
		const PHASE_WORD = {
			draining: "pausing",
			parking: "saving",
			safe: "paused",
			"flush-failed": "save failed"
		};
		/**
		* The two states of one record's goal re-arm field, in the one spelling both
		* the per-session status and the decision list publish it with.
		*/
		const GOAL_ON = "on";
		const GOAL_OFF = "off";
		/**
		* Decode a status previously written by {@link encodeParkStatus}.
		* @param text - a command descriptor's description.
		* @returns the status, or `undefined` when this text carries none — a foreign
		* command, or a reading taken before the host published anything.
		*/
		function decodeParkStatus(text) {
			if (!text.startsWith("pause: ")) return void 0;
			const [head = "", ...rest] = splitFields(text.slice(7), ";");
			const word = head.trim();
			const phase = Object.keys(PHASE_WORD).find((candidate) => PHASE_WORD[candidate] === word);
			if (phase === void 0) return void 0;
			const goal = fieldOf(rest, "goal");
			return {
				phase,
				safe: phase === "safe",
				runningTools: decodeNames(fieldOf(rest, "tools")),
				...goal === GOAL_ON ? { rearmGoal: true } : goal === GOAL_OFF ? { rearmGoal: false } : {}
			};
		}
		/**
		* Decode one id previously written by {@link encodeId}.
		* @param field - the encoded field, escapes included.
		* @returns the id; `undefined` when the text carries none — an absent field and
		* the empty marker both mean the answer names no session, and a client that
		* read either as one would address a session the host never named.
		*/
		function decodeId(field) {
			const text = field?.trim();
			if (text === void 0 || text.length === 0 || text === EMPTY_FIELD) return void 0;
			return unescapeField(text);
		}
		/** Decode one list field. */
		function decodeNames(field) {
			const text = field?.trim();
			if (text === void 0 || text.length === 0 || text === EMPTY_FIELD) return [];
			return splitFields(text, ",").map((name) => unescapeField(name.trim())).filter((name) => name.length > 0);
		}
		/**
		* Decode a whole-app status previously written by {@link encodeGlobalStatus}.
		* @param text - a command result's text.
		* @returns the status, or `undefined` when this text carries none.
		*/
		function decodeGlobalStatus(text) {
			if (!text.startsWith("pause all: ")) return void 0;
			const [head = "", ...fields] = splitFields(text.slice(11), ";");
			const verdict = head.trim();
			if (verdict !== "idle" && verdict !== "waiting" && verdict !== "safe") return void 0;
			const byKey = /* @__PURE__ */ new Map();
			for (const field of fields) {
				const at = field.indexOf(":");
				if (at < 0) continue;
				byKey.set(field.slice(0, at).trim(), field.slice(at + 1).trim());
			}
			const count = (key) => {
				const value = Number(byKey.get(key));
				return Number.isSafeInteger(value) && value >= 0 ? value : 0;
			};
			const parkedAt = decodeId(byKey.get("parked-at"));
			return {
				verdict,
				registered: count("registered"),
				safe: count("safe"),
				...parkedAt === void 0 ? {} : { parkedAt },
				draining: decodeNames(byKey.get("draining")),
				parking: count("parking"),
				stalled: decodeNames(byKey.get("stalled")),
				unresumable: decodeNames(byKey.get("unresumable")),
				unreadTrees: decodeNames(byKey.get("unread-trees")),
				jobs: decodeNames(byKey.get("jobs")),
				blind: decodeNames(byKey.get("blind")).filter((spot) => spot === "trees" || spot === "jobs")
			};
		}
		/** How one row is spelled in the published list; the wake field's state when the host can hand over the owed request. */
		const WAKE_YES = "yes";
		/** Decode {@link encodeTraces}; an item without a tool name is not a trace. */
		function decodeTraces(field) {
			const text = field?.trim();
			if (text === void 0 || text.length === 0 || text === EMPTY_FIELD) return [];
			return splitFields(text, ",").flatMap((item) => {
				const [tool = "", callId = ""] = splitFields(item.trim(), "/");
				if (tool.length === 0) return [];
				return [{
					tool: unescapeField(tool),
					callId: unescapeField(callId)
				}];
			});
		}
		/**
		* Decode a decision list previously written by {@link encodeTriageList}.
		* @param text - a command result's text.
		* @returns the list, or `undefined` when this text carries none.
		*/
		function decodeTriageList(text) {
			if (!text.startsWith("pause triage: ")) return void 0;
			const [head = "", ...rest] = splitFields(text.slice(14), ";");
			if (!Number.isSafeInteger(Number(head.trim())) || Number(head.trim()) < 0) return void 0;
			const rows = [];
			let fields = [];
			const flush = () => {
				if (fields.length === 0) return;
				const sessionId = fieldOf(fields, "row");
				const phase = fieldOf(fields, "phase");
				if (sessionId === void 0 || phase === void 0 || phase === "safe") return;
				const stopped = fieldOf(fields, "stopped");
				const reading = stopped === "unreadable" ? "unreadable" : "read";
				const position = reading === "unreadable" || stopped === void 0 || stopped === EMPTY_FIELD ? null : /^(.*?)(?:\/turn (\d+)(?: step (\d+))?)?$/.exec(stopped);
				rows.push({
					sessionId: unescapeField(sessionId),
					phase,
					updatedAt: 0,
					reading,
					...position === null ? {} : {
						lastEvent: unescapeField(position[1] ?? ""),
						...position[2] === void 0 ? {} : { turn: Number(position[2]) },
						...position[3] === void 0 ? {} : { step: Number(position[3]) }
					},
					traces: reading === "unreadable" ? [] : decodeTraces(fieldOf(fields, "traces")),
					owed: fieldOf(fields, "owed") === WAKE_YES,
					wakeable: fieldOf(fields, "wake") === WAKE_YES,
					rearmGoal: fieldOf(fields, "goal") !== GOAL_OFF
				});
				fields = [];
			};
			for (const field of rest) {
				if (field.trim().startsWith("row:")) flush();
				fields.push(field);
			}
			flush();
			return { rows };
		}
		//#endregion
		//#region lib/types/client/burst.js
		/**
		* The re-read burst both browser controls share: a handful of reads after
		* something moved, and silence once it settles.
		*
		* What a control reads is published through the host's command channel, and
		* every read is two durable `command/run|done` records in the address session's
		* log plus an aggregate read on the host. Reading is therefore something the
		* host announces and the user asks for, never a heartbeat:
		*
		* - the host announces a transition by registering or unregistering the paused
		*   session's marker commands, and — for a phase change, which no registration
		*   of its own would show — by registering that session's status verb again.
		*   Each of those emits `commands/change`, and that event, plus the user's own
		*   press or decision, is what starts a burst;
		* - one transition announces itself several times: a park registers two or three
		*   marker commands per session and a phase change re-registers one, and the host
		*   emits one `commands/change` per step. The burst therefore waits out a short
		*   `windowMs` before its first read and any trigger inside that window
		*   postpones it, so the announcements of one transition start one burst rather
		*   than one each;
		* - a change that arrives within `ACTION_ABSORB_MS` of the user's own action is
		*   that action's own consequence, not news: the action already read the host,
		*   so the answer is on screen, and the unregistrations it caused — one event
		*   per marker command, measured seconds apart, which the window above cannot
		*   merge — would only be read back. Such a change is absorbed, and each one
		*   absorbed pushes the window out, because a storm that keeps arriving is
		*   still the same storm. The window always closes: the first change after
		*   `ACTION_ABSORB_MS` of quiet is news again, and a user action reads on its
		*   own whatever the window says;
		* - an absorbed change is deferred rather than lost: a control whose action left
		*   a phase still moving asks for one look at the moment the window closes
		*   ({@link ReadBurst.recheckAfterEcho}), which is the read that finds a
		*   transition the window hid — the park can reach its final phase inside that
		*   window and never announce anything again. One look per action, and only
		*   while the state it left is still moving;
		* - a burst is a fixed short list of waits, so at most that many reads answer
		*   one transition, however long the page stays open;
		* - a read that finds the verdict settled ends the burst at once, and the last
		*   reading stays on screen — "the park is settled" is not a state change, so
		*   it must not be re-asked;
		* - a read that finds a phase still moving ends it just as fast. Every phase
		*   transition is announced at its source, the flush that resolves `parking`
		*   into `safe` included, and that announcement is the very event that starts
		*   the next burst — so watching a moving phase from here spends records on a
		*   transition that will speak for itself;
		* - what the burst still owes after a read is delivery: the read one
		*   announcement bought, and one more when a change lands while a pass is in
		*   flight, which that pass cannot have answered. The bound is a bound, not a
		*   heartbeat: a phase that never settles is left on screen unread until
		*   something else moves;
		* - the bound is a trade, taken knowingly: a reading left on screen when the
		*   burst runs out is the host's own last answer, and the next trigger — a
		*   forwarded change, a press, or the shell handing a control its session again
		*   — reads the truth again. A reading nobody answered is never rendered as a
		*   confident state. A longer watch is a longer list of waits, at a linear price
		*   in the address session's log;
		* - while the page is hidden no read is armed at all, and the wait a burst
		*   still owed is armed again when the page comes back: hidden time is neither
		*   charged to the burst nor lost from it.
		*
		* A burst is not restarted by a trigger that lands while one is running: every
		* read it still owes happens after that trigger, so absorbing it loses nothing
		* and a storm of registry changes costs one burst rather than one each.
		* @module dsh-pause-session/client/burst
		*/
		/** The policy every control uses unless a caller says otherwise. */
		const DEFAULT_BURST_POLICY = {
			windowMs: 400,
			waitsMs: [
				400,
				1e3,
				2400,
				4800
			],
			visible: defaultVisibility
		};
		/**
		* How long after a client action a registry change is that action's own echo.
		*
		* A press, a release, a decision, a goal switch and an opened panel each read
		* the host as they run, so their answer is already on screen when the host
		* announces what they did — one `commands/change` per marker command, measured
		* 0.44 s to 2.04 s apart, a cadence the coalescing window cannot merge. Reading
		* those back is paying for an answer the user already has.
		*
		* The window is what makes `commands/change` mean "something moved that this
		* browser did not do". It is refreshed by every change it absorbs, so a storm
		* that keeps arriving stays absorbed rather than leaking one read per change,
		* and it ends for good `ACTION_ABSORB_MS` after the last change: a change after
		* that is news, and so is the next user action, which reads on its own.
		*
		* The margin over the measured 2.04 s gap is deliberate: a transition's own
		* storm has to fit inside the window for the whole storm to stay absorbed.
		*/
		const ACTION_ABSORB_MS = 2500;
		/**
		* The waits one burst uses when its first wait is `first`: four reads spread
		* over roughly ten times that. Long enough that a read a hidden page or an
		* in-flight pass deferred is still taken, short enough that a state which never
		* settles costs a handful of log records rather than a night of them.
		* @param first - milliseconds before the burst's first read, after its window; `<= 0` disables bursting.
		* @returns the waits, in order; empty when bursting is disabled.
		*/
		function burstWaits(first) {
			return first > 0 ? [
				first,
				first * 2.5,
				first * 6,
				first * 12
			] : [];
		}
		/**
		* Whether the browser reports the page as on screen. A shell without a
		* `document` (a test harness, a non-browser host) counts as visible: a control
		* that could never read would be a worse lie than one that reads.
		* @returns whether the page is visible now.
		*/
		function defaultVisibility() {
			return (typeof document === "undefined" ? void 0 : document.visibilityState) !== "hidden";
		}
		/** The real clock: `setTimeout` clearing itself. */
		const SYSTEM_CLOCK = {
			set: (callback, ms) => setTimeout(callback, ms),
			clear: (timer) => {
				clearTimeout(timer);
			}
		};
		/**
		* One control's re-read burst. Every method is safe to call in any order and as
		* often as the caller likes: a trigger starts at most one burst, and one burst
		* never arms more than one read at a time.
		*/
		var ReadBurst = class {
			onRead;
			policy;
			clock;
			/** The armed wait, when one is counting down. */
			timer;
			/** Whether the burst is waiting out its collection window rather than a wait between reads. */
			window = false;
			/** Waits this burst has not spent yet, front first. */
			left = [];
			/** Whether a burst is in progress: it may be collecting, waiting, reading, or reading again. */
			running = false;
			/** The absorption window a client action opened, while one is open. */
			absorbed;
			/** Whether a control asked for the one look owed when the echo window closes. */
			recheck = false;
			/**
			* @param onRead - one more read. Called only for a read the burst owes and the page can show.
			* @param policy - the collection window, the waits, and the visibility source.
			* @param clock - the timer implementation.
			*/
			constructor(onRead, policy, clock = SYSTEM_CLOCK) {
				this.onRead = onRead;
				this.policy = policy;
				this.clock = clock;
			}
			/** Whether this control bursts at all. */
			get enabled() {
				return this.policy.waitsMs.length > 0;
			}
			/** Whether one more read is already counting down. */
			get armed() {
				return this.timer !== void 0;
			}
			/** Whether a burst is in progress, with or without a read counting down. */
			get live() {
				return this.running;
			}
			/** Whether a change right now is a client action's own echo. */
			get absorbing() {
				return this.absorbed !== void 0;
			}
			/**
			* The user acted on this control and the action reads: a press, a release, a
			* decision, a goal switch, an opened panel. Its read is the answer, and the
			* registry changes it sets off announce themselves for a while afterwards, so
			* until the window closes a trigger is that echo rather than news.
			*
			* Called as the action is taken, before its read lands, because the echo can
			* arrive while the action is still running.
			*/
			absorb() {
				if (!this.enabled) return;
				this.armAbsorb();
			}
			/**
			* Ask for one read at the moment the echo window closes, because the action's
			* own read left a state that is still moving.
			*
			* The echo window swallows a transition announced inside it — the forwarded
			* event carries no payload, so nothing distinguishes a marker registration
			* from a phase change — and after the window no change is guaranteed to come:
			* the transition that was hidden may be the last one this park makes. The
			* look owed here is the read that finds it, one per action, and it is not a
			* watch: once the window has closed, every further change is news and buys its
			* own read. A control whose action left a settled state owes nothing and asks
			* for nothing.
			*/
			recheckAfterEcho() {
				if (!this.enabled) return;
				this.recheck = true;
			}
			/**
			* Something moved — a registry change. The burst first waits out its
			* collection window, and every trigger that lands inside it restarts that
			* window: the two or three registrations of one park start one burst rather
			* than one each. A burst already past its window takes this as covered —
			* every read it still owes happens after the change.
			*
			* @returns whether the change is news rather than a client action's own echo.
			* The echo announces what the action's read already answered, so only a news
			* trigger is a change a control still owes a read for; a change that lands
			* while a burst is under way is covered by the read that burst already owes.
			* `false` also for a disabled burst, which reads nothing at all.
			*/
			trigger() {
				if (!this.enabled) return false;
				if (this.absorbing) {
					this.armAbsorb();
					return false;
				}
				if (!this.running) {
					this.running = true;
					this.left = this.policy.waitsMs;
					this.armWindow();
					return true;
				}
				if (this.window) this.armWindow();
				return true;
			}
			/**
			* The control knows it still owes a read: a change that is news has arrived,
			* or a reading just revealed something only a read can answer. A call outside
			* any burst starts one. Absorption never applies here — this is not a change
			* some action caused, it is a read the control already knows it needs.
			*/
			next() {
				if (this.armed || this.window) return;
				if (!this.running) {
					this.running = true;
					this.left = this.policy.waitsMs;
				}
				this.owe();
			}
			/**
			* Nothing is moving: end the burst and forget it. The last reading stays
			* published, and the next trigger starts a fresh burst. Two things outlive
			* this: an action's absorption window, which is about what the action caused
			* rather than about the state, and the one look it may still owe — see
			* {@link recheckAfterEcho}.
			*/
			stop() {
				this.running = false;
				this.left = [];
				this.window = false;
				this.cancel();
			}
			/** Drop the armed wait. A burst that is still owed its read survives it; see {@link checkVisibility}. */
			cancel() {
				if (this.timer === void 0) return;
				this.clock.clear(this.timer);
				this.timer = void 0;
			}
			/**
			* Re-evaluate one page-visibility change. Going off screen drops the armed
			* wait — a hidden page is not being read — and coming back arms it again, so
			* the burst resumes where it stopped instead of being spent while nobody was
			* looking. A burst still collecting resumes its window, restarted from the
			* moment the page came back: a trigger that arrived while it was hidden still
			* postpones the read.
			*/
			checkVisibility() {
				if (this.visibleNow()) {
					this.arm();
					return;
				}
				this.cancel();
			}
			/** Spend the next wait of the burst, or end it when the bound is reached. */
			owe() {
				const wait = this.left[0];
				if (wait === void 0) {
					this.running = false;
					return;
				}
				this.armWait(wait);
			}
			/**
			* (Re)start the collection window. While the page is hidden nothing is armed
			* — hidden time is not charged to the burst — and a trigger that lands then
			* is still collected, because coming back starts a whole window.
			*/
			armWindow() {
				const wait = Math.max(this.policy.windowMs, 0);
				if (!this.visibleNow()) {
					this.window = true;
					return;
				}
				this.cancel();
				this.window = true;
				this.timer = this.clock.set(() => {
					this.timer = void 0;
					this.window = false;
					this.owe();
				}, wait);
			}
			/** Put back whatever the burst still owed: its window, or the wait after a read. */
			arm() {
				if (this.window) {
					this.armWindow();
					return;
				}
				const wait = this.left[0];
				if (wait !== void 0) this.armWait(wait);
			}
			/**
			* (Re)start the absorption window a client action opened. A hidden page keeps
			* absorbing: this window is about what the action caused, not about what the
			* page is doing. When the window closes, the one look an unsettled action owes
			* is taken; the window is restarted by every change it absorbs, so that look
			* waits for the echo to actually stop.
			*/
			armAbsorb() {
				this.cancelAbsorb();
				this.absorbed = this.clock.set(() => {
					this.absorbed = void 0;
					if (!this.recheck) return;
					this.recheck = false;
					this.next();
				}, Math.max(ACTION_ABSORB_MS, 0));
			}
			/** Close the absorption window: changes are news again. */
			cancelAbsorb() {
				if (this.absorbed === void 0) return;
				this.clock.clear(this.absorbed);
				this.absorbed = void 0;
			}
			/**
			* Arm one wait, spending it when it fires. The wait stays in `left` until
			* then, so a page hidden mid-wait takes the whole wait again: hidden time is
			* neither charged to the burst nor lost from it.
			*/
			armWait(wait) {
				if (this.timer !== void 0 || !this.visibleNow()) return;
				this.timer = this.clock.set(() => {
					this.timer = void 0;
					this.left = this.left.slice(1);
					this.onRead();
				}, Math.max(wait, 0));
			}
			/** Whether the page counts as on screen now, with an absent `document` read as on screen. */
			visibleNow() {
				try {
					return this.policy.visible();
				} catch {
					return true;
				}
			}
		};
		//#endregion
		//#region lib/types/client/control.js
		/**
		* Browser-side reading and driving of the host's park state for one session.
		*
		* The host publishes no push channel of its own — a third-party plugin cannot
		* add a Client Remote namespace or a forwarded event — so this control reads
		* the host's command registry, which is the only live surface it can publish
		* through: `commands.list(sessionId)` is a Client-callable read, and the
		* forwarded `commands/change` event says when to read it again. The resume
		* definition's presence in that list IS the host's "this session is paused"
		* fact, and the companion status definition answers with the park state as of
		* the read; this module never derives either from its own press. That one
		* answer carries the record's goal opt-out as well, so the switch beside the
		* pause button can show it without a second host round-trip — and without it,
		* the control renders no switch at all.
		*
		* Every phase the host reaches announces itself on that channel: a transition
		* re-registers the status verb, so a transition is what buys the next read and a
		* read that finds a phase still moving is the answer to the transition that
		* produced it rather than a reason to keep asking (`./burst.ts`). One transition
		* arrives as several registry changes — parking a session also registers its
		* three commands — so the burst's own collection window is what turns a tick of
		* changes into one read per shown session. A press or a goal switch reads as it
		* runs, and the marker changes it causes are that action's own echo: those are
		* absorbed for a short window (`./burst.ts`) rather than read back — except for
		* the one look an action owes when that window closes, if the reading it left
		* behind is still moving, because a transition announced inside the window would
		* otherwise never be read at all.
		*
		* The whole-app control reads the same park and publishes what it found
		* (`./global.ts`), and a header consults that answer before spending a read of
		* its own: with nothing registered, no session can be paused, so a header that
		* already says "running" is left saying it rather than paying a round-trip to
		* hear it again. A header the host last showed on its way to a park is never
		* answered that way — that reading is the newer fact — and the derivation is
		* voided by the next whole-app answer that names a registered session, which
		* the forwarded change a park causes is what brings in.
		* @module dsh-pause-session/client/control
		*/
		const INITIAL$1 = { bySession: {} };
		/** Phases that name a moment on the way to a park rather than a state it reached. */
		const MOVING = /* @__PURE__ */ new Set(["draining", "parking"]);
		/** Owns the published reading per session; nothing else writes that state. */
		var PauseControl = class {
			commands;
			lifetime;
			aggregate;
			/** State source the Session-header contribution binds its selector hook to. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL$1);
			/** Sessions this control has shown; a host registry change re-reads every one of them. */
			shown = /* @__PURE__ */ new Set();
			/** Highest read sequence requested per session: an answer older than it is dropped. */
			latest = /* @__PURE__ */ new Map();
			/**
			* Sessions a change has put back on the list of ones to read once — a
			* transition this browser has been told about and has not answered yet.
			*/
			owed = /* @__PURE__ */ new Set();
			/**
			* Whether the look owed at the close of an echo window is still to be taken.
			* It reads every shown session, exactly as a change does: the look exists
			* because a change may have been swallowed, and a swallowed change carries no
			* payload either.
			*/
			trailing = false;
			/**
			* Sessions whose header was answered from the whole-app "nothing is
			* registered" instead of a read of their own, and which therefore have to be
			* read for real if that answer stops holding.
			*/
			derived = /* @__PURE__ */ new Set();
			/** The bounded burst of reads one transition buys; see `./burst.ts`. */
			burst;
			reads = 0;
			/**
			* @param commands - the Client-callable command namespace.
			* @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
			* @param windowMs - how long the burst collects the registrations of one
			* transition before its first read; also the wait after a press.
			* @param policy - the burst waits and visibility source; defaults to the real page.
			* @param aggregate - the whole-app control's published answer; absent means it is never consulted.
			*/
			constructor(commands, lifetime, windowMs = 400, policy = DEFAULT_BURST_POLICY, aggregate = () => void 0) {
				this.commands = commands;
				this.lifetime = lifetime;
				this.aggregate = aggregate;
				this.burst = new ReadBurst(() => {
					this.readAll();
				}, {
					...policy,
					windowMs,
					waitsMs: burstWaits(windowMs)
				});
			}
			/**
			* Read the host's state for one session.
			* @param sessionId - session whose control was rendered.
			* @returns after this read's answer is published or superseded by a newer one.
			*/
			async refresh(sessionId) {
				await this.readOne(sessionId);
				this.follow();
			}
			/**
			* The host's command registry changed, so every session this control has
			* shown may have moved — the forwarded event carries no payload, so the only
			* honest answer is to look at all of them once. The reads run on the burst's
			* own schedule rather than here, which is what makes a tick's worth of changes
			* — parking a session registers three commands, and a phase change re-registers
			* one more — one burst instead of one each. A change that is this browser's own
			* action's echo owes nothing: the action read the host as it ran.
			*/
			refreshAll() {
				if (this.shown.size === 0 || this.lifetime.aborted) return;
				if (!this.burst.trigger()) return;
				for (const sessionId of this.shown) this.owed.add(sessionId);
			}
			/**
			* One pass of the burst: every shown session a change still owes a read. The
			* forwarded event carries no payload, so a change may have touched any of
			* them and each is read once. A session the whole-app answer has already
			* spoken for is answered from it instead of being asked about; see
			* {@link answerIsKnown}.
			*/
			async readAll() {
				if (this.lifetime.aborted) {
					this.burst.stop();
					return;
				}
				const pass = this.owed.size > 0 ? [...this.owed] : this.trailing ? [...this.shown] : [];
				this.owed.clear();
				this.trailing = false;
				for (const sessionId of pass) {
					if (this.answerIsKnown(sessionId)) {
						this.deriveActive(sessionId);
						continue;
					}
					await this.readOne(sessionId);
				}
				this.follow();
			}
			/** One session's read, published unless a newer read of that session supersedes it. */
			async readOne(sessionId) {
				this.shown.add(sessionId);
				this.derived.delete(sessionId);
				const sequence = ++this.reads;
				this.latest.set(sessionId, sequence);
				const reading = await this.read(sessionId);
				if (this.latest.get(sessionId) !== sequence) return;
				this.publish(sessionId, reading);
			}
			/**
			* Press the control: pause an active session, or take back a pause that is
			* still on its way in (or already settled). The phase shown afterwards is the
			* host's answer, never an assumed flip.
			* @param sessionId - session whose control was pressed.
			* @returns after the control re-reads the host.
			*/
			async toggle(sessionId) {
				const current = this.store.getSnapshot().bySession[String(sessionId)]?.phase;
				const line = current === void 0 || current === "active" ? `/${PAUSE_COMMAND}` : `/${RESUME_COMMAND}`;
				this.burst.absorb();
				if (!(await this.commands.execute(sessionId, line, [], this.lifetime)).ok) {
					this.publish(sessionId, {
						phase: "unavailable",
						runningTools: []
					});
					this.follow();
					return;
				}
				await this.refresh(sessionId);
			}
			/**
			* Flip this session's goal opt-out. The verb belongs to the session it
			* changes — the host registers it there, and it takes no other target — so
			* this press needs no listed row. What the switch shows afterwards is the
			* host's next answer, never a local flip: a refused switch leaves the record
			* exactly as it was, and the re-read is what says so.
			* @param sessionId - session whose switch was pressed.
			* @returns after the control re-reads the host.
			*/
			async toggleGoal(sessionId) {
				this.burst.absorb();
				await this.commands.execute(sessionId, `/${GOAL_COMMAND}`, [], this.lifetime);
				await this.refresh(sessionId);
			}
			/** Ask the host what this session's park state is, in the browser's vocabulary. */
			async read(sessionId) {
				const listed = await this.commands.list(sessionId);
				if (!listed.ok) return {
					phase: "unavailable",
					runningTools: []
				};
				if (!listed.value.some((descriptor) => descriptor.definitionId === "dsh-pause-session/resume")) return {
					phase: "active",
					runningTools: []
				};
				if (listed.value.find((descriptor) => descriptor.definitionId === "dsh-pause-session/status") === void 0) return {
					phase: "parking",
					runningTools: []
				};
				const answered = await this.commands.execute(sessionId, `/${STATUS_COMMAND}`, [], this.lifetime);
				if (!answered.ok || answered.value === void 0) return {
					phase: "unavailable",
					runningTools: []
				};
				const text = answered.value.result.kind === "success" ? answered.value.result.text : void 0;
				const decoded = text === void 0 ? void 0 : decodeParkStatus(text);
				if (decoded === void 0) return {
					phase: "parking",
					runningTools: []
				};
				return {
					phase: decoded.phase,
					runningTools: decoded.runningTools,
					...decoded.rearmGoal === void 0 ? {} : { rearmGoal: decoded.rearmGoal }
				};
			}
			publish(sessionId, reading) {
				this.store.update((state) => {
					state.bySession = {
						...state.bySession,
						[String(sessionId)]: reading
					};
				});
			}
			/**
			* Whether the park has already answered for this header: with nothing
			* registered, no session can be paused, so a header that says this session is
			* running carries the whole fact and the read that would confirm it is a host
			* round-trip plus two records in that session's log for nothing.
			*
			* A header the host last showed on its way to a park is never answered this
			* way: that reading is newer than the aggregate the derivation rests on, and
			* only a fresh host answer may replace it.
			*/
			answerIsKnown(sessionId) {
				const phase = this.store.getSnapshot().bySession[String(sessionId)]?.phase;
				if (phase !== void 0 && phase !== "active") return false;
				return this.nothingParked();
			}
			/**
			* Whether the whole-app answer says the park holds nothing at all: the one
			* predicate the derivation below and its revocation share.
			*/
			nothingParked() {
				const aggregate = this.aggregate();
				return aggregate?.kind === "reported" && aggregate.status.registered === 0;
			}
			/**
			* Answer one header from the whole-app verdict, and remember that it was that
			* kind of answer: the sessions to read for real are exactly the ones the
			* aggregate may have been wrong about.
			*/
			deriveActive(sessionId) {
				this.derived.add(sessionId);
				this.publish(sessionId, {
					phase: "active",
					runningTools: []
				});
			}
			/**
			* The whole-app answer moved. Whatever was answered from "nothing is
			* registered" is read for real the moment that stops holding — the session a
			* header stood in for may be the one the park just took, possibly parked from
			* another window whose change this browser only sees as the forwarded event.
			* Called on every published aggregate, so it must do nothing while the
			* derivation still holds.
			*/
			reconsider() {
				if (this.derived.size === 0 || this.lifetime.aborted || this.nothingParked()) return;
				for (const sessionId of this.derived) this.owed.add(sessionId);
				this.derived.clear();
				this.burst.next();
			}
			/**
			* Decide what the burst owes after a read: another look while a change this
			* browser has not answered is still outstanding, and nothing once none is.
			*
			* A phase that is still moving is left alone. The host announces every
			* transition on its command channel — the flush that settles a park included,
			* which changes no registration of its own — so a read that finds `draining`
			* or `parking` is the answer to the transition that produced it, and watching
			* that phase from here would spend reads on a move that is going to speak for
			* itself. What the burst still owes is the delivery of an announcement: a read
			* still armed when the change arrived, and a read for a change that landed
			* while the last pass was in flight.
			*
			* The one transition that cannot speak for itself is the one this browser's
			* own echo window swallowed: a press reads the host, the park moves while the
			* window is still open, and the changes that would have announced it look
			* exactly like the press's own registrations. So an action that left a phase
			* still moving asks for one look when that window closes, and only then — the
			* read is owed at a moment, not watched. Once nothing is owed, the last
			* reading stays on screen; the next change, the next user action, or the shell
			* handing this control a session again is what asks next.
			*/
			follow() {
				if (this.lifetime.aborted) {
					this.burst.stop();
					return;
				}
				if (this.owed.size === 0) {
					const hidden = this.burst.absorbing && this.moving();
					if (hidden) this.burst.recheckAfterEcho();
					this.trailing = hidden;
					this.burst.stop();
					return;
				}
				this.burst.next();
			}
			/**
			* Whether any shown session's last reading is a phase the host has not
			* finished walking — the only states an action's own echo could be hiding a
			* transition behind.
			*/
			moving() {
				const shown = this.store.getSnapshot().bySession;
				for (const sessionId of this.shown) {
					const phase = shown[String(sessionId)]?.phase;
					if (phase !== void 0 && MOVING.has(phase)) return true;
				}
				return false;
			}
			/**
			* Follow the page in and out of view. A hidden page is not being read — and
			* the read the burst was about to take is not lost, it waits for the page to
			* come back.
			*/
			watchVisibility() {
				this.burst.checkVisibility();
			}
		};
		//#endregion
		//#region lib/types/client/view.js
		/**
		* The controls' phase → view mapping.
		*
		* Kept pure functions of the published reading so the rendering decision — what
		* the button says, whether it accepts a press, and which state label is visible
		* — is asserted without a browser renderer. Labels are KEYS, not copy: the
		* visible sentence is localized, and the host's own names join it as data.
		* @module dsh-pause-session/client/view
		*/
		/**
		* Whether the pause control renders on one session at all.
		*
		* The control is the user's button for a session's work, and that work includes
		* the subagents under it — which is why the press covers the tree and why the
		* button does not belong inside the tree. The client can tell: a Session
		* snapshot carries a `subagent` field, the same signal the read-only composer
		* reads. A subagent's service is not the user's to pause: its parent's control
		* already speaks for it, and a second button here would offer to stop "a
		* session" from inside a child.
		* @param subagent - the session snapshot's own subagent fact, absent when unknown.
		* @returns whether this session's header renders the control.
		*/
		function showsPauseControl(subagent) {
			return subagent === null || subagent === void 0;
		}
		/**
		* One reading's goal opt-out, as the view carries it. Only an answered flag
		* becomes a field: a missing one must stay missing through the mapping, or the
		* renderer would show the product default as if the host had said it.
		* @param reading - the host's answer.
		* @returns the field to spread into the view, empty when the host said nothing.
		*/
		function goalOf(reading) {
			return reading.rearmGoal === void 0 ? {} : { rearmGoal: reading.rearmGoal };
		}
		/**
		* Map one reading to its view.
		* @param reading - the host-reported reading, or `undefined` before the first answer.
		* @returns the view for that reading.
		*/
		function pauseView(reading) {
			switch (reading?.phase) {
				case "active": return {
					paused: false,
					enabled: true,
					ariaKey: "pause.aria",
					runningTools: []
				};
				case "draining": return {
					paused: true,
					enabled: true,
					ariaKey: "draining.aria",
					labelKey: "state.draining",
					runningTools: reading.runningTools,
					...goalOf(reading)
				};
				case "parking": return {
					paused: true,
					enabled: true,
					ariaKey: "parking.aria",
					labelKey: "state.parking",
					runningTools: [],
					...goalOf(reading)
				};
				case "safe": return {
					paused: true,
					enabled: true,
					ariaKey: "safe.aria",
					labelKey: "state.safe",
					runningTools: [],
					...goalOf(reading)
				};
				case "flush-failed": return {
					paused: true,
					enabled: true,
					ariaKey: "flushFailed.aria",
					labelKey: "state.flushFailed",
					runningTools: [],
					...goalOf(reading)
				};
				case "unavailable": return {
					paused: false,
					enabled: false,
					ariaKey: "unavailable.aria",
					runningTools: []
				};
				case void 0: return {
					paused: false,
					enabled: false,
					ariaKey: "checking.aria",
					runningTools: []
				};
			}
		}
		/** The four decisions, in the order a user reads them: least to most cautious. */
		const TRIAGE_ACTION_VIEWS = [
			{
				action: "continue",
				labelKey: "triage.continue",
				ariaKey: "triage.continue.aria"
			},
			{
				action: "note",
				labelKey: "triage.note",
				ariaKey: "triage.note.aria"
			},
			{
				action: "review",
				labelKey: "triage.review",
				ariaKey: "triage.review.aria"
			},
			{
				action: "leave",
				labelKey: "triage.leave",
				ariaKey: "triage.leave.aria"
			}
		];
		/**
		* The fifth listed verb, rendered apart from the four decisions: it is a
		* switch on what the NEXT resume may spend, not a way to decide this row.
		*/
		const TRIAGE_GOAL_VIEW = {
			action: "goal",
			labelKey: "triage.goal",
			ariaKey: "triage.goal.aria"
		};
		/** The word each non-clean phase is shown as. */
		const PHASE_KEY = {
			draining: "triage.phase.draining",
			parking: "triage.phase.parking",
			"flush-failed": "triage.phase.flushFailed"
		};
		/**
		* Map one decision-list reading to its view.
		* @param reading - the host-reported list, or `undefined` before the panel asked.
		* @returns the rows as the panel renders them.
		*/
		function triageView(reading) {
			if (reading === void 0 || reading.kind === "unavailable") return {
				visible: false,
				rows: []
			};
			return {
				visible: true,
				rows: reading.rows.map((row) => ({
					sessionId: row.sessionId,
					phaseKey: PHASE_KEY[row.phase],
					...row.lastEvent === void 0 ? {} : { stopped: row.turn === void 0 ? row.lastEvent : `${row.lastEvent} · turn ${String(row.turn)}${row.step === void 0 ? "" : ` step ${String(row.step)}`}` },
					unknownTools: row.traces.map((trace) => trace.tool),
					wakeable: row.wakeable,
					readable: row.reading === "read",
					rearmGoal: row.rearmGoal
				}))
			};
		}
		/**
		* Map one whole-app reading to its view.
		* @param reading - the host-reported reading, or `undefined` before the first answer.
		* @returns the view for that reading.
		*/
		function globalPauseView(reading) {
			if (reading === void 0) return {
				visible: false,
				enabled: false,
				ariaKey: "all.checking.aria",
				action: "none",
				detail: "",
				caveats: [],
				unclean: 0
			};
			if (reading.kind === "unavailable") return {
				visible: false,
				enabled: false,
				ariaKey: "unavailable.aria",
				action: "none",
				detail: "",
				caveats: [],
				unclean: 0
			};
			const { status } = reading;
			const caveats = [];
			if (status.blind.includes("jobs")) caveats.push({
				key: "all.caveat.blindJobs",
				names: []
			});
			else if (status.jobs.length > 0) caveats.push({
				key: "all.caveat.jobs",
				names: status.jobs
			});
			if (status.blind.includes("trees")) caveats.push({
				key: "all.caveat.blindTrees",
				names: []
			});
			else if (status.unreadTrees.length > 0) caveats.push({
				key: "all.caveat.unread",
				names: status.unreadTrees
			});
			if (status.unresumable.length > 0) caveats.push({
				key: "all.caveat.unresumable",
				names: status.unresumable
			});
			const verdict = status.verdict;
			if (verdict !== "safe" && status.stalled.length > 0) caveats.push({
				key: "all.caveat.stalled",
				names: status.stalled
			});
			const base = {
				visible: true,
				enabled: true,
				caveats,
				unclean: status.stalled.length
			};
			switch (verdict) {
				case "idle": return {
					...base,
					ariaKey: "all.pause.aria",
					action: "pause-all",
					detail: ""
				};
				case "safe": return {
					...base,
					ariaKey: "all.resume.aria",
					action: "resume-all",
					labelKey: "all.safe",
					detail: `${String(status.safe)}/${String(status.registered)}`
				};
				case "waiting": return status.draining.length > 0 || status.parking > 0 ? {
					...base,
					ariaKey: "all.resume.aria",
					action: "resume-all",
					labelKey: "all.finishing",
					detail: `${String(status.safe)}/${String(status.registered)}`
				} : {
					...base,
					enabled: false,
					ariaKey: "all.unclean.aria",
					action: "none",
					labelKey: "all.unclean",
					detail: String(status.stalled.length)
				};
			}
		}
		//#endregion
		//#region lib/types/client/global.js
		/**
		* Browser-side reading and driving of the host's whole-app park state.
		*
		* The same one live channel the per-session control uses — a session command
		* run through `ctx.remote.commands.execute`, plus the forwarded
		* `commands/change` event as the only notification — carries the aggregate
		* here. There is no push channel a third-party plugin can add, so the browser
		* asks: `pause-state-all` is registered globally and its RESULT carries the
		* whole-app status as of the read.
		*
		* The command channel is session-addressed, so the control needs one session
		* to talk through. It picks a user session the host can serve (never a
		* subagent's own session), preferring the one on screen; with no session at
		* all there is nothing to ask, and the control claims nothing rather than
		* inventing an answer. Once the host's own answer names the session the park
		* belongs to, reads are addressed there instead: a read writes two records into
		* the address session's transcript, and they belong in the session being parked
		* rather than in whatever the user happens to be looking at. That name outlives
		* the phases — a session that drained and parked cleanly names nothing else — so
		* a clean park is addressed like a moving one. Failing that, the session the
		* last answer reported as registered is remembered, then the one a read was last
		* served through — an address change is the user looking somewhere else, not
		* news about the park, and a park that has emptied out is no reason to start
		* writing rows into every session the user opens next. An address that stops
		* answering (its agent is gone) is forgotten and the read falls back to the next
		* one, the session the shell asks with last, so a stale address costs an honest
		* answer rather than a control that can never speak again.
		*
		* Every phase a session reaches announces itself through the registry — a
		* transition re-registers that session's status verb — so a change is what buys
		* the next read, and the flush that settles a park is announced like every other
		* step (`./burst.ts`). A read that finds work still in flight is therefore the
		* answer to the transition that produced it rather than a reason to keep asking;
		* what the burst still owes is the delivery of a change, and the rows of a panel
		* whose own read did not answer. A settled answer is left on screen unread: the
		* panel stays readable and the pill keeps saying what it says, but the browser
		* stops spending host round-trips and log records on a state that has stopped
		* moving. What owes a read is the host's forwarded registry change, the user's
		* own press or decision, and the first read at mount; once an answer is on
		* screen, the shell handing this control another session to ask through is none
		* of those. A press, a decision and an opened panel each read the host as they
		* run, and the changes they set off are that action's own echo: those are
		* absorbed for a short window (`./burst.ts`), so a forwarded change owes a read
		* exactly when something moved that this browser did not do — with one look owed
		* at the close of that window when the reading the action left is still moving,
		* which is how a park that reaches its final phase inside the echo window is
		* still read.
		* @module dsh-pause-session/client/global
		*/
		const INITIAL = {
			global: void 0,
			panelOpen: false,
			triage: void 0
		};
		/** The command one listed verb runs, named from the one vocabulary the host registers. */
		const TRIAGE_DECISION_COMMAND = {
			continue: TRIAGE_CONTINUE_COMMAND,
			note: TRIAGE_NOTE_COMMAND,
			review: TRIAGE_REVIEW_COMMAND,
			leave: TRIAGE_LEAVE_COMMAND,
			goal: TRIAGE_GOAL_COMMAND
		};
		/**
		* The session a whole-app command is addressed to.
		*
		* A subagent's own session is never addressed: its agent belongs to a parent
		* and is not the host's business to drive from the shell. Among the rest, the
		* one on screen is the best address (its agent is live by construction), then
		* any session the host reports as running, then any at all.
		* @param state - the session list snapshot the shell provides.
		* @returns the address, or `undefined` when the app has no session to ask through.
		*/
		function addressingSession(state) {
			const usable = state.ids.filter((id) => {
				const row = state.byId[String(id)];
				return row !== void 0 && row.origin !== "subagent" && row.parentId === void 0;
			});
			return usable.find((id) => (state.byId[String(id)]?.retainedBy?.mainView ?? 0) > 0) ?? usable.find((id) => state.byId[String(id)]?.running === true) ?? usable[0];
		}
		/**
		* The registered sessions one whole-app answer names, best address first: the
		* one still draining is the one this host is executing against right now, the
		* rest is the host's own vocabulary for a registered session it is not going to
		* move any further.
		*
		* A stalled or unreadable record is deliberately not an address for a read —
		* this host may not hold that session at all, and a read that could not be
		* delivered would report "unavailable" for a transport reason rather than a
		* state — but it is still a registered session, which is all the remembered
		* address is for. The host's own answer is JSON: the branded ids arrive as the
		* strings they were encoded as, exactly like the ids the shell hands the pill.
		* @param status - the host's last whole-app answer.
		* @returns the registered sessions the answer names, best first.
		*/
		function registeredSessions(status) {
			return [
				...status.draining,
				...status.stalled,
				...status.unresumable,
				...status.unreadTrees
			];
		}
		/**
		* The session a registered park owns, when the host's answer names one that is
		* still moving. This is how a read stops landing in whatever session the user
		* happens to be looking at.
		* @param status - the host's last whole-app answer.
		* @returns a draining session, or `undefined` when the answer names none.
		*/
		function registeredAddress(status) {
			const draining = status.draining[0];
			return draining === void 0 ? void 0 : draining;
		}
		/**
		* The session the host names as the park's own, whatever phase the park
		* reached — the address a whole-app read belongs at.
		*
		* This is the fact {@link registeredAddress} cannot carry once a park is clean:
		* a session that reached `safe` has nothing left to do, so no bucket names it,
		* and a reader in another window would fall back to whatever session it is
		* showing. An answer written before this field existed names no session here:
		* an absent address, never one to guess at.
		* @param status - the host's last whole-app answer.
		* @returns the session the park belongs to, or `undefined` when the answer names none.
		*/
		function parkedAddress(status) {
			return status.parkedAt === void 0 ? void 0 : status.parkedAt;
		}
		/** Owns the published whole-app reading; nothing else writes that state. */
		var PauseGlobalControl = class {
			commands;
			lifetime;
			/** State source the whole-app contribution binds its selector hook to. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL);
			/** The session the shell asked this control through; reads start here. */
			address;
			/**
			* The last session an answer reported as registered — the address a read
			* falls back to when the host's own answer names no parked session, which is
			* every reading written before that field existed.
			*
			* The buckets that feed it name only what is still moving, so they say
			* nothing about a park that finished cleanly; the park's own name is the live
			* fact, and this memory is what keeps the rows in the park's transcript for an
			* answer that predates it. An empty registry does not clear it: a park whose
			* sessions stopped moving has not moved out of its sessions.
			*/
			lastRegistered;
			/**
			* The session an aggregate read was last served through. Later reads keep
			* going there: every read is two records in the address session's log, and
			* the shell's address follows whatever the user is looking at, which is not
			* where a row about the park belongs.
			*/
			served;
			/** Highest decision-list read requested: an answer older than it is dropped. */
			latestTriage = 0;
			/** Highest read sequence requested: an answer older than it is dropped. */
			latest = 0;
			/**
			* Whether a registry change has arrived that no completed read pass has
			* answered. Set only for a change that is news — an absorbed echo of this
			* browser's own action is already answered by that action's read.
			*/
			owed = false;
			/** The bounded burst of reads one transition buys; see `./burst.ts`. */
			burst;
			/**
			* @param commands - the Client-callable command namespace.
			* @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
			* @param windowMs - how long the burst collects the registrations of one
			* transition before its first read; also the wait after a press.
			* @param policy - the burst waits and visibility source; defaults to the real page.
			*/
			constructor(commands, lifetime, windowMs = 400, policy = DEFAULT_BURST_POLICY) {
				this.commands = commands;
				this.lifetime = lifetime;
				this.burst = new ReadBurst(() => {
					this.readAll();
				}, {
					...policy,
					windowMs,
					waitsMs: burstWaits(windowMs)
				});
			}
			/**
			* The shell handed this control a session: the one the pill mounted on, or
			* the one the user has just moved to. Only a control with no answer yet reads
			* here — the view moving is not the park moving, and after the first answer
			* the forwarded registry change and the user's own press are what ask again.
			* A read that came back with nothing is not an answer, so moving to another
			* session is one more chance to reach the host rather than a control that
			* stays mute until something else happens to change. The address is kept
			* either way: it is where this control's presses and its decision list go, and
			* the fallback a remembered address falls back to.
			* @param sessionId - the session the shell asks through.
			* @returns after this read's answer is published or superseded by a newer one.
			*/
			async refresh(sessionId) {
				this.address = sessionId;
				if (this.answered()) return;
				await this.readAggregate();
				this.follow();
			}
			/** Whether the host has answered: a state, not the absence of one it never sent. */
			answered() {
				return this.store.getSnapshot().global?.kind === "reported";
			}
			/**
			* The host's command registry changed: something may have moved, so a burst
			* is owed. The reads run on the burst's own schedule rather than here, which
			* is what coalesces a tick's worth of changes — parking N sessions announces
			* three registrations each, and a phase change re-registers one more — into
			* one burst. A change that is this browser's own action's echo owes nothing:
			* the action read the host as it ran.
			*/
			refreshAll() {
				if (this.address === void 0 || this.lifetime.aborted) return;
				if (!this.burst.trigger()) return;
				this.owed = true;
			}
			/**
			* One read of the whole screen: the aggregate, plus the decision list while
			* the user has it open. A closed panel spends no command calls on rows nobody
			* is reading.
			*/
			async readAll() {
				if (this.target() === void 0 || this.lifetime.aborted) {
					this.owed = false;
					this.burst.stop();
					return;
				}
				this.owed = false;
				await this.readAggregate();
				if (this.store.getSnapshot().panelOpen) await this.readTriage();
				this.follow();
			}
			/**
			* The session a read goes through: the one the park is still draining, else
			* the one the host names as the park's own, else the one a read was last
			* served through, else the session the shell is on now. The park's own address
			* comes first because a read's rows land in the transcript it was taken
			* through, and the park — not the reader — is what they are about; its name
			* survives the clean case, where every bucket above is empty and a park that
			* finished would otherwise have no address at all.
			* @param skip - an address this read already tried and could not reach. The
			* fallback is the next candidate rather than the same one again.
			*/
			target(skip) {
				const current = this.store.getSnapshot().global;
				const named = current?.kind === "reported" ? current.status : void 0;
				return [
					named === void 0 ? void 0 : registeredAddress(named),
					named === void 0 ? void 0 : parkedAddress(named),
					this.lastRegistered,
					this.served,
					this.address
				].find((candidate) => candidate !== void 0 && candidate !== skip);
			}
			/**
			* Ask the host for the aggregate through the session a read goes through,
			* with the one fallback an address that stopped answering is worth: the
			* remembered address is forgotten, and the read is taken again through the
			* next one — the session the shell is on at the latest. A memory of a session
			* this host no longer holds would otherwise leave the control unable to say
			* anything at all, and a single retry is the whole price of keeping it honest.
			*/
			async readAggregate() {
				const address = this.target();
				if (address === void 0) return;
				if (!await this.readAt(address)) return;
				const fallback = this.target(address);
				if (fallback === void 0) return;
				await this.readAt(fallback);
			}
			/**
			* Publish one aggregate answer, unless a newer read was requested while this
			* one was in flight: that answer would show a state the host has moved past.
			* A served address is remembered, and one that did not answer is forgotten —
			* that is what makes the read fall back to the next address rather than ask
			* it again.
			* @param sessionId - the session this read goes through.
			* @returns whether this read came back without an answer; a superseded read is
			* not one, because the newer read already owns the outcome.
			*/
			async readAt(sessionId) {
				const sequence = ++this.latest;
				const reading = await this.read(sessionId);
				if (this.latest !== sequence) return false;
				if (reading.kind === "reported") {
					this.served = sessionId;
					const registered = registeredSessions(reading.status)[0];
					if (registered !== void 0) this.lastRegistered = registered;
				} else {
					if (this.served === sessionId) this.served = void 0;
					if (this.lastRegistered === sessionId) this.lastRegistered = void 0;
				}
				this.publish(reading);
				return reading.kind === "unavailable";
			}
			/**
			* Open or close the decision list. Opening asks the host for the rows; there
			* is no state to show without that answer. Opening is also a client action
			* that reads, so the changes it sets off are absorbed rather than read back,
			* and whether the burst owes anything is what its own read decides.
			* @param open - whether the panel should be showing.
			*/
			setPanel(open) {
				this.store.update((state) => {
					state.panelOpen = open;
				});
				if (open) {
					this.burst.absorb();
					this.refreshTriage();
					return;
				}
				this.follow();
			}
			/**
			* Ask the host for the decision list through the session the user is on. The
			* list is recorded per calling session and the decisions act only on rows
			* that session was shown, so this read — unlike the aggregate — stays on the
			* shell's own address.
			*/
			async refreshTriage() {
				await this.readTriage();
				this.follow();
			}
			/**
			* Read the aggregate again because the user asked this control to act: the
			* address is the session the shell is on, since a press is a user action on
			* the session the user is looking at, and the host's answer is what the
			* control shows next.
			* @param sessionId - the session the shell is on.
			*/
			async reread(sessionId) {
				this.address = sessionId;
				await this.readAggregate();
				this.follow();
			}
			/** One decision-list read, addressed at the session the user is on. */
			async readTriage() {
				const address = this.address;
				if (address === void 0) return;
				const sequence = ++this.latestTriage;
				const reading = await this.readTriageRows(address);
				if (this.latestTriage !== sequence) return;
				this.store.update((state) => {
					state.triage = reading;
				});
			}
			/**
			* Take one listed verb on one listed session, addressed through the session
			* the user is on. The list is read first, because the host acts only on rows
			* it has shown the calling session, and read again afterwards because the
			* host's answer — not this control's assumption — is what the next render
			* shows: a decision can release a session, and the goal switch changes what
			* the row itself says.
			* @param sessionId - the listed session to act on.
			* @param action - which listed verb was taken.
			*/
			async decide(sessionId, action) {
				const address = this.address;
				if (address === void 0) return;
				this.burst.absorb();
				await this.refreshTriage();
				await this.commands.execute(address, `/${TRIAGE_DECISION_COMMAND[action]} ${sessionId}`, [], this.lifetime);
				await this.refreshTriage();
				await this.reread(address);
			}
			/**
			* Press the pill: park everything, or release everything the park owns.
			* Which one it is comes from the host's own last answer, never from a local
			* flip; the state shown afterwards is the host's answer again. A reading the
			* view does not turn into a verb — every registered session is one the host
			* will not wake — is not pressed at all.
			* @param sessionId - the session to address the verb to.
			* @returns after the control re-reads the host.
			*/
			async toggle(sessionId) {
				const current = this.store.getSnapshot().global;
				if (current === void 0 || current.kind !== "reported") return;
				const action = globalPauseView(current).action;
				if (action === "none") return;
				const line = action === "pause-all" ? `/${PAUSE_ALL_COMMAND}` : `/${RESUME_ALL_COMMAND}`;
				this.burst.absorb();
				if (!(await this.commands.execute(sessionId, line, [], this.lifetime)).ok) {
					this.publish({ kind: "unavailable" });
					this.follow();
					return;
				}
				await this.reread(sessionId);
			}
			/** Ask the host for the decision list, in the browser's vocabulary. */
			async readTriageRows(sessionId) {
				const answered = await this.commands.execute(sessionId, `/${TRIAGE_COMMAND}`, [], this.lifetime);
				if (!answered.ok || answered.value === void 0) return { kind: "unavailable" };
				const text = answered.value.result.kind === "success" ? answered.value.result.text : void 0;
				const list = text === void 0 ? void 0 : decodeTriageList(text);
				return list === void 0 ? { kind: "unavailable" } : {
					kind: "reported",
					rows: list.rows
				};
			}
			/** Ask the host what the whole-app park state is, in the browser's vocabulary. */
			async read(sessionId) {
				const answered = await this.commands.execute(sessionId, `/${STATE_ALL_COMMAND}`, [], this.lifetime);
				if (!answered.ok || answered.value === void 0) return { kind: "unavailable" };
				const text = answered.value.result.kind === "success" ? answered.value.result.text : void 0;
				const status = text === void 0 ? void 0 : decodeGlobalStatus(text);
				if (status === void 0) return { kind: "unavailable" };
				return {
					kind: "reported",
					status
				};
			}
			publish(reading) {
				this.store.update((state) => {
					state.global = reading;
				});
			}
			/**
			* Decide what the burst owes after a read: another look while a change this
			* browser has not answered is outstanding, or while the open panel is still
			* owed rows, and nothing once neither holds.
			*
			* A registered session standing at the park point is left alone: the flush
			* that settles it announces itself on the command channel like every other
			* transition, so watching it from here would spend reads on a move that is
			* going to speak for itself. A verdict that stays `waiting` because a record
			* is stalled, unresumable or unread is not settling either: nothing in this
			* process will change it, and a session that starts moving again registers its
			* markers, which is what asks next.
			*
			* The one transition that cannot speak for itself is the one this browser's
			* own echo window swallowed: a press reads the host, the park reaches its
			* final phase while the window is still open, and the changes that would have
			* announced it look exactly like the press's own registrations. An action that
			* left the park moving therefore asks for one look when that window closes,
			* and only then. Once nothing is owed, the last reading stays published — the
			* verdict, the pill and the rows are exactly what the host last reported.
			*/
			follow() {
				if (this.lifetime.aborted) {
					this.burst.stop();
					return;
				}
				if (!this.owed && !this.unansweredPanel()) {
					if (this.burst.absorbing && this.moving()) this.burst.recheckAfterEcho();
					this.burst.stop();
					return;
				}
				this.burst.next();
			}
			/**
			* Whether the park this control last read still has work on its way — the only
			* state an action's own echo could be hiding a transition behind. A record
			* that is stalled, unresumable or unread is not moving: nothing in this
			* process will finish it.
			*/
			moving() {
				const current = this.store.getSnapshot().global;
				return current?.kind === "reported" && (current.status.draining.length > 0 || current.status.parking > 0);
			}
			/**
			* Whether the open panel is still owed its rows. Opening the panel reads them,
			* so this holds only after a read that did not answer — the one debt no change
			* created, and the one place a retry is the difference between an empty panel
			* and the facts the host has. It is bounded by the burst like everything else.
			*/
			unansweredPanel() {
				const state = this.store.getSnapshot();
				return state.panelOpen && (state.triage === void 0 || state.triage.kind === "unavailable");
			}
			/**
			* Follow the page in and out of view. A hidden page is not being read — and
			* the read the burst was about to take is not lost, it waits for the page to
			* come back.
			*/
			watchVisibility() {
				this.burst.checkVisibility();
			}
		};
		//#endregion
		//#region lib/types/client/icons.js
		/** 16px stroke icon (currentColor): the two bars of a pause. */
		function PauseIcon() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				"aria-hidden": "true",
				width: 16,
				height: 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [(0, react_jsx_runtime.jsx)("path", { d: "M9 5v14" }), (0, react_jsx_runtime.jsx)("path", { d: "M15 5v14" })]
			});
		}
		/** 16px stroke icon (currentColor): the triangle of a resume. */
		function ResumeIcon() {
			return (0, react_jsx_runtime.jsx)("svg", {
				"aria-hidden": "true",
				width: 16,
				height: 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: (0, react_jsx_runtime.jsx)("path", { d: "M7 4.5v15l12-7.5z" })
			});
		}
		/**
		* 16px stroke icon (currentColor): the rings of a target, for the goal switch
		* on the session header. Drawn at 16px like the pause and resume glyphs it sits
		* beside rather than the 14px marks the two reports use.
		*/
		function GoalIcon() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				"aria-hidden": "true",
				width: 16,
				height: 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [(0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "8"
				}), (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "3"
				})]
			});
		}
		/**
		* 14px stroke icon (currentColor): the mark that a report carries a caveat.
		* A glyph rather than copy, so the facts it stands for stay in the locale
		* dictionaries beside everything else the user reads.
		*/
		function CaveatIcon() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				"aria-hidden": "true",
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "12",
						cy: "12",
						r: "9"
					}),
					(0, react_jsx_runtime.jsx)("path", { d: "M12 7.5v5.5" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M12 16.5v.5" })
				]
			});
		}
		/** 14px stroke icon (currentColor): the chevron that opens the decision list. */
		function ChevronIcon() {
			return (0, react_jsx_runtime.jsx)("svg", {
				"aria-hidden": "true",
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: (0, react_jsx_runtime.jsx)("path", { d: "M6 15l6-6 6 6" })
			});
		}
		//#endregion
		//#region \0dsh-css:src/client/button.module.css.mjs
		const css = ".FCO1_q_dsp{align-items:center;display:inline-flex;position:relative}.FCO1_q_dspBtn{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;padding:0;transition:color .12s,background .12s,border-color .12s;display:inline-flex}.FCO1_q_dspBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.FCO1_q_dspBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspBtn:disabled{cursor:default;opacity:.5}.FCO1_q_dspBtn:disabled:hover{color:var(--dsw-alias-label-secondary);background:0 0;border-color:#0000}.FCO1_q_dspGoal{width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;margin-left:2px;padding:0;transition:color .12s,background .12s,border-color .12s;display:inline-flex}.FCO1_q_dspGoal[aria-pressed=true]{color:var(--dsw-alias-label-secondary)}.FCO1_q_dspGoal:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.FCO1_q_dspGoal:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}@media (prefers-reduced-motion:reduce){.FCO1_q_dspGoal{transition:none}}.FCO1_q_dspState{color:var(--dsw-alias-label-secondary);white-space:nowrap;user-select:none;padding-left:6px;font-size:12px;line-height:18px}.FCO1_q_dspTip{z-index:20;max-width:min(46ch,100vw - 48px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);white-space:nowrap;text-overflow:ellipsis;opacity:0;pointer-events:none;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;transition:opacity .12s,transform .12s;position:absolute;top:calc(100% + 6px);left:0;overflow:hidden;transform:translateY(-2px);box-shadow:0 4px 12px #0000002e}.FCO1_q_dsp:hover .FCO1_q_dspTip,.FCO1_q_dspBtn:focus-visible+.FCO1_q_dspTip{opacity:1;transform:translateY(0)}@media (prefers-reduced-motion:reduce){.FCO1_q_dspBtn,.FCO1_q_dspTip{transition:none}}.FCO1_q_dspPill{align-items:center;display:inline-flex;position:relative}.FCO1_q_dspPillBtn{max-width:min(38ch,100vw - 48px);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;border-radius:999px;align-items:center;gap:6px;padding:5px 10px;font-size:12px;line-height:18px;transition:color .12s,background .12s,border-color .12s;display:inline-flex;box-shadow:0 4px 12px #00000024}.FCO1_q_dspPillBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillIcon{justify-content:center;width:28px;height:28px;padding:0}.FCO1_q_dspPillBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspPillBtn:disabled{cursor:default;opacity:.5}.FCO1_q_dspPillText{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.FCO1_q_dspPillDetail{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}.FCO1_q_dspPillWarn{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));font-weight:600}@media (prefers-reduced-motion:reduce){.FCO1_q_dspPillBtn{transition:none}}.FCO1_q_dspPillTriage{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;border-radius:999px;align-items:center;gap:2px;margin-right:4px;padding:4px 8px;font-size:12px;line-height:18px;display:inline-flex;box-shadow:0 4px 12px #00000024}.FCO1_q_dspPillTriage:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillTriage:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspPillPanel{z-index:30;text-align:left;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:8px;width:min(52ch,100vw - 48px);max-height:min(60vh,420px);padding:10px 12px;display:flex;position:absolute;top:calc(100% + 6px);right:0;overflow-y:auto;box-shadow:0 8px 24px #00000038}.FCO1_q_dspPillPanelHead{justify-content:space-between;align-items:center;gap:8px;font-weight:600;display:flex}.FCO1_q_dspPillPanelNote{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}.FCO1_q_dspPillRows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.FCO1_q_dspPillRow{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;flex-direction:column;gap:4px;padding:8px;display:flex}.FCO1_q_dspPillRowHead{justify-content:space-between;align-items:baseline;gap:8px;display:flex}.FCO1_q_dspPillRowId{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.FCO1_q_dspPillRowPhase{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));flex:none;font-size:12px}.FCO1_q_dspPillRowFacts{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:2px;font-size:12px;line-height:18px;display:flex}.FCO1_q_dspPillRowActions{flex-wrap:wrap;gap:6px;padding-top:2px;display:flex}.FCO1_q_dspPillAction{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;background:0 0;border-radius:4px;padding:3px 8px;font-size:12px;line-height:16px}.FCO1_q_dspPillAction:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillAction:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}";
		const tagId = "dsh-pause-session/button.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-pause-session";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var button_module_css_default = {
			"dsp": "FCO1_q_dsp",
			"dspBtn": "FCO1_q_dspBtn",
			"dspGoal": "FCO1_q_dspGoal",
			"dspPill": "FCO1_q_dspPill",
			"dspPillAction": "FCO1_q_dspPillAction",
			"dspPillBtn": "FCO1_q_dspPillBtn",
			"dspPillDetail": "FCO1_q_dspPillDetail",
			"dspPillIcon": "FCO1_q_dspPillIcon",
			"dspPillPanel": "FCO1_q_dspPillPanel",
			"dspPillPanelHead": "FCO1_q_dspPillPanelHead",
			"dspPillPanelNote": "FCO1_q_dspPillPanelNote",
			"dspPillRow": "FCO1_q_dspPillRow",
			"dspPillRowActions": "FCO1_q_dspPillRowActions",
			"dspPillRowFacts": "FCO1_q_dspPillRowFacts",
			"dspPillRowHead": "FCO1_q_dspPillRowHead",
			"dspPillRowId": "FCO1_q_dspPillRowId",
			"dspPillRowPhase": "FCO1_q_dspPillRowPhase",
			"dspPillRows": "FCO1_q_dspPillRows",
			"dspPillText": "FCO1_q_dspPillText",
			"dspPillTriage": "FCO1_q_dspPillTriage",
			"dspPillWarn": "FCO1_q_dspPillWarn",
			"dspState": "FCO1_q_dspState",
			"dspTip": "FCO1_q_dspTip"
		};
		//#endregion
		//#region lib/types/client/pill.js
		/**
		* The whole-app control: one pill in the conversation header's utilities row
		* that answers "can I close the lid?", presses the park or the release, and —
		* when something did not stop cleanly — opens the morning decision list.
		*
		* The header's right-aligned utilities row is inside the conversation column,
		* which is where this control belongs: it answers for every session tree, but
		* it is read while looking at one, and a surface inside the layout is covered
		* by whatever covers that column — a sidebar or a drawer — instead of floating
		* above the whole frame. The decision list hangs from the control into the
		* conversation area below.
		*
		* The pill reads the host through the command channel only (`./global.ts`):
		* with no answer, or with no session to ask through, it renders nothing rather
		* than a state it would have to invent. The decision list is deliberately NOT
		* part of that first read — it costs two more command calls, and a user who
		* never opens it pays nothing; the panel asks for its own rows when it opens.
		* @module dsh-pause-session/client/pill
		*/
		/** One listed session's row, with the four decisions. */
		function TriageSessionRow(props) {
			const { row, decide, t } = props;
			return (0, react_jsx_runtime.jsxs)("li", {
				className: button_module_css_default.dspPillRow,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: button_module_css_default.dspPillRowHead,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: button_module_css_default.dspPillRowId,
							children: row.sessionId
						}), (0, react_jsx_runtime.jsx)("span", {
							className: button_module_css_default.dspPillRowPhase,
							children: t(row.phaseKey)
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: button_module_css_default.dspPillRowFacts,
						children: [row.readable ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("span", { children: [
							t("triage.stopped"),
							": ",
							row.stopped ?? "-"
						] }), (0, react_jsx_runtime.jsx)("span", { children: row.unknownTools.length === 0 ? t("triage.toolsNone") : `${t("triage.tools")}: ${row.unknownTools.join(", ")}` })] }) : (0, react_jsx_runtime.jsx)("span", { children: t("triage.stoppedUnknown") }), row.readable && !row.wakeable ? (0, react_jsx_runtime.jsx)("span", { children: t("triage.noWake") }) : null]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: button_module_css_default.dspPillRowActions,
						children: [TRIAGE_ACTION_VIEWS.map((action) => (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: button_module_css_default.dspPillAction,
							"aria-label": t(action.ariaKey),
							onClick: () => {
								decide(row.sessionId, action.action);
							},
							children: t(action.labelKey)
						}, action.action)), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: button_module_css_default.dspPillAction,
							"aria-label": t(TRIAGE_GOAL_VIEW.ariaKey),
							"aria-pressed": row.rearmGoal,
							onClick: () => {
								decide(row.sessionId, TRIAGE_GOAL_VIEW.action);
							},
							children: t(TRIAGE_GOAL_VIEW.labelKey)
						})]
					})
				]
			});
		}
		/**
		* The whole-app control: what the host says about the whole park, the one
		* press that parks or releases all of it, and the decision list for whatever
		* did not stop cleanly.
		* @param props - session-header runtime, host operations, and localized copy.
		* @returns the control and its panel, or nothing while the host has not answered.
		*/
		function PausePill(props) {
			const { refresh, toggle, setPanel, decide, t, useSessions, useSession } = props;
			const reading = props.usePauseGlobal((state) => state.global);
			const triage = props.usePauseGlobal((state) => state.triage);
			const open = props.usePauseGlobal((state) => state.panelOpen);
			const address = useSessions(addressingSession);
			const view = globalPauseView(reading);
			const list = triageView(triage);
			const visible = showsPauseControl(useSession((snapshot) => snapshot.subagent));
			(0, react.useEffect)(() => {
				if (visible && address !== void 0) refresh(address);
			}, [
				refresh,
				address,
				visible
			]);
			if (!visible || !view.visible || address === void 0) return null;
			const tip = view.caveats.map((caveat) => caveat.names.length === 0 ? t(caveat.key) : `${t(caveat.key)} (${caveat.names.join(", ")})`).join("\n");
			return (0, react_jsx_runtime.jsxs)("span", {
				className: button_module_css_default.dspPill,
				children: [
					!open ? null : (0, react_jsx_runtime.jsxs)("div", {
						className: button_module_css_default.dspPillPanel,
						role: "dialog",
						"aria-label": t("triage.title"),
						children: [(0, react_jsx_runtime.jsxs)("div", {
							className: button_module_css_default.dspPillPanelHead,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: button_module_css_default.dspPillText,
								children: t("triage.title")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: button_module_css_default.dspPillAction,
								"aria-label": t("triage.refresh.aria"),
								onClick: () => {
									setPanel(true);
								},
								children: t("triage.refresh.aria")
							})]
						}), !list.visible ? (0, react_jsx_runtime.jsx)("p", {
							className: button_module_css_default.dspPillPanelNote,
							children: t("triage.reading")
						}) : list.rows.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
							className: button_module_css_default.dspPillPanelNote,
							children: t("triage.empty")
						}) : (0, react_jsx_runtime.jsx)("ul", {
							className: button_module_css_default.dspPillRows,
							children: list.rows.map((row) => (0, react_jsx_runtime.jsx)(TriageSessionRow, {
								row,
								decide,
								t
							}, row.sessionId))
						})]
					}),
					view.unclean === 0 ? null : (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: button_module_css_default.dspPillTriage,
						"aria-label": t("triage.open.aria"),
						"aria-expanded": open,
						title: `${String(view.unclean)} ${t("all.triage")}`,
						onClick: () => {
							setPanel(!open);
						},
						children: [(0, react_jsx_runtime.jsx)(ChevronIcon, {}), (0, react_jsx_runtime.jsx)("span", {
							className: button_module_css_default.dspPillDetail,
							children: view.unclean
						})]
					}),
					(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: view.labelKey === void 0 && view.detail.length === 0 ? `${button_module_css_default.dspPillBtn} ${button_module_css_default.dspPillIcon}` : button_module_css_default.dspPillBtn,
						"aria-label": t(view.ariaKey),
						"aria-pressed": view.action === "resume-all",
						disabled: !view.enabled,
						...tip.length === 0 ? {} : { title: tip },
						onClick: () => {
							toggle(address);
						},
						children: [
							view.action === "resume-all" ? (0, react_jsx_runtime.jsx)(ResumeIcon, {}) : (0, react_jsx_runtime.jsx)(PauseIcon, {}),
							view.labelKey === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
								className: button_module_css_default.dspPillText,
								children: t(view.labelKey)
							}),
							view.detail.length === 0 ? null : (0, react_jsx_runtime.jsx)("span", {
								className: button_module_css_default.dspPillDetail,
								children: view.detail
							}),
							view.caveats.length === 0 ? null : (0, react_jsx_runtime.jsx)("span", {
								className: button_module_css_default.dspPillWarn,
								children: (0, react_jsx_runtime.jsx)(CaveatIcon, {})
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `pause` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"pause.aria": "暂停这个会话及其子代理：下一条模型请求不会发出",
			"pause.tip": "暂停这个会话及其子代理",
			"resume.aria": "恢复这个会话及其子代理",
			"resume.tip": "恢复这个会话及其子代理",
			"draining.aria": "正在暂停：还有工具在运行，工具运行完之后、下一条模型请求发出之前，会话会停住；按下可取消这次暂停",
			"parking.aria": "正在暂停：正在保存待发输入；按下可取消这次暂停",
			"safe.aria": "已暂停：待发输入已保存；按下可恢复",
			"flushFailed.aria": "已暂停，但保存待发输入失败；按下可恢复",
			"state.paused": "已暂停",
			"state.draining": "正在暂停",
			"state.parking": "正在保存",
			"state.safe": "已暂停",
			"state.flushFailed": "保存失败",
			"goal.aria": "恢复时重开目标：恢复这个会话时是否重新打开目标并让它继续运行；按下切换",
			"goal.on.tip": "恢复这个会话会重新打开目标，它会自己继续运行；按下改为不重开",
			"goal.off.tip": "恢复这个会话不会重新打开目标；按下改为重开",
			"checking.aria": "正在读取暂停状态",
			"checking.tip": "正在读取暂停状态",
			"unavailable.aria": "暂停状态不可用",
			"unavailable.tip": "暂停状态不可用",
			"all.pause.aria": "暂停所有运行中的会话及其子代理",
			"all.resume.aria": "恢复所有已暂停的会话",
			"all.idle": "暂停所有会话",
			"all.finishing": "正在暂停",
			"all.unclean": "有会话未暂停",
			"all.unclean.aria": "有会话未暂停，不能在这里恢复；打开清单逐行处理",
			"all.safe": "全部已暂停",
			"all.checking.aria": "正在读取暂停状态",
			"all.caveat.jobs": "后台任务仍在运行",
			"all.caveat.unresumable": "含无法恢复的子代理",
			"all.caveat.stalled": "未暂停，需要你决定",
			"all.caveat.unread": "子代理列表读不出来",
			"all.caveat.blindTrees": "子代理服务未加载，无法检查子代理",
			"all.caveat.blindJobs": "作业服务未加载，无法检查后台任务",
			"triage.open.aria": "查看未暂停的会话清单",
			"triage.title": "未暂停的会话",
			"triage.empty": "没有需要决定的会话",
			"triage.reading": "正在读取清单",
			"triage.unavailable": "清单暂不可读",
			"triage.refresh.aria": "重新读取清单",
			"triage.session.aria": "会话",
			"triage.stopped": "停在",
			"triage.stoppedUnknown": "读不到它的日志，停止位置未知",
			"triage.tools": "未知的工具结果",
			"triage.toolsNone": "没有缺少结果的工具调用",
			"triage.noWake": "这个会话没有待发的模型请求，继续不会发出请求",
			"triage.phase.draining": "工具还在运行时中断",
			"triage.phase.parking": "已暂停，但待发输入未保存",
			"triage.phase.flushFailed": "已暂停，但保存失败",
			"triage.continue": "继续",
			"triage.continue.aria": "继续：不添加消息，直接恢复",
			"triage.note": "继续并附说明",
			"triage.note.aria": "继续并附说明：告诉模型工具结果未知，不要盲目重试",
			"triage.note.hint": "会加入这句话：",
			"triage.review": "只看不运行",
			"triage.review.aria": "只看不运行：不启动会话、不发请求；需要查看时在会话历史里打开",
			"triage.leave": "保持暂停",
			"triage.leave.aria": "保持暂停：不恢复，也不写入任何内容",
			"triage.goal": "恢复时重开目标",
			"triage.goal.aria": "恢复时重开目标：恢复这个会话时是否重新打开目标并让它自己继续运行；按下切换",
			"all.triage": "有待决定的会话"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"pause.aria": "Pause this session and its subagents: their next model request will not be sent",
			"pause.tip": "Pause this session and its subagents",
			"resume.aria": "Resume this session and its subagents",
			"resume.tip": "Resume this session and its subagents",
			"draining.aria": "Pausing: a tool is still running. The session pauses after the tool finishes and before its next model request; press to cancel the pause",
			"parking.aria": "Pausing: saving pending input; press to cancel the pause",
			"safe.aria": "Paused: pending input is saved; press to resume",
			"flushFailed.aria": "Paused, but saving pending input failed; press to resume",
			"state.paused": "Paused",
			"state.draining": "Pausing",
			"state.parking": "Saving",
			"state.safe": "Paused",
			"state.flushFailed": "Save failed",
			"goal.aria": "Re-open goal on resume: whether resuming this session re-opens its goal and lets it run on its own; press to switch",
			"goal.on.tip": "Resuming re-opens the goal, which runs on its own; press to keep it closed",
			"goal.off.tip": "Resuming will not re-open the goal; press to re-open it",
			"checking.aria": "Reading pause state",
			"checking.tip": "Reading pause state",
			"unavailable.aria": "Pause state unavailable",
			"unavailable.tip": "Pause state unavailable",
			"all.pause.aria": "Pause all running sessions and their subagents",
			"all.resume.aria": "Resume all paused sessions",
			"all.idle": "Pause all sessions",
			"all.finishing": "Pausing",
			"all.unclean": "Some sessions are not paused",
			"all.unclean.aria": "Some sessions are not paused and cannot be resumed here; open the list to decide",
			"all.safe": "All Paused",
			"all.checking.aria": "Reading pause state",
			"all.caveat.jobs": "background jobs are still running",
			"all.caveat.unresumable": "contains a subagent that cannot be resumed",
			"all.caveat.stalled": "did not pause; needs your decision",
			"all.caveat.unread": "subagent list could not be read",
			"all.caveat.blindTrees": "subagent service is not loaded, so subagents cannot be checked",
			"all.caveat.blindJobs": "job service is not loaded, so background jobs cannot be checked",
			"triage.open.aria": "Review sessions that did not pause",
			"triage.title": "Sessions that did not pause",
			"triage.empty": "No sessions need a decision",
			"triage.reading": "Reading list",
			"triage.unavailable": "List unavailable",
			"triage.refresh.aria": "Read the list again",
			"triage.session.aria": "Session",
			"triage.stopped": "Stopped at",
			"triage.stoppedUnknown": "Its log cannot be read, so where it stopped is unknown",
			"triage.tools": "Unknown tool results",
			"triage.toolsNone": "No tool call is missing a result",
			"triage.noWake": "This session has no pending model request; continuing sends nothing",
			"triage.phase.draining": "stopped while a tool was still running",
			"triage.phase.parking": "paused but pending input was not saved",
			"triage.phase.flushFailed": "paused but saving failed",
			"triage.continue": "Continue",
			"triage.continue.aria": "Continue: resume without adding a message",
			"triage.note": "Continue with a note",
			"triage.note.aria": "Continue with a note: tell the model the tool result is unknown and not to retry blindly",
			"triage.note.hint": "This text is added:",
			"triage.review": "View only",
			"triage.review.aria": "View only: do not start the session or send a request; open it from your session history to read it",
			"triage.leave": "Leave it paused",
			"triage.leave.aria": "Leave it paused: keep the pause and write nothing",
			"triage.goal": "Re-open goal on resume",
			"triage.goal.aria": "Re-open goal on resume: whether resuming this session re-opens its goal, which then runs on its own; press to switch",
			"all.triage": "sessions need a decision"
		};
		//#endregion
		//#region lib/types/client/index.js
		/**
		* Browser half of dsh-pause-session.
		*
		* Registers two controls: one in the session header's title-adjacent action
		* group (`conversation.session.header.actions`), which pauses or resumes the
		* session it sits on, and one in the header's right-aligned utilities row
		* (`conversation.session.header.utilities`), which answers for the whole app.
		* Both seats are session-scoped and their props carry `sessionId`, so every
		* open session header renders its own pair and switching sessions follows
		* automatically; the whole-app control speaks for every session from the
		* header of the one on screen.
		*
		* The whole-app control sits inside the conversation column rather than in the
		* frame-wide overlay layer: it is read while looking at one conversation, and
		* a sidebar or drawer that covers that area covers the control with it.
		*
		* Both controls are host-authoritative: they read state from the host's command
		* registry and drive it through the host's session commands (`./control.ts` and
		* `./global.ts` document why the command registry is the only live channel a
		* third-party plugin can use). Each stays inert wherever that round-trip is
		* unavailable rather than rendering a control that cannot tell the truth. The
		* header control also reads the whole-app answer the whole-app control
		* publishes, so a park that holds nothing does not cost a host round-trip per
		* header.
		* @module dsh-pause-session/client
		*/
		/** Dictionary namespace owned by this plugin. */
		const NS = "pause";
		/** Required services: the slot registry, the locale registry, and the host round-trip. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.commands"
		];
		/**
		* The session's pause control: pause the session and its subagents before
		* their next model request, or resume them, with the host's own state on screen.
		* Once the host reports the park's goal opt-out, a second switch sits beside it
		* — the only place a session that stopped CLEANLY can be told not to re-open its
		* goal on the next resume, because the decision list shows only the sessions
		* that did not stop cleanly.
		*
		* A subagent session renders nothing: its work is its parent's, the parent's
		* control already covers it, and a button here would offer to pause "a session"
		* from inside a child.
		* @param props - session runtime, host operations, and localized copy.
		* @returns the header action, or nothing on a subagent session.
		*/
		function PauseButton(props) {
			const { sessionId, refresh, toggle, toggleGoal, t, useSession } = props;
			const view = pauseView(props.usePause((state) => state.bySession[String(sessionId)]));
			const visible = showsPauseControl(useSession((snapshot) => snapshot.subagent));
			(0, react.useEffect)(() => {
				refresh(sessionId);
			}, [refresh, sessionId]);
			if (!visible) return null;
			return (0, react_jsx_runtime.jsxs)("span", {
				className: button_module_css_default.dsp,
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: button_module_css_default.dspBtn,
						"aria-label": t(view.ariaKey),
						"aria-pressed": view.paused,
						disabled: !view.enabled,
						onClick: () => {
							toggle(sessionId);
						},
						children: view.paused ? (0, react_jsx_runtime.jsx)(ResumeIcon, {}) : (0, react_jsx_runtime.jsx)(PauseIcon, {})
					}),
					view.rearmGoal === void 0 ? null : (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: button_module_css_default.dspGoal,
						"aria-label": t("goal.aria"),
						"aria-pressed": view.rearmGoal,
						title: t(view.rearmGoal ? "goal.on.tip" : "goal.off.tip"),
						onClick: () => {
							toggleGoal(sessionId);
						},
						children: (0, react_jsx_runtime.jsx)(GoalIcon, {})
					}),
					view.labelKey === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {
						className: button_module_css_default.dspState,
						children: [t(view.labelKey), view.runningTools.length === 0 ? null : `: ${view.runningTools.join(", ")}`]
					})
				]
			});
		}
		/**
		* Client plugin body: register the locale dictionaries, own both controllers,
		* follow the host's registry changes, and contribute the per-session control
		* and the whole-app control into the session header.
		* @param ctx - client context carrying slots, locale, and the Remote face.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "pause: dictionaries");
			const lifetime = new AbortController();
			ctx.effect(() => () => {
				lifetime.abort(/* @__PURE__ */ new Error("pause: client unloaded"));
			}, "pause: lifetime");
			const globalControl = new PauseGlobalControl(ctx.remote.commands, lifetime.signal);
			const control = new PauseControl(ctx.remote.commands, lifetime.signal, void 0, void 0, () => globalControl.store.getSnapshot().global);
			ctx.effect(() => globalControl.store.subscribe(() => {
				control.reconsider();
			}), "pause: the whole-app answer serves the session headers");
			ctx.effect(() => ctx.remote.$on("commands/change", () => {
				control.refreshAll();
				globalControl.refreshAll();
			}), "pause: host command registry changes");
			ctx.effect(() => {
				if (typeof document === "undefined") return () => {};
				const onVisibility = () => {
					control.watchVisibility();
					globalControl.watchVisibility();
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, "pause: page visibility");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: NS,
				order: 40,
				locale: NS,
				inject: () => ({
					hooks: { pause: control.store },
					refresh: (sessionId) => {
						control.refresh(sessionId);
					},
					toggle: (sessionId) => {
						control.toggle(sessionId);
					},
					toggleGoal: (sessionId) => {
						control.toggleGoal(sessionId);
					}
				})
			}, PauseButton));
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "pause-all",
				order: 60,
				locale: NS,
				inject: () => ({
					hooks: { pauseGlobal: globalControl.store },
					refresh: (sessionId) => {
						globalControl.refresh(sessionId);
					},
					toggle: (sessionId) => {
						globalControl.toggle(sessionId);
					},
					setPanel: (open) => {
						globalControl.setPanel(open);
					},
					decide: (sessionId, action) => {
						globalControl.decide(sessionId, action);
					}
				})
			}, PausePill));
		}
		//#endregion
		exports.PauseButton = PauseButton;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map