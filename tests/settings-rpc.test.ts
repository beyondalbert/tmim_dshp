import { describe, expect, it } from 'vitest'
import { registerTmimRpc, TMIM_RPC_CHANNEL, TMIM_RPC_PREFIX } from '../src/settings-rpc.ts'
import { mountTmimSettingsRpc } from '../src/settings-rpc-handler.ts'
import type { Config } from '../src/index.ts'

function makeFetchRegistry() {
  const routes: Array<{ path: string; fetch: (r: Request) => Promise<Response> }> = []
  const connection = {
    fetch: {
      register(route: any) {
        routes.push({ path: route.path, fetch: route.fetch })
        return () => {
          const i = routes.indexOf(routes.find(r => r.path === route.path)!)
          if (i >= 0) routes.splice(i, 1)
        }
      },
    },
  }
  return {
    connection,
    routes,
    // Simulate the DSH Connection transport: POST to /api/<endpoint> with an
    // envelope { type:'client-request', rpcId, method: endpoint, payload }.
    async call(endpoint: string, method: string, payload: unknown) {
      const route = routes.find(r => r.path === `/api/${TMIM_RPC_PREFIX}${TMIM_RPC_CHANNEL}`)!
      const request = new Request(`http://x${route.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r1',
          method: endpoint,
          payload: { method, payload: payload ?? null },
        }),
      })
      const res = await route.fetch(request)
      const body = await res.json()
      return body.result
    },
  }
}

const baseConfig: Config = {
  baseUrl: 'http://tmim.example.com',
  credential: { kind: 'apikey', token: 'sk_test' },
  deviceId: 'dsh-x',
  enableAgentTakeover: false,
  agentPreset: '',
  cwd: '/tmp',
  tools: true,
  ws: { enabled: true, url: '', heartbeatMs: 25000 },
  webhook: { enabled: false, path: '/tm/callback', secret: '', maxSkewSeconds: 300 },
  agent: { provider: 'deepseek-official', model: 'deepseek-chat' },
}

describe('settings RPC host registration', () => {
  it('registers the tmim/config route on the connection', () => {
    const { connection, routes } = makeFetchRegistry()
    const stop = registerTmimRpc(connection as any, TMIM_RPC_CHANNEL, () => ({ ok: true, value: {} }))
    expect(routes.map(r => r.path)).toContain('/api/tmim/config')
    stop()
    expect(routes).toHaveLength(0)
  })
})

describe('settings RPC round trip', () => {
  it('reads the running config via get', async () => {
    const { connection, call } = makeFetchRegistry()
    let live = baseConfig
    mountTmimSettingsRpc(connection as any, { getConfig: () => live })
    const result = await call('tmim/config', 'get', null)
    expect(result.ok).toBe(true)
    expect(result.value.baseUrl).toBe('http://tmim.example.com')
    expect(result.value.credential.token).toBe('sk_test')
  })

  it('merges a browser set payload and reports the merged config', async () => {
    const { connection, call } = makeFetchRegistry()
    let live = { ...baseConfig }
    mountTmimSettingsRpc(connection as any, {
      getConfig: () => live,
      applyLive: (patch: Partial<Config>) => { live = { ...live, ...patch } as Config },
    })
    const result = await call('tmim/config', 'set', {
      baseUrl: 'https://other.example.com',
      tools: false,
      ws: { enabled: false, url: '', heartbeatMs: 30000 },
    })
    expect(result.ok).toBe(true)
    expect(result.value.baseUrl).toBe('https://other.example.com')
    expect(result.value.tools).toBe(false)
    expect(result.value.ws.heartbeatMs).toBe(30000)
    // Unchanged fields preserved.
    expect(result.value.deviceId).toBe('dsh-x')
  })

  it('rejects an unknown method', async () => {
    const { connection, call } = makeFetchRegistry()
    mountTmimSettingsRpc(connection as any, { getConfig: () => baseConfig })
    const result = await call('tmim/config', 'bogus', null)
    expect(result.ok).toBe(false)
  })
})
