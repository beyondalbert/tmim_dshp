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
  /** Optional until a TM IM connection is actually needed. */
  credential?: Credential
  deviceId: string
  webhook: WebhookConfig
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
      agentOptions: { provider: config.agent.provider, model: config.agent.model },
      cwd: config.cwd,
    })

    // Register all resources in one effect so disposal unwinds them in order.
    return scoped.effect(function* () {
      if (config.webhook.enabled) {
        yield mountTmimWebhook(scoped, {
          path: config.webhook.path,
          secret: config.webhook.secret,
          maxSkewSeconds: config.webhook.maxSkewSeconds,
          handle: (event: WebhookEvent) => handleWebhookEvent(bridge, event),
        })
      }

      if (config.tools) {
        yield registerTmimTools(scoped, () => client)
      }

      yield bridge.start()
      ctx.logger.info('[tmim] started (webhook=%s, tools=%s)', config.webhook.enabled, config.tools)
    }, 'tmim')
  })
}

function handleWebhookEvent(bridge: TmimBridge, event: WebhookEvent): void {
  if (event.event !== 'message.created' && event.event !== 'mention.created') return
  const data = event.data as { sender?: { actor_type?: number } } & Record<string, any>
  // Skip messages the agent itself sent (actor_type === 2 is an Agent).
  if (data.sender?.actor_type === 2) return
  const replyTo = Number(data.reply_to ?? 0) || undefined
  void bridge.ingestMessage({
    convId: Number(data.conv_id),
    senderId: Number(data.sender_id),
    text: data.content?.text,
    ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
  })
}
