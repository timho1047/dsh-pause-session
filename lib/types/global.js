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
import { walkDescendants } from './tree.js';
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
        members: walk.members.map(member => member.id),
        // A route no restart can resume, either because the catalog says so or
        // because it holds a mode this build cannot read.
        unresumable: walk.members.some(member => member.mode !== 'continuable')
            || walk.unread.some(branch => branch.reason === 'unsupported'),
        // `unsupported` was traversed, so its members are known; the other reasons
        // mean that branch was not read at all.
        unread: walk.unreadWhole || walk.unread.some(branch => branch.reason !== 'unsupported'),
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
export function mountGlobalPause(ctx, watch, registry, deps) {
    /**
     * Sessions this action tried to press and could not record. They are NOT
     * parked and they keep running, so the aggregate counts them and names them
     * instead of quietly leaving them out of a park it then calls safe.
     */
    const unrecorded = new Set();
    /** Record or clear one session's "pressed and the registry refused" state. */
    const markUnrecorded = (sessionId, flag) => {
        if (flag)
            unrecorded.add(sessionId);
        else
            unrecorded.delete(sessionId);
    };
    /** Per-episode tree walks; an entry lives exactly as long as the park owns it. */
    const walks = new Map();
    /**
     * Whether a session has unfinished work right now. Three real answers, any
     * of which is enough: the loop says it is driving the session, the activity
     * fold sees a tool in flight or a turn open, or the inbox holds a delivery
     * the loop has not claimed yet.
     */
    const running = (agent) => {
        if (agent.status === 'running')
            return true;
        const activity = watch.activity(agent.id);
        if (activity.turnOpen || activity.runningTools.length > 0)
            return true;
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
        if (cached !== undefined)
            return cached;
        // No subagent service at all: the walk would answer "no members", which is
        // not the same claim as "no children", and this report may not make it.
        const reading = ctx.get('subagents') === undefined
            ? { members: [], unresumable: false, unread: true }
            : readingOf(await walkDescendants(ctx, sessionId, signal));
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
        const found = new Set();
        for (const agent of ctx.agents.list())
            if (running(agent))
                found.add(agent.id);
        // The roots are fixed before the walk: a descendant discovered here is a
        // member of a tree, not a second tree to walk from.
        for (const root of [...found]) {
            for (const member of (await walkTree(root, signal)).members)
                found.add(member);
        }
        return [...found].filter(sessionId => !deps.isPaused(sessionId));
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
        const jobs = ctx.get('jobs');
        if (jobs === undefined)
            return [];
        const seen = new Set();
        const collect = (owner) => {
            for (const view of owner === undefined ? jobs.list() : jobs.list(owner)) {
                if (view.status !== 'running' && view.status !== 'stopping')
                    continue;
                seen.add(String(view.id));
            }
        };
        collect();
        for (const owner of owners)
            collect(owner);
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
        const phases = new Map();
        // The durable list is the promise; a live mark is the same episode's
        // fresher phase, and a press that could not be recorded is neither.
        for (const [sessionId, record] of registry.parked)
            phases.set(sessionId, { phase: record.phase, moving: false });
        // Read out of the accessor's own snapshot rather than through it per mark,
        // so this read asks the live state once however many sessions it holds.
        const live = deps.live();
        for (const [sessionId, park] of live)
            phases.set(sessionId, park);
        for (const sessionId of unrecorded)
            phases.set(sessionId, { phase: 'draining', moving: false });
        const unheld = deps.unheld();
        // Walks are per episode: a session the park no longer owns drops its entry,
        // so a later press reads the tree again instead of reporting a stale one.
        for (const sessionId of [...walks.keys()])
            if (!phases.has(sessionId))
                walks.delete(sessionId);
        let safe = 0;
        let parking = 0;
        const draining = [];
        const stalled = [];
        for (const [sessionId, park] of phases) {
            // A record this process could not hold is not a park here, whatever its
            // durable phase says: nothing is standing at the gate for it, so counting
            // it as safe would promise a hold that does not exist.
            if (unheld.has(sessionId)) {
                stalled.push(String(sessionId));
                continue;
            }
            if (park.phase === 'safe') {
                safe += 1;
                continue;
            }
            const bucket = park.moving ? draining : stalled;
            bucket.push(String(sessionId));
            // Standing at the park point with the flush still pending is counted
            // apart from the sessions still draining: both are unfinished, and the
            // pill's sentence is about how much of the wait is left rather than about
            // what is still running.
            if (park.moving && park.phase === 'parking')
                parking += 1;
        }
        const unresumable = [];
        const unreadTrees = [];
        const owners = [...phases.keys()];
        // The session this park belongs to: the first registered session this
        // process holds, so a client can address its reads at the park rather than
        // at whatever session the user is looking at. The buckets above name a
        // session only while it has work left, so a park that reached `safe` — the
        // clean, ordinary case — would otherwise name no session at all. A record
        // this process cannot hold is named only when there is nothing else to
        // name: it is a true fact about the park, but it cannot answer a read.
        const parkedAt = owners.find(sessionId => !unheld.has(sessionId)) ?? owners[0];
        // One walk is one catalog read, and the walks do not depend on each other:
        // a read of N registered sessions must not take N catalog round-trips end
        // to end. `walkTree` answers from its per-episode cache when it has one.
        const trees = await Promise.all(owners.map(async (sessionId) => [sessionId, await walkTree(sessionId, signal)]));
        for (const [sessionId, tree] of trees) {
            if (tree.unresumable)
                unresumable.push(String(sessionId));
            if (tree.unread)
                unreadTrees.push(String(sessionId));
        }
        const blind = [];
        if (ctx.get('subagents') === undefined)
            blind.push('trees');
        if (ctx.get('jobs') === undefined)
            blind.push('jobs');
        const registered = phases.size;
        // A tree nobody could read might hold a running descendant this park never
        // registered, so an unread tree is not a clean bill even when the session
        // itself is flushed.
        const verdict = registered === 0
            ? 'idle'
            : safe === registered && unreadTrees.length === 0
                ? 'safe'
                : 'waiting';
        return {
            verdict,
            registered,
            safe,
            ...parkedAt === undefined ? {} : { parkedAt: String(parkedAt) },
            draining: draining.sort(),
            parking,
            stalled: stalled.sort(),
            unresumable: unresumable.sort(),
            unreadTrees: unreadTrees.sort(),
            jobs: liveJobs(owners),
            blind,
        };
    };
    return {
        pressAll: async (signal) => {
            for (let round = 0; round < PRESS_ROUNDS; round += 1) {
                const targets = await runningTargets(signal);
                if (targets.length === 0)
                    break;
                for (const sessionId of targets) {
                    signal?.throwIfAborted();
                    // The press is a durable promise per session: one that cannot be
                    // recorded is rolled back there and named here. A session whose
                    // route is not resumable, or has no live log, is left out of the
                    // registry rather than promised a wake the morning path must refuse.
                    const pressed = await deps.press(sessionId, signal);
                    switch (pressed) {
                        case 'registered':
                            markUnrecorded(sessionId, false);
                            deps.look(sessionId);
                            break;
                        case 'unrecordable':
                            markUnrecorded(sessionId, true);
                            break;
                        default:
                            break;
                    }
                }
            }
            const aggregate = await status(signal);
            const answer = aggregate.verdict === 'safe'
                ? 'Every session is paused.'
                : aggregate.verdict === 'idle'
                    ? 'Nothing is running.'
                    : 'Pausing is in progress.';
            return unrecorded.size === 0
                ? { kind: 'success', text: answer }
                : { kind: 'error', text: answer };
        },
        readState: async (signal) => await status(signal),
        markUnrecorded,
    };
}
//# sourceMappingURL=global.js.map