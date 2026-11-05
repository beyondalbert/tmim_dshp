/**
 * Webhook signature verification per the TM IM protocol.
 *
 * Signing string = `${X-TM-Timestamp}.${rawRequestBody}`
 * Signature     = HMAC-SHA256(webhook_secret, signing_string), hex-encoded, lowercase
 * Header        = `X-TM-Signature: sha256=<hex>`
 *
 * The raw request body bytes MUST be used; re-serializing the parsed JSON
 * changes the byte layout and breaks the signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Hard reference-point used only by the documented self-test vector. */
export const SIGNATURE_HEADER_PREFIX = 'sha256='

export interface WebhookVerificationInput {
  /** Value of the `webhook_secret` issued by TM IM when WEBHOOK push mode was enabled. */
  secret: string
  /** String value of the `X-TM-Timestamp` header (Unix seconds). */
  timestamp: string
  /** Raw request body bytes, exactly as received on the wire. */
  rawBody: Buffer
  /** Value of the `X-TM-Signature` header (e.g. `sha256=abc...`). */
  signatureHeader: string | undefined
  /** Optional current time in whole seconds; defaults to `Math.floor(Date.now()/1000)`. */
  now?: number
  /** Maximum acceptable clock skew in seconds (protocol default 300). */
  maxSkewSeconds?: number
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing-secret' }
  | { ok: false; reason: 'missing-header' }
  | { ok: false; reason: 'bad-format' }
  | { ok: false; reason: 'replay' }
  | { ok: false; reason: 'mismatch' }

/** Constant-time HMAC-SHA256 verification helper. */
export function hmacSha256(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

/** Verify a webhook request signature and freshness. Exported for reuse and tests. */
export function verifyWebhookSignature(input: WebhookVerificationInput): VerificationResult {
  const { secret, timestamp, rawBody, signatureHeader } = input
  if (!secret) return { ok: false, reason: 'missing-secret' }
  if (!signatureHeader) return { ok: false, reason: 'missing-header' }
  if (!signatureHeader.startsWith(SIGNATURE_HEADER_PREFIX)) {
    return { ok: false, reason: 'bad-format' }
  }
  const provided = signatureHeader.slice(SIGNATURE_HEADER_PREFIX.length)
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'bad-format' }

  // Replay protection: reject timestamps too far from now.
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad-format' }
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const maxSkew = input.maxSkewSeconds ?? 300
  if (Math.abs(ts - now) > maxSkew) return { ok: false, reason: 'replay' }

  const expected = hmacSha256(secret, `${timestamp}.${rawBody.toString('utf8')}`)
  const a = Buffer.from(provided.toLowerCase(), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  const match = a.length === b.length && timingSafeEqual(a, b)
  return match ? { ok: true } : { ok: false, reason: 'mismatch' }
}

/** Parse the `X-TM-Signature` header into its raw hex digest, if well-formed. */
export function parseSignature(signatureHeader: string): string | undefined {
  if (!signatureHeader.startsWith(SIGNATURE_HEADER_PREFIX)) return undefined
  const hex = signatureHeader.slice(SIGNATURE_HEADER_PREFIX.length)
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : undefined
}
