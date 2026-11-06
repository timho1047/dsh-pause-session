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
import { STATUS_PATH } from './shared.js';
/** Send one JSON response without allowing caches to replay pause state. */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
/**
 * Register the read-only status route when the composition is a browser host.
 * @param ctx - plugin context; the route is owned by its child fiber.
 * @param read - compute the current snapshot.
 */
export function mountStatusRoute(ctx, read) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
        const web = Reflect.get(webCtx, 'webServer');
        const connection = Reflect.get(webCtx, 'connection');
        webCtx.effect(() => web.register({
            kind: 'exact',
            path: STATUS_PATH,
            handler: async (req, res) => {
                const rejection = connection.requestRejection(req);
                if (rejection !== undefined) {
                    res.statusCode = rejection;
                    res.end();
                    return;
                }
                if (req.method !== 'GET') {
                    res.statusCode = 405;
                    res.setHeader('allow', 'GET');
                    res.end();
                    return;
                }
                const abort = new AbortController();
                req.once('close', () => { abort.abort(new Error('pause: status request closed')); });
                try {
                    const snapshot = await read(abort.signal);
                    if (!abort.signal.aborted)
                        sendJson(res, 200, snapshot);
                }
                catch {
                    if (!abort.signal.aborted)
                        sendJson(res, 503, { error: 'pause status unavailable' });
                }
            },
        }), 'pause: status route');
    });
}
//# sourceMappingURL=status-route.js.map