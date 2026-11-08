/**
 * The status read the controls consume. The browser implementation is the
 * native Remote stream in `./remote.ts`; this leaf keeps the interface free of
 * transport dependencies.
 * @module dsh-pause-session/client/status
 */

import type { PauseSnapshot } from '../shared.js'

/** The one read the two browser controls share. */
export interface PauseStatusSource {
  /**
   * Read the latest host snapshot.
   * @param signal - lifetime cancellation, supplied by the owning control.
   * @returns the snapshot, or undefined before the stream has answered.
   */
  read(signal?: AbortSignal): Promise<PauseSnapshot | undefined>
}
