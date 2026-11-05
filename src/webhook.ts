/**
 * TM IM webhook receiver.
 *
 * Mounts an exact HTTP route on the Harness web server that TM IM POSTs
 * agent-takeover events to. It:
 *   1. Verifies `X-TM-Signature` (HMAC-SHA256 over `ts.body`) and freshness.
 *   2. Deduplicates by `X-TM-Event-Id`.
 *   3. Returns 200 fast, then hands the event to a handler (async processing).
 *
 * Route handler owns the full response lifecycle (Harness WebServer contract).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { verifyWebhookSignature, type VerificationResult } from './crypto.ts'

export interface WebhookEvent {
  event: string
  event_id: string
  occurred_at: number
  data: Record<string, unknown>
}

export interface TmimWebhookOptions {
  /** Path this receiver is mounted at. Must match the endpoint_url configured in TM IM. */
  path: string
  /** webhook_secret issued by TM IM. */
  secret: string
  /** Called with each verified, non-duplicate event. Return once handed off. */
  handle: (event: WebhookEvent, meta: { deliveryAttempt: number }) => void | Promise<void>
  /** In-memory dedup set. Replace to persist across restarts. */
  processedEventIds?: Set<string>
  /** Clock skew tolerance, seconds (protocol default 300). */
  maxSkewSeconds?: number
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Register the webhook receiver on a Harness `webServer` context.
 * @returns a disposer that unmounts the route.
 */
export function mountTmimWebhook(ctx: Context, options: TmimWebhookOptions): () => void {
  const webServer = ctx.webServer
  const processed = options.processedEventIds ?? new Set<string>()
  const seen = new Map<string, string>() // event_id -> last delivery attempt

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }

    // Capture the RAW body bytes BEFORE any parsing (signature correctness).
    const raw = await readBody(req)
    const header = (name: string) => req.headers[name.toLowerCase()]?.toString()

    const tsHeader = header('x-tm-timestamp')
    const sigHeader = header('x-tm-signature')
    const eventId = header('x-tm-event-id')
    const deliveryAttempt = Number(header('x-tm-delivery-attempt') ?? '1')

    const result = verifyWebhookSignature({
      secret: options.secret,
      timestamp: tsHeader ?? '',
      rawBody: raw,
      signatureHeader: sigHeader,
      maxSkewSeconds: options.maxSkewSeconds,
    })

    if (!result.ok || !tsHeader) {
      respond(res, 400, 'unauthenticated')
      ctx.logger.warn(`[tmim-webhook] rejected event ${eventId ?? '(no id)'}: ${deserializeResult(result)}`)
      return
    }

    // Idempotency: same event_id and same-or-higher attempt -> already handled.
    const last = seen.get(eventId ?? '')
    if (eventId && last !== undefined && Number(last) <= deliveryAttempt) {
      respond(res, 200, 'duplicate')
      return
    }

    let event: WebhookEvent
    try {
      event = JSON.parse(raw.toString('utf8')) as WebhookEvent
    } catch {
      respond(res, 400, 'bad json')
      return
    }

    // Record before handing off; rapid retries must see "already handled".
    if (eventId) seen.set(eventId, String(deliveryAttempt))
    if (eventId) processed.add(eventId)

    respond(res, 200, 'ok')

    // Async processing after the fast 200 (5s limit is on HTTP return, not work).
    try {
      await options.handle(event, { deliveryAttempt })
    } catch (error) {
      ctx.logger.error(`[tmim-webhook] handler failed for event ${eventId}: ${String(error)}`)
    }
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: options.path,
    handler,
  })

  ctx.logger.info(`[tmim-webhook] mounted at ${options.path}`)
  return dispose
}

function deserializeResult(result: VerificationResult): string {
  return result.ok ? 'ok' : result.reason
}

function respond(res: ServerResponse, status: number, statusText: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: statusText }))
}
