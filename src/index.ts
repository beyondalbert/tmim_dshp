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
import { TmimWsClient, type InboundMessage } from './ws-client.ts'
import { trace } from './trace.ts'

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
  /** Optional until a TM IM connection is actually needed. */
  credential?: Credential
  deviceId: string
  webhook: WebhookConfig
  /** Use the TM IM WebSocket long-connection to receive inbound messages in real time. */
  ws: {
    enabled: boolean
    /** WS URL; defaults to ws(s)://<baseUrl host>/ws. */
    url: string
    /** Heartbeat interval, ms. */
    heartbeatMs: number
  }
  enableAgentTakeover: boolean
  agent: AgentConfig
  cwd: string
  tools: boolean
}

export const Config = (z.object({
  baseUrl: z.string().default('http://tmim.stkg.ltd/').description(
    'TM IM 服务器地址（不带 /v1 后缀）。例如：https://tmim.example.com',
  ),
  credential: z.union([
    z.object({
      kind: z.const('apikey').description('使用 Agent Takeover 的 api_key（sk_… 开头，长期有效）'),
      token: z.string().role('secret').required().description('Agent Takeover api_key，在 TM IM 的「Agent 接管」页开启时获取'),
    }),
    z.object({
      kind: z.const('password').description('使用 TM IM 登录账号和密码'),
      username: z.string().required().description('TM IM 登录账号'),
      password: z.string().role('secret').required().description('TM IM 登录密码'),
    }),
  ]).default({ kind: 'apikey', token: '' } as const).description('TM IM 连接凭证，可选；缺省时插件仍会启动，但只有配置凭证后才能收发消息'),
  deviceId: z.string().default(`dsh-${process.pid}`).description('设备标识，会随请求上报（X-TM-Device-Id）'),
  webhook: z.object({
    enabled: z.boolean().default(false).description('是否开启 WEBHOOK 实时接收消息（需要公网可达的 HTTPS endpoint）'),
    path: z.string().default('/tm/callback').description('WEBHOOK 回调路径；对应 TM IM 的 endpoint_url'),
    secret: z.string().role('secret').default('').description('WEBHOOK 签名密钥（webhook_secret），启用时必填；由 TM IM 签发'),
    maxSkewSeconds: z.number().default(300).description('防重放的签名时间戳容忍偏差上限（秒）'),
  }),
  ws: z.object({
    enabled: z.boolean().default(true).description('是否通过 WebSocket 长连接实时接收 TM IM 消息（推荐）'),
    url: z.string().default('').description('WebSocket 地址，留空则按 baseUrl 自动推导为 ws(s)://<host>/ws'),
    heartbeatMs: z.number().default(25000).description('心跳间隔（毫秒）'),
  }),
  enableAgentTakeover: z.boolean().default(false).description('启动时是否自动 POST 开启 Agent Takeover 配置（需要已配置凭证）'),
  agent: z.object({
    provider: z.string().default('deepseek-official').description('应答所用的模型提供商'),
    model: z.string().default('deepseek-chat').description('应答所用的模型名，如 deepseek-chat'),
  }),
  cwd: z.string().default(process.cwd()).description('工作目录'),
  tools: z.boolean().default(true).description('是否向智能体注册主动式的 TM IM 工具（发消息/建会话等）'),
}) as unknown) as Config

export const name = 'tmim'

export const inject = ['tools', 'agents']

apply.inject = inject

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.webhook.enabled && !config.webhook.secret) {
    throw new Error('[tmim] webhook.enabled requires webhook.secret (the TM IM webhook_secret)')
  }

  const client = new TmimClient({
    baseUrl: config.baseUrl,
    ...(config.credential?.kind === 'apikey' && config.credential.token ? { token: config.credential.token } : {}),
    deviceId: config.deviceId,
  })

  // Optional credential: the plugin starts without one so it can be configured
  // later, but cannot authenticate until a token/credentials are supplied.
  const hasCredential =
    (config.credential?.kind === 'apikey' && !!config.credential.token) ||
    (config.credential?.kind === 'password' && !!config.credential.password)
  if (!hasCredential) {
    ctx.logger.warn(
      '[tmim] no credential configured — plugin started in idle mode. ' +
        'Configure credential (Agent api_key or password) to enable messaging.',
    )
  } else if (config.credential!.kind === 'password') {
    await client.login(config.credential!.username, config.credential!.password)
    ctx.logger.info('[tmim] authenticated via password login')
  } else {
    client.setToken(config.credential!.token)
    ctx.logger.info('[tmim] using Agent api key')
  }

  // Optionally drive Agent Takeover configuration (only if credentials exist).
  if (config.enableAgentTakeover) {
    if (!hasCredential) {
      ctx.logger.warn('[tmim] enableAgentTakeover requires a credential; skipping takeover setup')
    } else {
      const setup = await client.configureAgentTakeover({
        ...(config.webhook.enabled
          ? { pushMode: 1 as const, endpointUrl: config.webhook.path }
          : { pushMode: 3 as const }), // WEBHOOK or PULL
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
  }

  // tools/agents are Cordis services: ask for them explicitly via ctx.inject.
  // This works regardless of how the host loader plumbs plugin metadata, and
  // the scoped context keeps them resolveable even from async event handlers.
  await ctx.inject(['tools', 'agents'], (scoped) => {
    const bridge = new TmimBridge(scoped, {
      getClient: () => client,
      agentOptions: toAgentOptions(config.agent),
      cwd: config.cwd,
    })

    // Register all resources in one effect so disposal unwinds them in order.
    return scoped.effect(function* () {
      if (config.webhook.enabled) {
        yield mountTmimWebhook(scoped, {
          path: config.webhook.path,
          secret: config.webhook.secret,
          maxSkewSeconds: config.webhook.maxSkewSeconds,
          handle: (event: WebhookEvent) => handleWebhookEvent(scoped, bridge, event),
        })
      }

      if (config.ws.enabled) {
        yield startWsReceiver(scoped, config, bridge)
      }

      if (config.tools) {
        yield registerTmimTools(scoped, () => client)
      }

      yield bridge.start()
      ctx.logger.info(
        '[tmim] started (webhook=%s, ws=%s, tools=%s)',
        config.webhook.enabled,
        config.ws.enabled,
        config.tools,
      )
    }, 'tmim')
  })
}

function handleWebhookEvent(ctx: Context, bridge: TmimBridge, event: WebhookEvent): void {
  if (event.event !== 'message.created' && event.event !== 'mention.created') return
  const data = event.data as { sender?: { actor_type?: number } } & Record<string, any>
  // Skip messages the agent itself sent (actor_type === 2 is an Agent).
  if (data.sender?.actor_type === 2) return
  const replyTo = data.reply_to == null || data.reply_to === 0 ? undefined : String(data.reply_to)
  bridge
    .ingestMessage({
      convId: String(data.conv_id),
      senderId: String(data.sender_id),
      text: data.content?.text,
      ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
    })
    .catch((error) => ctx.logger.error(`[tmim] webhook ingest failed: ${String(error)}`))
}

/** Build the WebSocket URL from the config, defaulting to the baseUrl host. */
function deriveWsUrl(baseUrl: string, configured: string): string {
  if (configured) return configured
  const isSecure = /^https:/.test(baseUrl)
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `${isSecure ? 'wss' : 'ws'}://${host}/ws`
}

/**
 * Resolve agent model options. When neither provider nor model is set, return
 * undefined so the host's configured default model route (which is known to
 * work) is used; only force provider/model when both are explicitly configured.
 */
function toAgentOptions(agent: AgentConfig): { provider: string; model: string } | undefined {
  if (!agent.provider && !agent.model) return undefined
  return { provider: agent.provider, model: agent.model }
}

/** Create & start the TM IM WebSocket receiver; returns a disposer. */
function startWsReceiver(
  ctx: Context,
  config: Config,
  bridge: TmimBridge,
): () => void {
  const token = config.credential?.kind === 'apikey' ? config.credential.token : ''
  let myActorId: string | null = null
  const client = new TmimWsClient({
    url: deriveWsUrl(config.baseUrl, config.ws.url),
    token,
    clientVersion: 'dsh-tmim-1.0.0',
    deviceId: config.deviceId,
    heartbeatMs: config.ws.heartbeatMs,
    onMessage: (msg: InboundMessage) => handleWsMessage(ctx, bridge, msg, myActorId),
    onState: (state, detail) => {
      ctx.logger.info(`[tmim-ws] ${state}${detail ? ` (${detail})` : ''}`)
      trace('[ws]', { state, detail })
    },
    onAuthenticated: (info) => {
      myActorId = info.actorId
      ctx.logger.info(`[tmim-ws] authenticated as actor ${info.actorId}${info.handle ? ` (${info.handle})` : ''}`)
      trace('[ws] authenticated', { actorId: info.actorId, handle: info.handle })
    },
  })
  client.start()
  return () => client.stop()
}

/** Route a decoded WS PUSH message into the bridge as a user message. */
function handleWsMessage(
  ctx: Context,
  bridge: TmimBridge,
  msg: InboundMessage,
  myActorId: string | null,
): void {
  if (msg.msgType !== 1) {
    ctx.logger.info(`[tmim] ignored push msgType=${msg.msgType}`)
    return
  }
  // Skip our own echoed messages (agent's own replies pushed back to us).
  if (myActorId !== null && String(msg.senderId) === String(myActorId)) {
    ctx.logger.debug(`[tmim] skipped own echo sender=${msg.senderId}`)
    return
  }
  if (!msg.contentJson) {
    ctx.logger.info(`[tmim] ignored push with empty content`)
    return
  }
  let content: { text?: string } | null = null
  try {
    content = JSON.parse(msg.contentJson)
  } catch {
    ctx.logger.error(`[tmim] push content not JSON: ${msg.contentJson}`)
    return
  }
  const text = content?.text
  if (!text) {
    ctx.logger.info(`[tmim] push has no text content`)
    return
  }
  const replyTo = msg.replyTo === '0' ? undefined : String(msg.replyTo)
  ctx.logger.info(`[tmim] WS push -> ingest conv=${msg.convId} sender=${msg.senderId} text=${JSON.stringify(text.slice(0, 80))}`)
  trace('[ws] push received', { convId: msg.convId, senderId: msg.senderId, text: text.slice(0, 80), myActorId })
  bridge
    .ingestMessage({
      convId: msg.convId,
      senderId: msg.senderId,
      text,
      ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
    })
    .catch((error) => ctx.logger.error(`[tmim] ws ingest failed: ${String(error)}`))
}
