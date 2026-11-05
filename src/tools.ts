/**
 * Tools exposed to the Harness agent so it can operate the TM IM network
 * proactively (proactive sends, conversation discovery, etc.) — independent of
 * the inbound webhook path.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TmimClient } from './tmim-client.ts'

function newClientMsgId(): string {
  return `c-${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Register TM IM tools in the current context.
 * @returns disposer removing all registered tools.
 */
export function registerTmimTools(ctx: Context, client: () => TmimClient): () => void | Promise<void> {
  const dispose = ctx.effect(function* () {
    yield ctx.tools.register(defineTool({
      name: 'tmim_send_text',
      description:
        'Send a text message to a TM IM conversation. Provide convId (numeric id) and text. ' +
        'Use tmim_find_conversation first if you only know the peer handle.',
      parameters: {
        convId: { type: 'number', required: true, description: 'TM IM conversation id.' },
        text: { type: 'string', required: true, description: 'Text payload (Markdown allowed).' },
        replyTo: { type: 'number', description: 'Optional message_id to quote/reply to.' },
      },
      output: { schema: { type: 'json' } as const },
      execute: async (args) => {
        const result = await client().sendText(args.convId, args.text, newClientMsgId(), args.replyTo)
        return { sent: true, messageId: result.messageId, seq: result.seq }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'tmim_get_or_create_direct_conversation',
      description:
        'Get or create a direct (1:1) conversation with a peer handle (e.g. "@alice"). Returns the convId.',
      parameters: {
        peer: { type: 'string', required: true, description: 'Peer handle, e.g. "@alice".' },
      },
      output: { schema: { type: 'json' } as const },
      execute: async (args) => {
        const result = await client().getOrCreateDirectConversation(args.peer)
        return {
          convId: result.convId,
          created: result.created,
          peer: result.peer,
          lastSeq: result.lastSeq,
        }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'tmim_create_group_conversation',
      description: 'Create a group conversation with the given title and member handles.',
      parameters: {
        title: { type: 'string', required: true, description: 'Group title.' },
        members: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Member handles (excluding yourself), e.g. ["@alice","@bob"].',
        },
      },
      output: { schema: { type: 'json' } as const },
      execute: async (args) => {
        const result = await client().createGroupConversation(args.title, args.members)
        return { convId: result.convId }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'tmim_list_conversations',
      description: 'List the agent\'s TM IM conversations (recent first).',
      parameters: {
        limit: { type: 'number', description: 'Max items (default 50).' },
      },
      output: { schema: { type: 'json' } as const },
      execute: async (args) => {
        const result = await client().listConversations(args.limit ?? 50)
        return { items: result.items, nextCursor: result.nextCursor }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'tmim_pull_messages',
      description: 'Incrementally pull new messages since a seq for a conversation (ascending).',
      parameters: {
        convId: { type: 'number', required: true, description: 'Conversation id.' },
        sinceSeq: { type: 'number', required: true, description: 'Only messages with seq > this are returned.' },
        limit: { type: 'number', description: 'Max items (default 200).' },
      },
      output: { schema: { type: 'json' } as const },
      execute: async (args) => {
        const items = await client().pullMessagesSince(args.convId, args.sinceSeq, args.limit ?? 200)
        return { items }
      },
    }))
  }, 'tmim.tools')
  return dispose
}
