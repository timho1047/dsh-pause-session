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
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
/** Host callbacks the Remote service delegates to. */
/**
 * Refuse a Remote call made by a principal other than the owner. In-process
 * callers (tests, the Host itself) have no invocation and are trusted.
 * @param ctx - the service Context.
 */
function ownerOnly(ctx) {
    const invocation = ctx.invocation;
    if (invocation === undefined)
        return;
    if (invocation.peer.principal?.kind !== 'owner') {
        throw new RemoteError('pause/owner-only', 'pause controls are available only to the owner', {});
    }
}
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
            _snapshot_decorators = [Remote('snapshot')];
            _observe_decorators = [Remote({ mode: 'stream' })];
            _act_decorators = [Remote('act')];
            _triage_decorators = [Remote('triage')];
            _decide_decorators = [Remote('decide')];
            __esDecorate(this, null, _snapshot_decorators, { kind: "method", name: "snapshot", static: false, private: false, access: { has: obj => "snapshot" in obj, get: obj => obj.snapshot }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _observe_decorators, { kind: "method", name: "observe", static: false, private: false, access: { has: obj => "observe" in obj, get: obj => obj.observe }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _act_decorators, { kind: "method", name: "act", static: false, private: false, access: { has: obj => "act" in obj, get: obj => obj.act }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _triage_decorators, { kind: "method", name: "triage", static: false, private: false, access: { has: obj => "triage" in obj, get: obj => obj.triage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _decide_decorators, { kind: "method", name: "decide", static: false, private: false, access: { has: obj => "decide" in obj, get: obj => obj.decide }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        api = __runInitializers(this, _instanceExtraInitializers);
        /**
         * @param ctx - host context owning the service.
         * @param api - the pause engine behind the wire methods.
         */
        constructor(ctx, api) {
            super(ctx, 'pauseSession', { namespace: 'pauseSession' });
            this.api = api;
        }
        /**
         * One exact snapshot, used by tests and by a reconnect that cannot wait for
         * the first stream item.
         * @param signal - carrier cancellation.
         * @returns the current aggregate and session states.
         */
        async snapshot(signal) {
            ownerOnly(this.ctx);
            return await this.api.snapshot(signal);
        }
        /**
         * Live status: the opening snapshot, then one new snapshot whenever the host
         * reports a change.
         * @param signal - stream cancellation.
         * @returns the snapshot stream.
         */
        async *observe(signal) {
            ownerOnly(this.ctx);
            let version = 0;
            let seen = -1;
            let wake;
            const unsubscribe = this.api.subscribe(() => {
                version += 1;
                wake?.();
                wake = undefined;
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
                            signal?.removeEventListener('abort', onAbort);
                            wake = undefined;
                            resolve();
                        };
                        const onAbort = () => {
                            wake = undefined;
                            signal?.removeEventListener('abort', onAbort);
                            reject(signal?.reason);
                        };
                        wake = finish;
                        signal?.addEventListener('abort', onAbort, { once: true });
                        // A notification may have landed between the version check and the
                        // waiter assignment. It still owes this loop one read.
                        if (version !== seen)
                            finish();
                    });
                }
            }
            finally {
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
            ownerOnly(this.ctx);
            return await this.api.act(request, signal);
        }
        /**
         * Read the morning decision list.
         * @param request - the calling Session whose list is read.
         * @param signal - read cancellation.
         * @returns the listed rows.
         */
        async triage(request, signal) {
            ownerOnly(this.ctx);
            return await this.api.triage(request, signal);
        }
        /**
         * Take one decision on one listed Session.
         * @param request - the caller, target, and decision.
         * @param signal - load cancellation.
         * @returns the user-facing outcome.
         */
        async decide(request, signal) {
            ownerOnly(this.ctx);
            return await this.api.decide(request, signal);
        }
    };
})();
export { PauseRemote };
//# sourceMappingURL=remote.js.map