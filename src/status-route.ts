/**
 * The browser status route: one authenticated JSON read of the host's pause
 * state, outside the Session log.
 *
 * A background status read has no business writing `command/run` and
 * `command/done` records into a Session's transcript. The route is available
 * only where the Web carrier mounts it; without `webServer` or `connection`
 * the browser falls back to the command channel, which keeps Desktop and
 * headless compositions working.
 *
 * Security follows the composition's browser fence: every request asks
 * `connection.requestRejection` before the state is computed. The route is
 * read-only and returns only the same status the command surface already
 * publishes; it has no path input and no state-changing verb.
 *
 * @module dsh-pause-session/status-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { STATUS_PATH } from './shared.js'
import type { PauseSnapshot } from './shared.js'

/** The route carrier surface this plugin uses; host-webserver owns the full type. */
interface WebServerLike {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The browser trust fence; client-connection owns the full type. */
interface ConnectionLike {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Send one JSON response without allowing caches to replay pause state. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Register the read-only status route when the composition is a browser host.
 * @param ctx - plugin context; the route is owned by its child fiber.
 * @param read - compute the current snapshot.
 */
export function mountStatusRoute(
  ctx: Context,
  read: (signal?: AbortSignal) => Promise<PauseSnapshot>,
): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const web = Reflect.get(webCtx, 'webServer') as WebServerLike
    const connection = Reflect.get(webCtx, 'connection') as ConnectionLike
    webCtx.effect(() => web.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const abort = new AbortController()
        req.once('close', () => { abort.abort(new Error('pause: status request closed')) })
        try {
          const snapshot = await read(abort.signal)
          if (!abort.signal.aborted) sendJson(res, 200, snapshot)
        } catch {
          if (!abort.signal.aborted) sendJson(res, 503, { error: 'pause status unavailable' })
        }
      },
    }), 'pause: status route')
  })
}
