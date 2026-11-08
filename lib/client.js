window.__ModuleLoader__.load({
	id: "dsh-pause-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/client/control.js
		/**
		* Browser-side reading and driving of the host's park state for one session.
		*
		* The browser reads the native `pauseSession` stream; actions travel through
		* the same Remote namespace. No slash command is involved. The stream is
		* host-authoritative, so this module never derives a state from its own press.
		* The snapshot also carries the record's goal opt-out, so the switch beside the
		* pause button can show it without a second host round-trip.
		*
		* The stream is the change feed. A pushed snapshot triggers one cached read per
		* shown header; a press or goal switch reads the host's answer once after the
		* action.
		* @module dsh-pause-session/client/control
		*/
		const INITIAL$1 = { bySession: {} };
		/** Owns the published reading per session; nothing else writes that state. */
		var PauseControl = class {
			transport;
			lifetime;
			/** State source the Session-header contribution binds its selector hook to. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL$1);
			/** Sessions this control has shown; a pushed snapshot applies to every one. */
			shown = /* @__PURE__ */ new Set();
			/** Highest read sequence requested per session: an answer older than it is dropped. */
			latest = /* @__PURE__ */ new Map();
			reads = 0;
			/**
			* @param transport - the native namespace source and actions.
			* @param lifetime - aborts in-flight reads when the plugin unloads.
			*/
			constructor(transport, lifetime) {
				this.transport = transport;
				this.lifetime = lifetime;
			}
			/**
			* Read the host's state for one session.
			* @param sessionId - session whose control was rendered.
			* @returns after this read's answer is published or superseded by a newer one.
			*/
			async refresh(sessionId) {
				await this.readOne(sessionId);
			}
			/** Apply one pushed snapshot without spending a read per shown header. */
			apply(snapshot) {
				for (const sessionId of this.shown) {
					if (snapshot === void 0) {
						this.publish(sessionId, {
							phase: "unavailable",
							runningTools: []
						});
						continue;
					}
					const status = snapshot.sessions[String(sessionId)];
					this.publish(sessionId, status === void 0 ? {
						phase: "active",
						runningTools: []
					} : {
						phase: status.phase,
						runningTools: status.runningTools,
						...status.rearmGoal === void 0 ? {} : { rearmGoal: status.rearmGoal }
					});
				}
			}
			/** A new pushed snapshot may have moved every header; read them once. */
			refreshAll() {
				if (this.shown.size === 0 || this.lifetime.aborted) return;
				this.readAll();
			}
			async readAll() {
				if (this.lifetime.aborted) return;
				for (const sessionId of [...this.shown]) await this.readOne(sessionId);
			}
			/** One session's read, published unless a newer read of that session supersedes it. */
			async readOne(sessionId) {
				this.shown.add(sessionId);
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
				const action = current === void 0 || current === "active" ? "pause" : "resume";
				if (!(await this.transport.act({
					action,
					sessionId: String(sessionId)
				}, this.lifetime)).ok) {
					this.publish(sessionId, {
						phase: "unavailable",
						runningTools: []
					});
					return;
				}
				await this.refresh(sessionId);
			}
			/**
			* Flip this session's goal opt-out. The verb belongs to the session it
			* changes; the switch shows the host's next answer, never a local flip.
			* @param sessionId - session whose switch was pressed.
			* @returns after the control re-reads the host.
			*/
			async toggleGoal(sessionId) {
				if (!(await this.transport.act({
					action: "goal",
					sessionId: String(sessionId)
				}, this.lifetime)).ok) {
					this.publish(sessionId, {
						phase: "unavailable",
						runningTools: []
					});
					return;
				}
				await this.refresh(sessionId);
			}
			/** Ask the native stream what this session's park state is. */
			async read(sessionId) {
				const snapshot = await this.transport.source.read(this.lifetime);
				if (snapshot === void 0) return {
					phase: "unavailable",
					runningTools: []
				};
				const status = snapshot.sessions[String(sessionId)];
				if (status === void 0) return {
					phase: "active",
					runningTools: []
				};
				return {
					phase: status.phase,
					runningTools: status.runningTools,
					...status.rearmGoal === void 0 ? {} : { rearmGoal: status.rearmGoal }
				};
			}
			publish(sessionId, reading) {
				this.store.update((state) => {
					const previous = state.bySession[String(sessionId)];
					if (previous !== void 0 && previous.phase === reading.phase && previous.rearmGoal === reading.rearmGoal && previous.runningTools.length === reading.runningTools.length && previous.runningTools.every((tool, index) => tool === reading.runningTools[index])) return;
					state.bySession = {
						...state.bySession,
						[String(sessionId)]: reading
					};
				});
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
		function pauseView(reading, running = true) {
			switch (reading?.phase) {
				case "active": return {
					paused: false,
					enabled: running,
					ariaKey: "pause.aria",
					runningTools: []
				};
				case "draining": return {
					paused: true,
					enabled: true,
					ariaKey: "draining.aria",
					labelKey: "state.draining",
					runningTools: reading.runningTools
				};
				case "parking": return {
					paused: true,
					enabled: true,
					ariaKey: "parking.aria",
					labelKey: "state.parking",
					runningTools: []
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
					runningTools: []
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
		* The decisions one row may offer. Continue and note both deliver the owed
		* request, so they are absent when the log is unreadable or the host says it
		* cannot wake the entry; the remaining decisions still give the user a way out.
		* @param row - the rendered row.
		* @returns the actions that can be taken on it.
		*/
		function triageActionsFor(row) {
			return TRIAGE_ACTION_VIEWS.filter((action) => action.action !== "continue" && action.action !== "note" ? true : row.readable && row.wakeable);
		}
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
			if (reading === void 0) return {
				visible: false,
				unavailable: false,
				rows: []
			};
			if (reading.kind === "unavailable") return {
				visible: true,
				unavailable: true,
				rows: []
			};
			return {
				visible: true,
				unavailable: false,
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
		function globalPauseView(reading, sessions) {
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
					ariaKey: "all.cancel.aria",
					action: "cancel-all",
					labelKey: "all.finishing",
					detail: `${String(status.safe)}/${String(status.registered)}`,
					running: status.draining.map((id) => {
						const tools = sessions?.[id]?.runningTools ?? [];
						return tools.length === 0 ? id : `${id}: ${tools.join(", ")}`;
					}).join(", ") || void 0
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
		* The aggregate arrives from the native `pauseSession` stream. The stream is
		* process-wide and writes nothing into any Session; actions travel through the
		* same Remote namespace. A pushed snapshot is applied directly; a settled park
		* costs nothing while its last answer stays on screen.
		* @module dsh-pause-session/client/global
		*/
		/** Map one Remote row to the list's structured row. */
		function wireTriageRow(row) {
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
					callId: trace.callId ?? ""
				})),
				owed: row.owed,
				wakeable: row.wakeable,
				rearmGoal: row.rearmGoal
			};
		}
		const INITIAL = {
			global: void 0,
			panelOpen: false,
			triage: void 0
		};
		/**
		* The session a whole-app action is addressed to.
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
		/** Owns the published whole-app reading; nothing else writes that state. */
		var PauseGlobalControl = class {
			transport;
			lifetime;
			/** State source the whole-app contribution binds its selector hook to. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL);
			/** The session the shell asked this control through; list reads use it. */
			address;
			/** Highest decision-list read requested: an answer older than it is dropped. */
			latestTriage = 0;
			/**
			* @param transport - the native namespace source and actions.
			* @param lifetime - aborts in-flight reads when the plugin unloads.
			*/
			constructor(transport, lifetime) {
				this.transport = transport;
				this.lifetime = lifetime;
			}
			/**
			* The shell handed this control a session. The first call reads the aggregate;
			* later calls only move where list reads and actions are addressed.
			* @param sessionId - the session the shell asks through.
			*/
			async refresh(sessionId) {
				this.address = sessionId;
				await this.readAggregate();
			}
			/** Apply one pushed snapshot directly. */
			apply(snapshot) {
				this.store.update((state) => {
					state.sessions = snapshot?.sessions;
				});
				this.publish(snapshot === void 0 ? { kind: "unavailable" } : {
					kind: "reported",
					status: snapshot.global
				});
			}
			/** A pushed snapshot may have moved the aggregate and the open list. */
			refreshAll() {
				if (this.lifetime.aborted) return;
				this.readAggregate();
				if (this.store.getSnapshot().panelOpen) this.refreshTriage();
			}
			/**
			* Open or close the decision list. Opening asks for the rows; there is no
			* state to show without that answer.
			* @param open - whether the panel should be showing.
			*/
			setPanel(open) {
				this.store.update((state) => {
					state.panelOpen = open;
				});
				if (open) this.refreshTriage();
			}
			/** Ask the host for the decision list for the session the user is on. */
			async refreshTriage() {
				await this.readTriage();
			}
			/**
			* Take one listed verb on one listed session, addressed through the session
			* the user is on. A refusal is published verbatim rather than silently
			* leaving the previous rows in place.
			* @param sessionId - the listed session to act on.
			* @param action - which listed verb was taken.
			*/
			async decide(sessionId, action) {
				const address = this.address;
				if (address === void 0) return;
				const answer = await this.transport.decide(String(address), sessionId, action, this.lifetime);
				if (!answer.ok) {
					this.store.update((state) => {
						state.error = answer.message;
					});
					return;
				}
				this.store.update((state) => {
					state.error = void 0;
				});
				await this.refreshTriage();
				await this.reread(address);
			}
			/**
			* Press the pill: park everything, or release everything the park owns.
			* Which one it is comes from the host's own last answer, never from a local
			* flip; the state shown afterwards is the host's answer again.
			* @param sessionId - the session to address the verb to.
			*/
			async toggle(sessionId) {
				const current = this.store.getSnapshot().global;
				if (current === void 0 || current.kind !== "reported") return;
				const action = globalPauseView(current).action;
				if (action === "none") return;
				const answer = await this.transport.act({
					action,
					sessionId: String(sessionId)
				}, this.lifetime);
				if (!answer.ok) {
					this.store.update((state) => {
						state.error = answer.message;
					});
					return;
				}
				this.store.update((state) => {
					state.error = void 0;
				});
				await this.reread(sessionId);
			}
			/** Read the aggregate once and publish it. */
			async readAggregate() {
				const snapshot = await this.transport.source.read(this.lifetime);
				if (snapshot === void 0) {
					this.publish({ kind: "unavailable" });
					return;
				}
				this.store.update((state) => {
					state.sessions = snapshot.sessions;
				});
				this.publish({
					kind: "reported",
					status: snapshot.global
				});
			}
			async reread(sessionId) {
				this.address = sessionId;
				await this.readAggregate();
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
			/** Ask the native namespace for the decision list. */
			async readTriageRows(sessionId) {
				const rows = await this.transport.triage(String(sessionId), this.lifetime);
				return rows === void 0 ? { kind: "unavailable" } : {
					kind: "reported",
					rows: rows.map(wireTriageRow)
				};
			}
			publish(reading) {
				this.store.update((state) => {
					if (state.global?.kind === reading.kind && (reading.kind === "unavailable" || state.global?.kind === "reported" && JSON.stringify(state.global.status) === JSON.stringify(reading.status))) return;
					state.global = reading;
				});
			}
		};
		//#endregion
		//#region lib/types/client/remote.js
		/**
		* Client-side bridge from the generated `pauseSession` Remote namespace to the
		* control state machines.
		*
		* The native namespace is the only transport: the stream supplies snapshots and
		* the action methods drive every button. No slash command is involved.
		* @module dsh-pause-session/client/remote
		*/
		/** Convert one wire snapshot to the host-status vocabulary the controls already use. */
		function snapshotOf(wire) {
			return {
				global: {
					...wire.global,
					parkedAt: wire.global.parkedAt,
					draining: wire.global.draining,
					stalled: wire.global.stalled,
					unresumable: wire.global.unresumable,
					unreadTrees: wire.global.unreadTrees,
					jobs: wire.global.jobs,
					blind: wire.global.blind
				},
				sessions: Object.fromEntries(Object.entries(wire.sessions).map(([id, status]) => [id, status]))
			};
		}
		/**
		* Open the native status stream and expose its latest snapshot to both controls.
		* @param remote - the generated Remote namespace.
		* @param lifetime - client lifetime; aborting it releases the stream.
		* @returns the cached source and its change subscription.
		*/
		function openRemoteSource(remote, lifetime) {
			let latest;
			let failed = false;
			let first;
			const listeners = /* @__PURE__ */ new Set();
			const snapshotListeners = /* @__PURE__ */ new Set();
			const notify = () => {
				for (const listener of [...listeners]) listener();
				for (const listener of [...snapshotListeners]) listener(failed ? void 0 : latest);
			};
			new Promise((resolve) => {
				first = resolve;
			});
			(async () => {
				try {
					for await (const snapshot of remote.observe(lifetime)) {
						latest = snapshotOf(snapshot);
						first?.();
						first = void 0;
						notify();
					}
				} catch {
					failed = true;
					latest = void 0;
					notify();
				} finally {
					if (!lifetime.aborted) {
						failed = true;
						latest = void 0;
					}
					first?.();
					first = void 0;
					notify();
				}
			})();
			return {
				onChange: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				onSnapshot: (listener) => {
					snapshotListeners.add(listener);
					return () => {
						snapshotListeners.delete(listener);
					};
				},
				read: async (signal) => {
					if (latest === void 0 && !failed) await new Promise((resolve) => {
						const done = () => {
							signal?.removeEventListener("abort", done);
							resolve();
						};
						first = () => {
							first = void 0;
							done();
						};
						signal?.addEventListener("abort", done, { once: true });
						if (latest !== void 0 || failed) done();
					});
					signal?.throwIfAborted();
					return failed ? void 0 : latest;
				}
			};
		}
		/**
		* Build the direct transport over one mounted Remote namespace.
		* @param remote - the generated `pauseSession` namespace.
		* @param lifetime - client lifetime.
		* @returns the source and action methods the controls use.
		*/
		function remoteTransport(remote, lifetime) {
			const source = openRemoteSource(remote, lifetime);
			const failed = () => ({
				ok: false,
				message: "pause action failed"
			});
			return {
				source,
				act: async (request, signal) => {
					const answer = await remote.act(request, signal);
					return answer.ok ? answer.value ?? failed() : failed();
				},
				triage: async (caller, signal) => {
					const answer = await remote.triage({ caller }, signal);
					return answer.ok ? answer.value : void 0;
				},
				decide: async (caller, target, decision, signal) => {
					const answer = await remote.decide({
						caller,
						target,
						decision
					}, signal);
					return answer.ok ? answer.value ?? failed() : failed();
				}
			};
		}
		//#endregion
		//#region src/client/zod-lite.ts
		/** Build one identity codec node. */
		function node() {
			return {
				parse: (value) => value,
				safeParse: (value) => ({
					success: true,
					data: value
				}),
				readonly() {
					return this;
				},
				optional() {
					return this;
				},
				describe() {
					return this;
				}
			};
		}
		/** The `z` namespace the generated client contribution expects. */
		const z = {
			string: node,
			number: node,
			boolean: node,
			undefined: node,
			literal: node,
			union: node,
			array: node,
			record: node,
			object: node,
			strictObject: node,
			enum: node
		};
		//#endregion
		//#region ../../deepseek-harness/packages/typert/protocol/lib/types/remote-info.js
		/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
		/**
		* Retain one generated definition per endpoint without constructing parsers or projections.
		* The class instance builds its shared descriptor/method index on first access;
		* input schemas and JSON Schema projections are cached only when requested.
		* @param spec - compiler-produced method facts and Zod factories.
		* @param zod - the generated artifact's Zod runtime for named-input parsers.
		* @returns a lazy, mountable info instance with no registration or transport effects.
		*/
		function createTypertRemoteInfo(spec, zod) {
			return new RemoteInfo(spec, zod);
		}
		var RemoteInfo = class {
			spec;
			zod;
			index;
			constructor(spec, zod) {
				this.spec = spec;
				this.zod = zod;
			}
			get package() {
				return this.spec.package;
			}
			get descriptors() {
				return this.resolve().descriptors;
			}
			get methods() {
				return this.resolve().methods;
			}
			resolve() {
				if (this.index !== void 0) return this.index;
				const zod = this.zod;
				const descriptors = [];
				const methods = Object.create(null);
				for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
					const separator = endpoint.indexOf("/");
					const namespace = endpoint.slice(0, separator);
					const method = endpoint.slice(separator + 1);
					const parameters = definition.parameters.map((parameter) => ({
						...parameter,
						wire: parameter.wire ?? parameter.name
					}));
					const descriptor = {
						...definition,
						id: `${this.spec.package}#${endpoint}`,
						namespace,
						method,
						parameters,
						result: definition.result.description === void 0 ? definition.result : new ResultValue(definition.result)
					};
					if (definition.invocation.kind === "direct") {
						const inputs = [];
						methods[endpoint] = Object.assign(descriptor, {
							input(options) {
								const strict = options?.strict === true;
								return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
							},
							invoke(remote, input, signal) {
								const named = input;
								const values = parameters.map((parameter) => named[parameter.wire]);
								if (definition.cancellation !== void 0) values.push(signal);
								const receiver = Reflect.get(remote, namespace);
								return Reflect.get(receiver, method).apply(receiver, values);
							}
						});
					}
					descriptors.push(descriptor);
				}
				return this.index = {
					descriptors,
					methods
				};
			}
		};
		function optional(parameter) {
			return parameter.source === "json" && parameter.acceptsUndefined === true;
		}
		var NamedInput = class {
			parameters;
			strict;
			zod;
			schema;
			projection;
			constructor(parameters, strict, zod) {
				this.parameters = parameters;
				this.strict = strict;
				this.zod = zod;
			}
			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec;
			}
			create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
				const value = this.codec(parameter).create();
				return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
			})));
			get jsonSchema() {
				return this.project().jsonSchema;
			}
			get jsonSchemaError() {
				return this.project().jsonSchemaError;
			}
			project() {
				if (this.projection !== void 0) return this.projection;
				const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === void 0);
				if (unavailable !== void 0) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
				return this.projection = { jsonSchema: {
					type: "object",
					properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
						...this.codec(parameter).jsonSchema,
						...parameter.description === void 0 ? {} : { description: parameter.description }
					}])),
					required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
					additionalProperties: false
				} };
			}
		};
		var ResultValue = class {
			spec;
			projection;
			constructor(spec) {
				this.spec = spec;
			}
			get mode() {
				return this.spec.mode;
			}
			get typeSymbol() {
				return this.spec.typeSymbol;
			}
			get create() {
				return this.spec.create;
			}
			get decode() {
				return this.spec.decode;
			}
			get encode() {
				return this.spec.encode;
			}
			get description() {
				return this.spec.description;
			}
			get jsonSchemaError() {
				return this.spec.jsonSchemaError;
			}
			get jsonSchema() {
				if (this.projection === void 0) {
					const schema = this.spec.jsonSchema;
					this.projection = { value: schema === void 0 ? void 0 : {
						...schema,
						description: this.spec.description
					} };
				}
				return this.projection.value;
			}
		};
		//#endregion
		//#region lib/typert.remote-client.js
		let dsh_pause_session_pauseSession_act_parameter_0$schema$value;
		const dsh_pause_session_pauseSession_act_parameter_0$schema = () => dsh_pause_session_pauseSession_act_parameter_0$schema$value ??= z.object({
			"action": z.union([
				z.literal("pause"),
				z.literal("resume"),
				z.literal("pause-all"),
				z.literal("resume-all"),
				z.literal("cancel-all"),
				z.literal("goal")
			]).readonly(),
			"sessionId": z.string().readonly().describe("The Session the control is addressed through.")
		});
		let dsh_pause_session_pauseSession_act_result$schema$value;
		const dsh_pause_session_pauseSession_act_result$schema = () => dsh_pause_session_pauseSession_act_result$schema$value ??= z.object({
			"ok": z.boolean().readonly(),
			"message": z.string().readonly()
		});
		let dsh_pause_session_pauseSession_decide_parameter_0$schema$value;
		const dsh_pause_session_pauseSession_decide_parameter_0$schema = () => dsh_pause_session_pauseSession_decide_parameter_0$schema$value ??= z.object({
			"caller": z.string().readonly(),
			"target": z.string().readonly(),
			"decision": z.union([
				z.literal("goal"),
				z.literal("continue"),
				z.literal("note"),
				z.literal("review"),
				z.literal("leave")
			]).readonly()
		});
		let dsh_pause_session_pauseSession_decide_result$schema$value;
		const dsh_pause_session_pauseSession_decide_result$schema = () => dsh_pause_session_pauseSession_decide_result$schema$value ??= z.object({
			"ok": z.boolean().readonly(),
			"message": z.string().readonly()
		});
		let dsh_pause_session_pauseSession_observe_result$schema$value;
		const dsh_pause_session_pauseSession_observe_result$schema = () => dsh_pause_session_pauseSession_observe_result$schema$value ??= z.object({
			"global": z.object({
				"verdict": z.union([
					z.literal("idle"),
					z.literal("waiting"),
					z.literal("safe")
				]).readonly(),
				"registered": z.number().readonly(),
				"safe": z.number().readonly(),
				"parkedAt": z.union([z.undefined(), z.string()]).readonly().optional(),
				"draining": z.array(z.string()).readonly(),
				"parking": z.number().readonly(),
				"stalled": z.array(z.string()).readonly(),
				"unresumable": z.array(z.string()).readonly(),
				"unreadTrees": z.array(z.string()).readonly(),
				"jobs": z.array(z.string()).readonly(),
				"blind": z.array(z.string()).readonly()
			}).readonly(),
			"sessions": z.record(z.string(), z.object({
				"phase": z.union([
					z.literal("safe"),
					z.literal("active"),
					z.literal("draining"),
					z.literal("parking"),
					z.literal("flush-failed")
				]).readonly(),
				"runningTools": z.array(z.string()).readonly(),
				"rearmGoal": z.union([
					z.undefined(),
					z.literal(false),
					z.literal(true)
				]).readonly().optional()
			})).readonly().readonly()
		});
		let dsh_pause_session_pauseSession_snapshot_result$schema$value;
		const dsh_pause_session_pauseSession_snapshot_result$schema = () => dsh_pause_session_pauseSession_snapshot_result$schema$value ??= z.object({
			"global": z.object({
				"verdict": z.union([
					z.literal("idle"),
					z.literal("waiting"),
					z.literal("safe")
				]).readonly(),
				"registered": z.number().readonly(),
				"safe": z.number().readonly(),
				"parkedAt": z.union([z.undefined(), z.string()]).readonly().optional(),
				"draining": z.array(z.string()).readonly(),
				"parking": z.number().readonly(),
				"stalled": z.array(z.string()).readonly(),
				"unresumable": z.array(z.string()).readonly(),
				"unreadTrees": z.array(z.string()).readonly(),
				"jobs": z.array(z.string()).readonly(),
				"blind": z.array(z.string()).readonly()
			}).readonly(),
			"sessions": z.record(z.string(), z.object({
				"phase": z.union([
					z.literal("safe"),
					z.literal("active"),
					z.literal("draining"),
					z.literal("parking"),
					z.literal("flush-failed")
				]).readonly(),
				"runningTools": z.array(z.string()).readonly(),
				"rearmGoal": z.union([
					z.undefined(),
					z.literal(false),
					z.literal(true)
				]).readonly().optional()
			})).readonly().readonly()
		});
		let dsh_pause_session_pauseSession_triage_parameter_0$schema$value;
		const dsh_pause_session_pauseSession_triage_parameter_0$schema = () => dsh_pause_session_pauseSession_triage_parameter_0$schema$value ??= z.object({ "caller": z.string().readonly() });
		let dsh_pause_session_pauseSession_triage_result$schema$value;
		const dsh_pause_session_pauseSession_triage_result$schema = () => dsh_pause_session_pauseSession_triage_result$schema$value ??= z.array(z.object({
			"sessionId": z.string().readonly(),
			"phase": z.union([
				z.literal("draining"),
				z.literal("parking"),
				z.literal("flush-failed")
			]).readonly(),
			"updatedAt": z.number().readonly(),
			"reading": z.union([z.literal("read"), z.literal("unreadable")]).readonly(),
			"lastEvent": z.union([z.undefined(), z.string()]).readonly().optional(),
			"turn": z.union([z.undefined(), z.number()]).readonly().optional(),
			"step": z.union([z.undefined(), z.number()]).readonly().optional(),
			"traces": z.array(z.object({
				"tool": z.string().readonly(),
				"callId": z.string().readonly()
			})).readonly(),
			"owed": z.boolean().readonly(),
			"wakeable": z.boolean().readonly(),
			"rearmGoal": z.boolean().readonly()
		}));
		let dsh_pause_session_pauseSession_act_parameter_0_strict$schema$value;
		const dsh_pause_session_pauseSession_act_parameter_0_strict$schema = () => dsh_pause_session_pauseSession_act_parameter_0_strict$schema$value ??= z.strictObject({
			"action": z.union([
				z.literal("pause"),
				z.literal("resume"),
				z.literal("pause-all"),
				z.literal("resume-all"),
				z.literal("cancel-all"),
				z.literal("goal")
			]).readonly(),
			"sessionId": z.string().readonly().describe("The Session the control is addressed through.")
		});
		let dsh_pause_session_pauseSession_decide_parameter_0_strict$schema$value;
		const dsh_pause_session_pauseSession_decide_parameter_0_strict$schema = () => dsh_pause_session_pauseSession_decide_parameter_0_strict$schema$value ??= z.strictObject({
			"caller": z.string().readonly(),
			"target": z.string().readonly(),
			"decision": z.union([
				z.literal("goal"),
				z.literal("continue"),
				z.literal("note"),
				z.literal("review"),
				z.literal("leave")
			]).readonly()
		});
		let dsh_pause_session_pauseSession_triage_parameter_0_strict$schema$value;
		const dsh_pause_session_pauseSession_triage_parameter_0_strict$schema = () => dsh_pause_session_pauseSession_triage_parameter_0_strict$schema$value ??= z.strictObject({ "caller": z.string().readonly() });
		const TYPERT_REMOTE = createTypertRemoteInfo({
			package: "dsh-pause-session",
			methods: {
				"pauseSession/act": {
					service: "pauseSession",
					description: "Pause, resume, press every tree, resume every clean park, or flip one Session's goal re-arm.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "request",
						description: "the button action.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseActionRequest",
							create: dsh_pause_session_pauseSession_act_parameter_0$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"action": {
										"type": "string",
										"enum": [
											"pause",
											"resume",
											"pause-all",
											"resume-all",
											"cancel-all",
											"goal"
										]
									},
									"sessionId": {
										"type": "string",
										"description": "The Session the control is addressed through."
									}
								},
								"required": ["action", "sessionId"],
								"additionalProperties": true
							}
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseActionRequest",
							create: dsh_pause_session_pauseSession_act_parameter_0_strict$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"action": {
										"type": "string",
										"enum": [
											"pause",
											"resume",
											"pause-all",
											"resume-all",
											"cancel-all",
											"goal"
										]
									},
									"sessionId": {
										"type": "string",
										"description": "The Session the control is addressed through."
									}
								},
								"required": ["action", "sessionId"],
								"additionalProperties": false
							}
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "dsh-pause-session/types#PauseActionResultWire",
						create: dsh_pause_session_pauseSession_act_result$schema,
						description: "the user-facing outcome.",
						jsonSchema: {
							"type": "object",
							"properties": {
								"ok": { "type": "boolean" },
								"message": { "type": "string" }
							},
							"required": ["ok", "message"],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/dsh-pause-session/src/remote.ts",
						"line": 239,
						"column": 9
					}
				},
				"pauseSession/decide": {
					service: "pauseSession",
					description: "Take one decision on one listed Session.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "request",
						description: "the caller, target, and decision.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseDecisionRequest",
							create: dsh_pause_session_pauseSession_decide_parameter_0$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"caller": { "type": "string" },
									"target": { "type": "string" },
									"decision": {
										"type": "string",
										"enum": [
											"goal",
											"continue",
											"note",
											"review",
											"leave"
										]
									}
								},
								"required": [
									"caller",
									"target",
									"decision"
								],
								"additionalProperties": true
							}
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseDecisionRequest",
							create: dsh_pause_session_pauseSession_decide_parameter_0_strict$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"caller": { "type": "string" },
									"target": { "type": "string" },
									"decision": {
										"type": "string",
										"enum": [
											"goal",
											"continue",
											"note",
											"review",
											"leave"
										]
									}
								},
								"required": [
									"caller",
									"target",
									"decision"
								],
								"additionalProperties": false
							}
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "dsh-pause-session/types#PauseActionResultWire",
						create: dsh_pause_session_pauseSession_decide_result$schema,
						description: "the user-facing outcome.",
						jsonSchema: {
							"type": "object",
							"properties": {
								"ok": { "type": "boolean" },
								"message": { "type": "string" }
							},
							"required": ["ok", "message"],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/dsh-pause-session/src/remote.ts",
						"line": 264,
						"column": 9
					}
				},
				"pauseSession/observe": {
					service: "pauseSession",
					description: "Live status: the opening snapshot, then one new snapshot whenever the host reports a change.",
					mode: "stream",
					invocation: { kind: "direct" },
					parameters: [],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "dsh-pause-session/types#PauseSnapshotWire",
						create: dsh_pause_session_pauseSession_observe_result$schema,
						description: "the snapshot stream.",
						jsonSchemaError: "typert tool schema: selected dictionaries require string keys and unconstrained JSON values"
					},
					sourceLocation: {
						"file": "packages/dsh-pause-session/src/remote.ts",
						"line": 201,
						"column": 10
					}
				},
				"pauseSession/snapshot": {
					service: "pauseSession",
					description: "One exact snapshot, used by tests and by a reconnect that cannot wait for the first stream item.",
					invocation: { kind: "direct" },
					parameters: [],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "dsh-pause-session/types#PauseSnapshotWire",
						create: dsh_pause_session_pauseSession_snapshot_result$schema,
						description: "the current aggregate and session states.",
						jsonSchemaError: "typert tool schema: selected dictionaries require string keys and unconstrained JSON values"
					},
					sourceLocation: {
						"file": "packages/dsh-pause-session/src/remote.ts",
						"line": 175,
						"column": 9
					}
				},
				"pauseSession/triage": {
					service: "pauseSession",
					description: "Read the morning decision list.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "request",
						description: "the calling Session whose list is read.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseTriageRequest",
							create: dsh_pause_session_pauseSession_triage_parameter_0$schema,
							jsonSchema: {
								"type": "object",
								"properties": { "caller": { "type": "string" } },
								"required": ["caller"],
								"additionalProperties": true
							}
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "dsh-pause-session/types#PauseTriageRequest",
							create: dsh_pause_session_pauseSession_triage_parameter_0_strict$schema,
							jsonSchema: {
								"type": "object",
								"properties": { "caller": { "type": "string" } },
								"required": ["caller"],
								"additionalProperties": false
							}
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "dsh-pause-session#pauseSession/triage:result",
						create: dsh_pause_session_pauseSession_triage_result$schema,
						description: "the listed rows.",
						jsonSchema: {
							"type": "array",
							"items": {
								"type": "object",
								"properties": {
									"sessionId": { "type": "string" },
									"phase": {
										"type": "string",
										"enum": [
											"draining",
											"parking",
											"flush-failed"
										]
									},
									"updatedAt": { "type": "number" },
									"reading": {
										"type": "string",
										"enum": ["read", "unreadable"]
									},
									"lastEvent": { "type": "string" },
									"turn": { "type": "number" },
									"step": { "type": "number" },
									"traces": {
										"type": "array",
										"items": {
											"type": "object",
											"properties": {
												"tool": { "type": "string" },
												"callId": { "type": "string" }
											},
											"required": ["tool", "callId"],
											"additionalProperties": true
										}
									},
									"owed": { "type": "boolean" },
									"wakeable": { "type": "boolean" },
									"rearmGoal": { "type": "boolean" }
								},
								"required": [
									"sessionId",
									"phase",
									"updatedAt",
									"reading",
									"traces",
									"owed",
									"wakeable",
									"rearmGoal"
								],
								"additionalProperties": true
							}
						}
					},
					sourceLocation: {
						"file": "packages/dsh-pause-session/src/remote.ts",
						"line": 252,
						"column": 9
					}
				}
			}
		}, z);
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
		const css = ".FCO1_q_dsp{align-items:center;display:inline-flex;position:relative}.FCO1_q_dspBtn{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;padding:0;transition:color .12s,background .12s,border-color .12s;display:inline-flex}.FCO1_q_dspBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.FCO1_q_dspBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspBtn:disabled{cursor:default;opacity:.5}.FCO1_q_dspBtn:disabled:hover{color:var(--dsw-alias-label-secondary);background:0 0;border-color:#0000}.FCO1_q_dspGoal{width:22px;height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;margin-left:2px;padding:0;transition:color .12s,background .12s,border-color .12s;display:inline-flex}.FCO1_q_dspGoal[aria-pressed=true]{color:var(--dsw-alias-label-secondary)}.FCO1_q_dspGoal:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.FCO1_q_dspGoal:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}@media (prefers-reduced-motion:reduce){.FCO1_q_dspGoal{transition:none}}.FCO1_q_dspState{color:var(--dsw-alias-label-secondary);white-space:nowrap;user-select:none;padding-left:6px;font-size:12px;line-height:18px}@media (prefers-reduced-motion:reduce){.FCO1_q_dspBtn{transition:none}}.FCO1_q_dspPill{align-items:center;display:inline-flex;position:relative}.FCO1_q_dspPillBtn{max-width:min(38ch,100vw - 48px);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;border-radius:999px;align-items:center;gap:6px;padding:5px 10px;font-size:12px;line-height:18px;transition:color .12s,background .12s,border-color .12s;display:inline-flex;box-shadow:0 4px 12px #00000024}.FCO1_q_dspPillBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillIcon{justify-content:center;width:28px;height:28px;padding:0}.FCO1_q_dspPillBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspPillBtn:disabled{cursor:default;opacity:.5}.FCO1_q_dspPillText{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.FCO1_q_dspPillDetail{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}.FCO1_q_dspPillWarn{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));font-weight:600}@media (prefers-reduced-motion:reduce){.FCO1_q_dspPillBtn{transition:none}}.FCO1_q_dspPillTriage{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;border-radius:999px;align-items:center;gap:2px;margin-right:4px;padding:4px 8px;font-size:12px;line-height:18px;display:inline-flex;box-shadow:0 4px 12px #00000024}.FCO1_q_dspPillTriage:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillTriage:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.FCO1_q_dspPillPanel{z-index:30;text-align:left;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:8px;width:min(52ch,100vw - 48px);max-height:min(60vh,420px);padding:10px 12px;display:flex;position:absolute;top:calc(100% + 6px);right:0;overflow-y:auto;box-shadow:0 8px 24px #00000038}.FCO1_q_dspPillPanelHead{justify-content:space-between;align-items:center;gap:8px;font-weight:600;display:flex}.FCO1_q_dspPillError{color:var(--dsw-alias-state-error-primary);margin:0 0 8px;font-size:12px;line-height:18px}.FCO1_q_dspPillPanelNote{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}.FCO1_q_dspPillRows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.FCO1_q_dspPillRow{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;flex-direction:column;gap:4px;padding:8px;display:flex}.FCO1_q_dspPillRowHead{justify-content:space-between;align-items:baseline;gap:8px;display:flex}.FCO1_q_dspPillRowId{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.FCO1_q_dspPillRowPhase{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));flex:none;font-size:12px}.FCO1_q_dspPillRowFacts{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:2px;font-size:12px;line-height:18px;display:flex}.FCO1_q_dspPillRowActions{flex-wrap:wrap;gap:6px;padding-top:2px;display:flex}.FCO1_q_dspPillAction{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;user-select:none;background:0 0;border-radius:4px;padding:3px 8px;font-size:12px;line-height:16px}.FCO1_q_dspPillAction:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}.FCO1_q_dspPillAction:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}";
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
			"dspPillError": "FCO1_q_dspPillError",
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
			"dspState": "FCO1_q_dspState"
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
		* The pill reads the native status stream through `./global.ts`. With no
		* answer, or with no session to address an action through, it renders nothing
		* rather than a state it would have to invent. The decision list is
		* deliberately NOT part of that first read; the panel asks for its own rows
		* when it opens.
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
						children: [triageActionsFor(row).map((action) => (0, react_jsx_runtime.jsx)("button", {
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
			props.usePauseGlobal((state) => state.error);
			const sessions = props.usePauseGlobal((state) => state.sessions);
			const address = useSessions(addressingSession);
			const view = globalPauseView(reading, sessions);
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
						}) : list.unavailable ? (0, react_jsx_runtime.jsx)("p", {
							className: button_module_css_default.dspPillPanelNote,
							children: t("triage.unavailable")
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
						"aria-pressed": view.action === "resume-all" || view.action === "cancel-all",
						disabled: !view.enabled,
						...tip.length === 0 ? {} : { title: tip },
						onClick: () => {
							toggle(address);
						},
						children: [
							view.action === "resume-all" || view.action === "cancel-all" ? (0, react_jsx_runtime.jsx)(ResumeIcon, {}) : (0, react_jsx_runtime.jsx)(PauseIcon, {}),
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
			"resume.tip": "恢复这个会话及其子代理",
			"draining.aria": "正在暂停：还有工具在运行，工具运行完之后、下一条模型请求发出之前，会话会停住；按下可取消这次暂停",
			"parking.aria": "正在暂停：正在保存待发输入；按下可取消这次暂停",
			"safe.aria": "已暂停：待发输入已保存；按下可恢复",
			"flushFailed.aria": "已暂停，但保存待发输入失败；按下可恢复",
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
			"all.cancel": "取消这次暂停",
			"all.cancel.aria": "取消这次暂停并恢复会话",
			"all.unclean": "有会话未暂停",
			"all.unclean.aria": "有会话未暂停，不能在这里恢复；打开清单逐行处理",
			"all.safe": "可以合盖了",
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
			"resume.tip": "Resume this session and its subagents",
			"draining.aria": "Pausing: a tool is still running. The session pauses after the tool finishes and before its next model request; press to cancel the pause",
			"parking.aria": "Pausing: saving pending input; press to cancel the pause",
			"safe.aria": "Paused: pending input is saved; press to resume",
			"flushFailed.aria": "Paused, but saving pending input failed; press to resume",
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
			"all.cancel": "Cancel this pause",
			"all.cancel.aria": "Cancel this pause and resume the sessions",
			"all.unclean": "Some sessions are not paused",
			"all.unclean.aria": "Some sessions are not paused and cannot be resumed here; open the list to decide",
			"all.safe": "Safe to close",
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
		* Both controls are host-authoritative. On a browser Host they read the
		* native `pauseSession` stream, which keeps status reads out of the Session
		* log. The same path serves Web and Desktop.
		* User actions and status both use the generated native Remote namespace;
		* no slash command is involved. Each control stays inert wherever no
		* round-trip is available rather than rendering a state it cannot support. The
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
			"remote"
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
			const view = pauseView(props.usePause((state) => state.bySession[String(sessionId)]), useSession((snapshot) => snapshot.running) ?? false);
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
			if (typeof ctx.remote.$mount === "function") ctx.effect(async () => {
				return await ctx.remote.$mount(TYPERT_REMOTE);
			}, "pause: remote transport");
			ctx.inject(["remote.pauseSession"], (remoteCtx) => {
				const remote = remoteCtx.remote.pauseSession;
				const transport = remoteTransport(remote, lifetime.signal);
				const globalControl = new PauseGlobalControl(transport, lifetime.signal);
				const control = new PauseControl(transport, lifetime.signal);
				remoteCtx.effect(() => transport.source.onSnapshot((snapshot) => {
					control.apply(snapshot);
					globalControl.apply(snapshot);
				}), "pause: native status stream");
				remoteCtx.slots.inject("conversation.session.header.actions", () => remoteCtx.slots.register({
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
				remoteCtx.slots.inject("conversation.session.header.utilities", () => remoteCtx.slots.register({
					name: "conversation.session.header.utilities",
					id: "pause-all",
					order: -11,
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
			});
		}
		//#endregion
		exports.PauseButton = PauseButton;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map