# @tmim/dsh-plugin-tmim

> 🇬🇧 English · 🇨🇳 [简体中文](README.zh-CN.md)（中文说明文档）

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
connects the harness to the **TM IM** network. It turns TM IM into a message
channel for a Harness agent:

- **Inbound**: TM IM Agent Takeover **Webhook** events (`message.created`,
  `mention.created`) are signature-verified, deduplicated, and fed into a
  Harness agent turn.
- **Outbound**: the agent's assistant replies are relayed back to the originating
  TM IM conversation.
- **Tools**: the agent can proactively send messages, create/search conversations,
  and pull history over the TM IM REST API.

Protocol: https://tmim.stkg.ltd/about/integration — a copy of the extracted
protocol contract ships in this repo as [`docs-extra/tmim-integration.md`](docs-extra/tmim-integration.md).

---

## Requirements

- Node.js ≥ 20 (Harness recommends ≥ 24)
- A running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host
- A TM IM account with **Agent Takeover** enabled and an **api_key** (recommended)

## Install

```sh
# inside your harness workspace
npm install @tmim/dsh-plugin-tmim
# or, from this repo
pnpm install && pnpm build
```

Add the plugin to your Cordis composition (`cordis.yml`):

```yaml
- name: '@tmim/dsh-plugin-tmim'
  config:
    baseUrl: 'https://tmim.example.com'
    credential:
      kind: 'apikey'          # or: kind: 'password', username, password
      token: 'tm_xxxxxxxx'
    # WS mode (recommended) — realtime, no public HTTPS needed.
    ws:
      enabled: true            # default
      # url: 'wss://tmim.example.com/ws'   # optional; defaults to baseUrl host
    # Alternative push mode (requires public HTTPS + a one-time webhook_secret):
    # webhook:
    #   enabled: true
    #   path: '/tm/callback'
    #   secret: 'whsec_...'
    agent:
      provider: 'deepseek-official'
      model: 'deepseek-chat'
    enableAgentTakeover: true
```

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | string | — | TM IM base URL, no `/v1` suffix. |
| `credential.kind` | `'apikey' \| 'password'` | — | Authentication mode. |
| `credential.token` | string | — | Agent Takeover api_key (when `apikey`). |
| `credential.username`/`password` | string | — | TM IM login (when `password`). |
| `deviceId` | string | `dsh-<pid>` | Reported via `X-TM-Device-Id`. |
| `enableAgentTakeover` | boolean | `false` | POST takeover config on startup. |
| `ws.enabled` | boolean | `true` | Receive inbound messages via WebSocket long-connection. |
| `ws.url` | string | derived | `ws(s)://<baseUrl host>/ws` unless overridden. |
| `ws.heartbeatMs` | number | `25000` | Heartbeat interval (ms). |
| `webhook.enabled` | boolean | `false` | Mount the webhook receiver (alternative to WS). |
| `webhook.path` | string | `/tm/callback` | URL path; must be public HTTPS. |
| `webhook.secret` | string | `''` | `webhook_secret` (required when enabled). |
| `webhook.maxSkewSeconds` | number | `300` | Replay-protection clock skew. |
| `agent.provider` / `agent.model` | string | — | Model the bridged agent turn uses. |
| `agentPreset` | string | `''` | Agent preset to mount per conversation agent. Empty = host default (desktop profile keeps tools behind presets; mounting the preset restores the agent's full tool set). `inert` disables preset mounting. |
| `cwd` | string | `process.cwd()` | Working directory for new agents. |
| `tools` | boolean | `true` | Register proactive TM IM tools. |
| `relay` | boolean | `true` | Relay assistant replies to TM IM. |

> ⚠️ The `webhook_secret` is shown **only once** by TM IM (at WEBHOOK enable
> time or on explicit rotation). Do not rely on re-reading it from the API.

## How the bridge works

The plugin receives inbound TM IM messages **via a WebSocket long-connection by
default** (`ws.enabled: true`):

1. On startup it connects to `ws(s)://<host>/ws` and sends the first frame
   `CMD_AUTH` carrying the Agent api_key.
2. Once authenticated (`CMD_AUTH_OK`), the server pushes new messages to the
   socket as `CMD_PUSH` frames, which the plugin feeds into a per-conversation
   Harness session (`tmim:<convId>`).
3. `session/event` `assistant/message` events are observed and the final text
   reply is sent back via REST `POST /v1/conversations/{id}/messages`.
4. Heartbeat (`CMD_PING`/`CMD_PONG`) keeps the connection alive; it reconnects
   with backoff if dropped.

> If you prefer **webhook** delivery instead (push, needs a public HTTPS
> endpoint): set `ws.enabled: false` and `webhook.enabled: true` with a
> `webhook.secret`. Only one inbound mode is used at a time is recommended.

Restart-safe resume uses the same session id, so conversation context carries
across restarts.

## Tools

Registered when `tools: true`:

| Tool | Purpose |
|---|---|
| `tmim_send_text` | Send a text message to a conversation (Markdown OK). |
| `tmim_get_or_create_direct_conversation` | Resolve a peer handle to a `convId`. |
| `tmim_create_group_conversation` | Create a group. |
| `tmim_list_conversations` | List recent conversations. |
| `tmim_pull_messages` | Incremental `since_seq` pull of a conversation. |

## Webhook verification (self test)

The signature logic is verified against TM IM's documented test vector (6 cases: HMAC self-test vector, valid verification, mismatched digest, stale/replayed timestamp, malformed header, raw-body sensitivity). Inside the harness workspace:

```sh
cd _harness/deepseek-harness-master/packages/tmim/dsh-plugin-tmim
pnpm test
```

> The package ships its own `vitest.config.ts` because the monorepo root config
> drives a workspace project topology that only discovers tests under
> `packages/*/*/tests/**`; running from the plugin directory keeps the signature
> test self-contained on `node:crypto` + `src/*` (no repo path aliases).

## Security notes

- Never log the webhook secret or api key.
- The webhook handler uses the **raw request body bytes** for verification — do
  not re-serialize JSON.
- An HTTPS, publicly reachable `endpoint_url` is mandatory for production.

## License

MIT
