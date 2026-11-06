// Live end-to-end probe: connect to the real TM IM WS endpoint and authenticate.
// Requires a valid Agent api_key in the host config; skipped when absent.
import { readFileSync, existsSync } from 'node:fs'
import { it, expect } from 'vitest'
import { TmimWsClient } from '../src/ws-client.ts'

const configPath = 'C:/Users/albert/.dsh/profiles/desktop/cordis.patch.yml'
let token = ''
if (existsSync(configPath)) {
  const m = readFileSync(configPath, 'utf8').match(/id:\s*tmim[\s\S]*?token:\s*[\"']?([^\"'\n]+)/)
  token = m ? m[1].trim() : ''
}

const run = process.env.TMIM_WS_LIVE === '1'

it.skipIf(!run || !token)('connects & authenticates to live TM IM WS endpoint', async () => {
  const authenticated = await new Promise<string>((resolve, reject) => {
    const client = new TmimWsClient({
      url: 'ws://tmim.stkg.ltd/ws',
      token,
      onState: (state) => {
        if (state === 'authenticated') resolve('ok')
      },
      onAuthenticated: (info) => {
        console.log('[live] authenticated actor', info.actorId, info.handle)
      },
    })
    client.start()
    setTimeout(() => {
      client.stop()
      reject(new Error('timeout waiting for auth'))
    }, 10000)
  })
  expect(authenticated).toBe('ok')
}, 15000)
