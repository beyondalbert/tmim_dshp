/**
 * TM IM settings management RPC — Host side.
 *
 * Mirrors dsh-im's management-RPC architecture (see .tmp-dsh-im-ref/plugin-src/
 * management-rpc.mjs): register a `/api/tmim-<channel>` fetch route on the DSH
 * Host Connection so the browser settings page can read/write TM IM config
 * through `connection.rpc.call('/api', ...)`. This deliberately does NOT rely
 * on the Host's `remote.settings.describe()` mirror (configForms), which only
 * lists namespaces the Host plugin manager serves — a cordis.patch-installed
 * plugin has none, so that path degrades to "unavailable".
 *
 * Persistence: saves update the in-memory running config (survives as long as
 * the plugin process lives) and are diffed/merged into the host patch document
 * via `writeConfigPatch` when a writable profile path is known. Because the DSH
 * Host offers no public "reload plugin config" API, the bridge applies the
 * mutable fields (baseUrl/credential) immediately and the remainder takes
 * effect on restart; the UI communicates this.
 */

export const TMIM_RPC_PREFIX = 'tmim'
/** Browser-facing channel; full endpoint becomes `/api/tmim-config`. */
export const TMIM_RPC_CHANNEL = '/config'

/** Minimal structural types for the host-provided Connection service. */
export interface TmimFetchRoute {
  /**
   * Register a POST route on the DSH Host's public fetch carrier.
   * @returns a disposer that unregisters the route.
   */
  register(route: {
    path: string
    methods: string[]
    requestBody?: string
    fetch(request: Request, info?: unknown): Promise<Response> | Response
  }): () => void
}

export interface TmimConnection {
  fetch: TmimFetchRoute
}

interface RpcEnvelope {
  type?: string
  rpcId?: unknown
  method?: unknown
  payload?: unknown
}

/** `{ ok: true, value }` or `{ ok: false, error }` — mirrors dsh-im's envelope. */
export type RpcResult<T> = { ok: true; value: T } | {
  ok: false
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** Validate a route path so an invalid channel can never mask a typo. */
function rpcEndpoint(channel: string): string {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) {
    throw new TypeError('Invalid TM IM RPC channel')
  }
  return `${TMIM_RPC_PREFIX}${channel}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Wrap a handler result in the Connection's server-response envelope. */
function reply(rpcId: string, result: RpcResult<unknown>): Response {
  const value =
    result.ok === false
      ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
      : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}

/**
 * Register a TM IM management channel through the public /api carrier.
 * The DSH Host applies browser authentication and Host/Origin trust before
 * this handler runs.
 *
 * @param connection - the Host-provided Connection service (host inject `connection`).
 * @param channel - URL-safe channel, e.g. `/config`.
 * @param handler - `(method, payload, signal) => RpcResult`.
 * @returns a disposer that unregisters the route.
 */
export function registerTmimRpc(
  connection: TmimConnection,
  channel: string,
  handler: (method: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>> | RpcResult<unknown>,
): () => void {
  if (typeof connection?.fetch?.register !== 'function') {
    throw new TypeError('DSH Host Connection Fetch registry is required')
  }
  const endpoint = rpcEndpoint(channel)
  return connection.fetch.register({
    path: `/api/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')
      if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message: RpcEnvelope
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (
        !isRecord(message) ||
        message.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== endpoint ||
        !isRecord(call) ||
        typeof call.method !== 'string' ||
        !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'Invalid TM IM management request.' },
        })
      }
      try {
        return reply(rpcId, await handler(call.method, call.payload, request.signal))
      } catch {
        return new Response('TM IM management handler failed', { status: 500 })
      }
    },
  })
}
