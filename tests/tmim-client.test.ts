import { describe, expect, it } from 'vitest'
import { TmimClient } from '../src/tmim-client.ts'

function captureClient(baseUrl: string) {
  let capturedUrl = ''
  const client = new TmimClient({
    baseUrl,
    token: 'sk_test',
    fetch: (async (input: any) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ code: 0, message: 'ok', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as any,
  })
  return { client, url: () => capturedUrl }
}

describe('TmimClient URL construction', () => {
  it('does not produce a double slash when baseUrl has a trailing slash', async () => {
    const { client, url } = captureClient('http://tmim.stkg.ltd/')
    await (client as any).request('POST', '/conversations/123/messages', {})
    expect(url()).toBe('http://tmim.stkg.ltd/v1/conversations/123/messages')
  })

  it('works with a trailing-slash baseUrl and preserves a large conv id string', async () => {
    const { client, url } = captureClient('http://tmim.stkg.ltd/')
    const conv = '377009609483804672'
    await (client as any).request('POST', `/conversations/${conv}/messages`, {
      msg_type: 'TEXT',
      client_msg_id: 'c-x',
      content: { text: 'hi' },
    })
    expect(url()).toBe(`http://tmim.stkg.ltd/v1/conversations/${conv}/messages`)
  })

  it('still builds a single-slash URL for a slash-less baseUrl', async () => {
    const { client, url } = captureClient('http://tmim.stkg.ltd')
    await (client as any).request('GET', '/conversations', null, { auth: false })
    expect(url()).toBe('http://tmim.stkg.ltd/v1/conversations')
  })
})
