/**
 * Bridge: turn inbound TM IM events into Harness agent turns, and relay the
 * agent's assistant replies back to the TM IM conversation.
 *
 * One Harness session is maintained per TM IM conversation (`tmim:<convId>`).
 * Inbound messages become `user` messages via `agent.followup(createUserMessage(...))`.
 * Assistant output is observed through `session/event` (`assistant/message`) and
 * sent back through `TmimClient.sendText`.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TmimClient } from './tmim-client.ts'
import { trace } from './trace.ts'

export interface BridgeOptions {
  /** Provide the authenticated TM IM client. */
  getClient: () => TmimClient
  /** Provider/model selection passed to `ctx.agents.create`; omit to use host default. */
  agentOptions?: { provider: string; model: string }
  /** Working directory for newly-created agents. */
  cwd?: string
}

export class TmimBridge {
  private subscriptions: Array<() => void> = []

  constructor(private ctx: Context, private options: BridgeOptions) {}

  /** Attach listeners; returns a disposer. Call from within an effect. */
  start(): () => void {
    const onEvent = (session: { id: SessionId }, event: { type: string; data: { message?: any } }) => {
      if (event.type !== 'assistant/message') return
      const conv = this.convIdFor(session.id)
      if (conv === undefined) return
      void this.relayAssistant(conv, event)
    }
    this.subscriptions.push(this.ctx.on('session/event' as any, onEvent as any))
    return () => {
      for (const dispose of this.subscriptions.splice(0)) dispose()
    }
  }

  /** Accept one verified inbound tmim event (message.created / mention.created). */
  async ingestMessage(args: {
    convId: string
    senderId: string
    text?: string
    replyToMessageId?: string
  }): Promise<{ sessionId: string }> {
    const convId = args.convId
    const sessionIdStr = this.sessionIdFor(convId)
    const sessionId = sessionIdStr as SessionId
    this.ctx.logger.info(`[tmim] ingestMessage conv=${convId} session=${sessionIdStr}`)
    trace('[ingest]', { convId, sessionIdStr, text: (args.text ?? '').slice(0, 80) })
    const agent = await this.ensureAgent(convId, sessionIdStr, sessionId)
    if (!agent) {
      trace('[ingest] no agent, giving up', { convId })
      return { sessionId: sessionIdStr }
    }
    const message = buildUserMessage(args.text ?? '')
    try {
      agent.followup(message)
      this.ctx.logger.info(`[tmim] followup queued for session=${sessionIdStr}`)
      trace('[ingest] followup queued', { convId, sessionIdStr })
    } catch (error) {
      this.ctx.logger.error(`[tmim] followup threw for session=${sessionIdStr}: ${String(error)}`)
      trace('[ingest] followup THREW', { convId, error: String(error) })
      // Never let a malformed turn take the host down.
    }
    return { sessionId: sessionIdStr }
  }

  /** Get a live agent for a conversation, creating or resuming it as needed. */
  private async ensureAgent(
    convId: string,
    sessionIdStr: string,
    sessionId: SessionId,
  ): Promise<{ followup: (m: UserMessage) => void } | null> {
    const existing = this.ctx.agents.get(sessionId)
    if (existing) {
      trace('[ensureAgent] reuse existing', { sessionIdStr, hasFollowup: typeof existing.followup === 'function' })
      return existing
    }
    // Try to create a fresh agent; the session may already be persisted from a
    // previous run (SessionAlreadyExists), in which case resume it instead.
    try {
      trace('[ensureAgent] creating', { sessionIdStr })
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.options.cwd ?? process.cwd() },
        agentOptions: this.options.agentOptions,
      })
      this.ctx.logger.info(`[tmim] agent created for session=${sessionIdStr}`)
      trace('[ensureAgent] created OK', { sessionIdStr })
      return handle.agent
    } catch (error) {
      const msg = String(error)
      trace('[ensureAgent] create THREW', { sessionIdStr, error: msg })
      if (/already exists/i.test(msg) || error instanceof Error && error.name === 'SessionAlreadyExistsError') {
        this.ctx.logger.info(`[tmim] session exists, resuming session=${sessionIdStr}`)
        try {
          const handle = await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: this.options.agentOptions,
          })
          this.ctx.logger.info(`[tmim] agent resumed for session=${sessionIdStr}`)
          trace('[ensureAgent] resume OK', { sessionIdStr })
          return handle.agent
        } catch (resumeError) {
          this.ctx.logger.error(`[tmim] resume failed for session=${sessionIdStr}: ${String(resumeError)}`)
          trace('[ensureAgent] resume THREW', { sessionIdStr, error: String(resumeError) })
          return null
        }
      }
      this.ctx.logger.error(`[tmim] agent create failed conv=${convId}: ${msg}`)
      return null
    }
  }

  // ---- internals ----

  private sessionIdFor(convId: string): string {
    return `tmim:${convId}`
  }

  private convIdFor(sessionId: SessionId): string | undefined {
    const s = String(sessionId)
    if (!s.startsWith('tmim:')) return undefined
    return s.slice('tmim:'.length) || undefined
  }

  private async relayAssistant(
    convId: string,
    event: { data: { message?: { content?: Array<{ type: string; text?: string }> } } },
  ): Promise<void> {
    const text = textOf(event.data.message)
    this.ctx.logger.info(`[tmim] assistant/message relay conv=${convId} text=${JSON.stringify((text ?? '').slice(0, 80))}`)
    trace('[relay] assistant/message event', { convId, text: (text ?? '').slice(0, 120) })
    if (!text) {
      trace('[relay] no text in assistant message', { convId })
      return
    }
    const client = this.options.getClient()
    try {
      await client.sendText(convId, text, newClientMsgId())
      this.ctx.logger.info(`[tmim] relayed reply to conv ${convId}`)
      trace('[relay] SENT to TM IM', { convId, text: text.slice(0, 120) })
    } catch (error) {
      this.ctx.logger.error(`[tmim-bridge] failed to relay to conv ${convId}: ${String(error)}`)
      trace('[relay] SEND FAILED', { convId, error: String(error) })
    }
  }
}

function textOf(message: { content?: Array<{ type: string; text?: string }> } | undefined): string | undefined {
  if (!message) return undefined
  return message.content
    ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('') || undefined
}

function buildUserMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function newClientMsgId(): string {
  return `c-${randomUUID().replaceAll('-', '')}`
}
