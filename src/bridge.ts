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

export interface BridgeOptions {
  /** Provide the authenticated TM IM client. */
  getClient: () => TmimClient
  /** Provider/model selection passed to `ctx.agents.create`. */
  agentOptions: { provider: string; model: string }
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
      void this.relayAssistant(conv, session.id, event)
    }
    this.subscriptions.push(this.ctx.on('session/event' as any, onEvent as any))
    return () => {
      for (const dispose of this.subscriptions.splice(0)) dispose()
    }
  }

  /** Accept one verified inbound tmim event (message.created / mention.created). */
  async ingestMessage(args: {
    convId: number
    senderId: number
    text?: string
    replyToMessageId?: number
  }): Promise<{ sessionId: string }> {
    const convId = args.convId
    const sessionIdStr = this.sessionIdFor(convId)
    let agent = this.ctx.agents.get(sessionIdStr as SessionId)
    if (!agent) {
      const handle = await this.ctx.agents.create({
        sessionId: sessionIdStr as SessionId,
        meta: { cwd: this.options.cwd ?? process.cwd() },
        agentOptions: this.options.agentOptions,
      })
      agent = handle.agent
    }
    const message = buildUserMessage(args.text ?? '')
    agent.followup(message)
    return { sessionId: sessionIdStr }
  }

  // ---- internals ----

  private sessionIdFor(convId: number): string {
    return `tmim:${convId}`
  }

  private convIdFor(sessionId: SessionId): number | undefined {
    const s = String(sessionId)
    if (!s.startsWith('tmim:')) return undefined
    const n = Number(s.slice('tmim:'.length))
    return Number.isFinite(n) ? n : undefined
  }

  private async relayAssistant(
    convId: number,
    sessionId: SessionId,
    event: { data: { message?: { content?: Array<{ type: string; text?: string }> } } },
  ): Promise<void> {
    const text = textOf(event.data.message)
    if (!text) return
    const client = this.options.getClient()
    try {
      await client.sendText(convId, text, newClientMsgId())
      this.ctx.logger.debug(`[tmim-bridge] relayed reply to conv ${convId}`)
    } catch (error) {
      this.ctx.logger.error(`[tmim-bridge] failed to relay to conv ${convId}: ${String(error)}`)
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
