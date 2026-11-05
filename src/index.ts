/**
 * @tmim/dsh-plugin-tmim
 *
 * DeepSeek Harness plugin that connects to the TM IM network.
 *
 * Capabilities:
 *   - REST client for the user-end `/v1` API (send, conversations, pull).
 *   - Agent Takeover WEBHOOK receiver (signature-verified, idempotent).
 *   - Bridges inbound TM IM messages into Harness agent turns and relays
 *     assistant replies back.
 *   - Optionally registers tools so the agent can drive TM IM proactively.
 *
 * Auth modes (choose one):
 *   - `kind: 'apikey'` + `token`: an Agent takeover api_key (Bearer). Recommended.
 *   - `kind: 'password'` + `username` + `password`: login to get a JWT.
 *
 * Push mode:
 *   - `webhook.enabled: true`: tmim POSTs events to `${webhook.path}` on the
 *     Harness web server. That URL must be publicly reachable and set as the
 *     `endpoint_url` in TM IM Agent Takeover.
 *   - disabled: the bridge only reacts to REST tool calls; no inbound auto-turn.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TmimClient } from './tmim-client.ts'
import { mountTmimWebhook, type WebhookEvent } from './webhook.ts'
import { TmimBridge } from './bridge.ts'
import { registerTmimTools } from './tools.ts'

// ---- Config ----

export interface WebhookConfig {
  enabled: boolean
  path: string
  secret: string
  maxSkewSeconds: number
}

export interface AgentConfig {
  provider: string
  model: string
}

export type Credential =
  | { kind: 'apikey'; token: string }
  | { kind: 'password'; username: string; password: string }

export type Config = {
  baseUrl: string
  credential: Credential
  deviceId: string
  webhook: WebhookConfig
  enableAgentTakeover: boolean
  agent: AgentConfig
  cwd: string
  tools: boolean
}

export const Config = (z.object({
  baseUrl: z.string().required(),
  credential: z.union([
    z.object({ kind: z.const('apikey'), token: z.string().required() }),
    z.object({
      kind: z.const('password'),
      username: z.string().required(),
      password: z.string().required(),
    }),
  ]),
  deviceId: z.string().default(`dsh-${process.pid}`),
  webhook: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default('/tm/callback'),
    secret: z.string().default(''),
    maxSkewSeconds: z.number().default(300),
  }),
  enableAgentTakeover: z.boolean().default(false),
  agent: z.object({
    provider: z.string().default('deepseek-official'),
    model: z.string().required(),
  }),
  cwd: z.string().default(process.cwd()),
  tools: z.boolean().default(true),
}) as unknown) as Config

export const name = 'tmim'

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.webhook.enabled && !config.webhook.secret) {
    throw new Error('[tmim] webhook.enabled requires webhook.secret (the TM IM webhook_secret)')
  }

  const client = new TmimClient({
    baseUrl: config.baseUrl,
    token: config.credential.kind === 'apikey' ? config.credential.token : undefined,
    deviceId: config.deviceId,
  })

  // Authenticate up-front so misconfiguration fails loudly at boot.
  if (config.credential.kind === 'password') {
    await client.login(config.credential.username, config.credential.password)
    ctx.logger.info('[tmim] authenticated via password login')
  } else {
    client.setToken(config.credential.token)
    ctx.logger.info('[tmim] using Agent api key')
  }

  // Optionally drive Agent Takeover configuration.
  if (config.enableAgentTakeover) {
    const setup = await client.configureAgentTakeover({
      pushMode: config.webhook.enabled ? 1 : 3, // WEBHOOK or PULL
      endpointUrl: config.webhook.enabled ? config.webhook.path : undefined,
      capabilities: ['text'],
      modelInfo: config.agent.model,
    })
    if (setup.webhookSecret && config.webhook.enabled) {
      ctx.logger.warn(
        '[tmim] NEW webhook_secret issued (shown only once) — save it and set webhook.secret. ' +
          'Rotate anytime via POST /v1/me/agent-takeover/rotate-webhook-secret',
      )
    }
  }

  const bridge = new TmimBridge(ctx, {
    getClient: () => client,
    agentOptions: { provider: config.agent.provider, model: config.agent.model },
    cwd: config.cwd,
  })

  // Register all resources in one effect so disposal unwinds them in order.
  ctx.effect(function* () {
    if (config.webhook.enabled) {
      yield mountTmimWebhook(ctx, {
        path: config.webhook.path,
        secret: config.webhook.secret,
        maxSkewSeconds: config.webhook.maxSkewSeconds,
        handle: (event: WebhookEvent) => handleWebhookEvent(bridge, event),
      })
    }

    if (config.tools) {
      yield registerTmimTools(ctx, () => client)
    }

    yield bridge.start()
    ctx.logger.info('[tmim] started (webhook=%s, tools=%s)', config.webhook.enabled, config.tools)
  }, 'tmim')
}

function handleWebhookEvent(bridge: TmimBridge, event: WebhookEvent): void {
  if (event.event !== 'message.created' && event.event !== 'mention.created') return
  const data = event.data as { sender?: { actor_type?: number } } & Record<string, any>
  // Skip messages the agent itself sent (actor_type === 2 is an Agent).
  if (data.sender?.actor_type === 2) return
  void bridge.ingestMessage({
    convId: Number(data.conv_id),
    senderId: Number(data.sender_id),
    text: data.content?.text,
    replyToMessageId: Number(data.reply_to ?? 0) || undefined,
  })
}
