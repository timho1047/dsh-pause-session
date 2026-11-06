/**
 * Client-side bridge from the generated `pauseSession` Remote namespace to the
 * existing control state machines.
 *
 * The controls were written against a command-shaped transport. The native
 * namespace is now the only transport: this adapter maps its unary actions and
 * stream snapshots into that shape, so no host slash command is involved.
 * @module dsh-pause-session/client/remote
 */
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PauseActionResultWire, PauseDecisionRequest, PauseSnapshotWire, TriageRowWire } from '../remote.js';
import type { GlobalStatus, ParkStatus } from '../shared.js';
import type { PauseStatusSource } from './status.js';
/** The generated namespace shape this bridge needs. */
export interface RemotePauseNamespace {
    observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>;
    act(request: {
        readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'goal';
        readonly sessionId: string;
        readonly target?: string;
    }, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: PauseActionResultWire;
        readonly error?: {
            readonly code: string;
        };
    }>;
    triage(request: {
        readonly caller: string;
    }, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: readonly TriageRowWire[];
    }>;
    decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: PauseActionResultWire;
    }>;
}
/** The status shape shared by the controls, with branded ids erased at this boundary. */
export interface PauseSnapshotLike {
    readonly global: GlobalStatus;
    readonly sessions: Readonly<Record<string, ParkStatus>>;
}
/** A remote-backed status source with a change subscription. */
export interface RemoteStatusSource extends PauseStatusSource {
    onChange(listener: () => void): () => void;
}
/**
 * Open the native status stream and expose its latest snapshot to both controls.
 * @param remote - the generated Remote namespace.
 * @param lifetime - client lifetime; aborting it releases the stream.
 * @returns the cached source and its change subscription.
 */
export declare function openRemoteSource(remote: RemotePauseNamespace, lifetime: AbortSignal): RemoteStatusSource;
/** The command-shaped transport the existing controls consume. */
export interface RemoteCommandTransport {
    list(sessionId: SessionId): Promise<{
        readonly ok: boolean;
        readonly value?: readonly CommandDescriptor[];
    }>;
    execute(sessionId: SessionId, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: CommandExecution;
    }>;
}
/** Build the internal command-shaped adapter over the Remote namespace. */
export declare function remoteCommands(remote: RemotePauseNamespace, source: RemoteStatusSource): RemoteCommandTransport;
