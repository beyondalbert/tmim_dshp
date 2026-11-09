/**
 * Runtime TM IM config holder + Host settings RPC handler.
 *
 * The plugin's `config` is supplied by the Host at apply time and is the
 * source of truth for every subscriber (bridge, ws, webhook, tools). This
 * module keeps a mutable snapshot of that config, exposes it to the browser
 * settings page over the TM IM management RPC (get/set), and — where the Host
 * exposes no public "reload plugin config" API — documents that structural
 * changes take effect on restart while connection-scoped fields
 * (baseUrl/credential) are applied to the live client immediately.
 */

import type { TmimConnection, TmimConnection as Connection } from './settings-rpc.ts'
import { registerTmimRpc, TMIM_RPC_CHANNEL } from './settings-rpc.ts'
import type { Config, Credential } from './index.ts'

/** Shape the browser page sends back for a full config (booleans are coerced). */
export interface TmimSettingsPayload {
  baseUrl: string
  deviceId: string
  enableAgentTakeover: boolean
  agentPreset: string
  cwd: string
  tools: boolean
  ws: { enabled: boolean; url: string; heartbeatMs: number }
  webhook: { enabled: boolean; path: string; secret: string; maxSkewSeconds: number }
  credential?: Credential
  agent: { provider: string; model: string }
}

export interface TmimRpcOptions {
  /** Return the current effective config. */
  getConfig(): Config
  /** Apply mutable fields to the live client (baseUrl/credential). No-op default. */
  applyLive?:(patch: Partial<Config>) => void
  /** Persist a config patch to the profile document. No-op default. */
  persist?:(config: Config) => Promise<unknown> | void
}

export function mountTmimSettingsRpc(
  connection: Connection,
  options: TmimRpcOptions,
): () => void {
  const handlers: Record<
    string,
    (payload: unknown) => unknown | Promise<unknown>
  > = {
    get: () => options.getConfig(),
    set: (payload) => {
      const next = sanitizeConfig(options.getConfig(), payload)
      // Apply connection-scoped fields to the running client first.
      options.applyLive?.(next)
      // Persist (host patch) best-effort; ignore failures here — the UI sees
      // success because the running config is already updated.
      const persist = options.persist
      if (persist) {
        Promise.resolve(persist(next)).catch((error) => {
          // Deliberately swallowed: persistence is best-effort and must not
          // fail a browser save that already updated the live bridge.
          const logger = (globalThis as any).console
          logger?.error?.('[tmim] config persist failed:', error)
        })
      }
      return next
    },
  }

  return registerTmimRpc(connection, TMIM_RPC_CHANNEL, async (method, payload) => {
    const handler = handlers[method]
    if (!handler) {
      return { ok: false, error: { code: 'method/not-found', message: `Unknown TM IM method: ${method}` } }
    }
    try {
      return { ok: true, value: await handler(payload) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'tmim/rpc-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
}

/** Deep-merge a browser payload into the current config, preserving unknowns. */
function sanitizeConfig(current: Config, payload: unknown): Config {
  if (typeof payload !== 'object' || payload === null) return current
  const src = payload as Partial<TmimSettingsPayload>
  const next: Config = { ...current }

  if (typeof src.baseUrl === 'string') next.baseUrl = src.baseUrl.trim() || current.baseUrl
  if (typeof src.deviceId === 'string') next.deviceId = src.deviceId.trim() || current.deviceId
  if (typeof src.enableAgentTakeover === 'boolean') next.enableAgentTakeover = src.enableAgentTakeover
  if (typeof src.agentPreset === 'string') next.agentPreset = src.agentPreset.trim()
  if (typeof src.cwd === 'string') next.cwd = src.cwd.trim() || current.cwd
  if (typeof src.tools === 'boolean') next.tools = src.tools

  if (src.ws && typeof src.ws === 'object') {
    next.ws = {
      enabled: src.ws.enabled ?? current.ws.enabled,
      url: typeof src.ws.url === 'string' ? src.ws.url.trim() : current.ws.url,
      heartbeatMs: typeof src.ws.heartbeatMs === 'number' && Number.isFinite(src.ws.heartbeatMs)
        ? src.ws.heartbeatMs
        : current.ws.heartbeatMs,
    }
  }

  if (src.webhook && typeof src.webhook === 'object') {
    next.webhook = {
      enabled: src.webhook.enabled ?? current.webhook.enabled,
      path: typeof src.webhook.path === 'string' ? src.webhook.path.trim() || current.webhook.path : current.webhook.path,
      secret: typeof src.webhook.secret === 'string' ? src.webhook.secret : current.webhook.secret,
      maxSkewSeconds: typeof src.webhook.maxSkewSeconds === 'number' && Number.isFinite(src.webhook.maxSkewSeconds)
        ? src.webhook.maxSkewSeconds
        : current.webhook.maxSkewSeconds,
    }
  }

  if (src.credential && typeof src.credential === 'object') {
    next.credential = src.credential as Credential
  }

  if (src.agent && typeof src.agent === 'object') {
    next.agent = {
      provider: typeof src.agent.provider === 'string' ? src.agent.provider.trim() || current.agent.provider : current.agent.provider,
      model: typeof src.agent.model === 'string' ? src.agent.model.trim() || current.agent.model : current.agent.model,
    }
  }

  return next
}
