# @tmim/dsh-plugin-tmim

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
    webhook:
      enabled: true
      path: '/tm/callback'
      secret: 'whsec_...'     # issued by TM IM when WEBHOOK push mode enabled
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
| `webhook.enabled` | boolean | `false` | Mount the webhook receiver. |
| `webhook.path` | string | `/tm/callback` | URL path; must be public HTTPS. |
| `webhook.secret` | string | `''` | `webhook_secret` (required when enabled). |
| `webhook.maxSkewSeconds` | number | `300` | Replay-protection clock skew. |
| `agent.provider` / `agent.model` | string | — | Model the bridged agent turn uses. |
| `tools` | boolean | `true` | Register proactive TM IM tools. |
| `relay` | boolean | `true` | Relay assistant replies to TM IM. |

> ⚠️ The `webhook_secret` is shown **only once** by TM IM (at WEBHOOK enable
> time or on explicit rotation). Do not rely on re-reading it from the API.

## How the bridge works

1. TM IM POSTs an event to `webhook.path` with an `X-TM-Signature`.
2. The receiver verifies `HMAC-SHA256(secret, "<ts>.<rawBody>")` and freshness,
   then returns `200` immediately (the 5-second budget is only for the HTTP
   return, not for LLM work).
3. A unique Harness session per TM IM conversation (`tmim:<convId>`) is created
   and the inbound text is fed via `agent.followup(createUserMessage(...))`.
4. `session/event` `assistant/message` events are observed and the final text
   reply is sent back to the conversation with `POST /v1/conversations/{id}/messages`.

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

The signature logic is verified against TM IM's documented test vector:

```sh
npm run test:signature
```

## Security notes

- Never log the webhook secret or api key.
- The webhook handler uses the **raw request body bytes** for verification — do
  not re-serialize JSON.
- An HTTPS, publicly reachable `endpoint_url` is mandatory for production.

## License

MIT
