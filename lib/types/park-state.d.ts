/**
 * One session's park episode: the durable phase writes, the activity walk that
 * settles them, and the press/release lifecycle. The control composes this with
 * the aggregate, the resume path, and the decision list.
 * @module dsh-pause-session/park-state
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { PauseGate } from './gate.js';
import type { LivePark, PressResult } from './global.js';
import type { ParkWatch } from './park.js';
import type { ParkRegistry } from './registry.js';
import type { ParkPhase, PauseAnswer } from './shared.js';
/** One session's park in progress. */
export interface ParkMark {
    /** The phase the durable registry confirms for this session. */
    phase: ParkPhase;
    /** Generation of the attempt that owns this mark. */
    generation: number;
    /** Whether this mark is a live press or a record adopted at mount. */
    origin: 'press' | 'registry';
    /** Whether a settle attempt is already walking this mark. */
    advancing: boolean;
}
/** The park lifecycle the session control composes. */
export interface ParkState {
    readonly marks: Map<SessionId, ParkMark>;
    readonly unrecorded: Set<SessionId>;
    readonly unheld: Set<SessionId>;
    subscribe(listener: () => void): () => void;
    notify(): void;
    press(sessionId: SessionId, signal?: AbortSignal, knownResumable?: boolean): Promise<PressResult>;
    /** Adopt one durable record as a mark that never advances in this process. */
    adopt(sessionId: SessionId, phase: ParkPhase): void;
    look(sessionId: SessionId): void;
    drop(sessionId: SessionId): void;
    sync(sessionId: SessionId): void;
    release(sessionId: SessionId, text: string): Promise<PauseAnswer>;
    markUnrecorded(sessionId: SessionId, unrecorded: boolean): void;
    live(): Map<SessionId, LivePark>;
    cleanup(): void;
}
/**
 * Mount the park episode state machine over the gate, registry, and activity fold.
 * @param ctx - host context carrying the session store and logger.
 * @param gate - the pause gate this state drives.
 * @param registry - the durable pause list every phase write goes to.
 * @param watch - the activity fold the park predicate reads.
 * @returns the park lifecycle the control composes.
 */
export declare function installParkState(ctx: Context, gate: PauseGate, registry: ParkRegistry, watch: ParkWatch): ParkState;
