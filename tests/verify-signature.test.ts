import { describe, expect, it } from 'vitest'
import { hmacSha256, verifyWebhookSignature } from '../src/crypto.ts'

/** Protocol's documented self-test vector (docs_integration_tmim §4.3). */
const SECRET = 'whsec_3a7f9c2e5b8d1046'
const TIMESTAMP = '1767225600'
const BODY = '{"event":"message.created","event_id":"evt_01HQ2X3Y4Z5A6B7C8D9E0F","occurred_at":1767225600456,"data":{"message_id":730000000000000002,"conv_id":1001,"seq":8,"sender_id":2002,"msg_type":1,"content":{"text":"收到，今天北京晴"}}}'
const EXPECTED = 'eefcc660e1b273f9a9c36eedc162ccda38380f638d69c434fff0ac633b035712'

describe('TM IM webhook signature', () => {
  it('matches the protocol self-test vector', () => {
    expect(hmacSha256(SECRET, `${TIMESTAMP}.${BODY}`)).toBe(EXPECTED)
  })

  it('verifies a well-formed request', () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: TIMESTAMP,
      rawBody: Buffer.from(BODY, 'utf8'),
      signatureHeader: `sha256=${EXPECTED}`,
      now: 1767225900, // within 300s skew
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects a mismatched signature', () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: TIMESTAMP,
      rawBody: Buffer.from(BODY, 'utf8'),
      signatureHeader: `sha256=${'0'.repeat(64)}`,
      now: 1767225900,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('mismatch')
  })

  it('rejects a replayed (stale) timestamp', () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: TIMESTAMP,
      rawBody: Buffer.from(BODY, 'utf8'),
      signatureHeader: `sha256=${EXPECTED}`,
      now: 1767225900 + 1000, // > 300s skew
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('replay')
  })

  it('rejects a missing or malformed header', () => {
    const base = { secret: SECRET, timestamp: TIMESTAMP, rawBody: Buffer.from(BODY, 'utf8') }
    expect(verifyWebhookSignature({ ...base, signatureHeader: undefined }).ok).toBe(false)
    expect(verifyWebhookSignature({ ...base, signatureHeader: '' }).ok).toBe(false)
    // Wrong prefix
    expect(verifyWebhookSignature({ ...base, signatureHeader: `md5=${EXPECTED}` }).ok).toBe(false)
  })

  it('re-serializing the JSON breaks the signature (raw body is required)', () => {
    const reparsed = JSON.stringify(JSON.parse(BODY))
    expect(reparsed).not.toBe(BODY)
    expect(hmacSha256(SECRET, `${TIMESTAMP}.${reparsed}`)).not.toBe(EXPECTED)
  })
})
