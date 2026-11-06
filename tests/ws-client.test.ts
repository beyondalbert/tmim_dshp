import { describe, expect, it } from 'vitest'
import { parseInbound, parsePush, CMD } from '../src/ws-client.ts'

/** Protocol's documented PUSH frame (docs 04-realtime.md §4.4, 70 bytes). */
const PUSH_FRAME = [
  0x08, 0x0c, 0x1a, 0x42,
  0x0a, 0x40,
  0x08, 0x82, 0x80, 0xa4, 0xf0, 0x9d, 0xe4, 0xde, 0x90, 0x0a,
  0x10, 0xe9, 0x07,
  0x18, 0x08,
  0x20, 0xd2, 0x0f,
  0x28, 0x01,
  0x32, 0x23,
  ...new TextEncoder().encode('{"text":"收到，今天北京晴"}'),
  0x40, 0xc8, 0xd3, 0xea, 0xb6, 0xb7, 0x33,
]

describe('TM IM WebSocket codec', () => {
  it('parses a documented CMD_PUSH frame', () => {
    const parsed = parseInbound(new Uint8Array(PUSH_FRAME))
    expect(parsed.cmd).toBe(CMD.PUSH)
    expect(parsed.reqId).toBe(0)
    expect(parsed.payload.length).toBe(66)
  })

  it('decodes PushMessage fields from the documented sample', () => {
    const parsed = parseInbound(new Uint8Array(PUSH_FRAME))
    const msg = parsePush(parsed.payload)
    expect(msg.convId).toBe(1001)
    expect(msg.seq).toBe(8)
    expect(msg.senderId).toBe(2002)
    expect(msg.msgType).toBe(1)
    expect(msg.messageId).toBe('730000000000000002')
    expect(msg.contentJson).toBe('{"text":"收到，今天北京晴"}')
    expect(msg.createdAtMs).toBe('1767225600456')
  })
})
