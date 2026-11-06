# @tmim/dsh-plugin-tmim

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用于将
Harness 接入 **TM IM** 网络。它把 TM IM 变成 Harness 智能体的消息通道：

- **入站（Inbound）**：TM IM **Agent Takeover** **Webhook** 事件（`message.created`、
  `mention.created`）经过签名校验、去重后，喂给 Harness 智能体的一次作答（turn）。
- **出站（Outbound）**：智能体（assistant）的回复被转发回发起对话的 TM IM 会话。
- **工具（Tools）**：智能体可以主动通过 TM IM REST API 发送消息、创建/查找会话、
  拉取历史消息。

协议文档：https://tmim.stkg.ltd/about/integration —— 本仓库也附带了提取出来的协议
契约副本：[`docs-extra/tmim-integration.md`](docs-extra/tmim-integration.md)。

---

## 运行环境要求

- Node.js ≥ 20（Harness 建议 ≥ 24）
- 一个正在运行的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主
- 一个已开启 **Agent Takeover** 且带有 **api_key**（推荐）的 TM IM 账号

## 安装

```sh
# 在你的 harness 工作区中
npm install @tmim/dsh-plugin-tmim
# 或者，从本仓库源码安装
pnpm install && pnpm build
```

将插件添加到你的 Cordis 组合配置（`cordis.yml`）中：

```yaml
- name: '@tmim/dsh-plugin-tmim'
  config:
    baseUrl: 'https://tmim.example.com'
    credential:
      kind: 'apikey'          # 或: kind: 'password', username, password
      token: 'tm_xxxxxxxx'
    webhook:
      enabled: true
      path: '/tm/callback'
      secret: 'whsec_...'     # 启用 WEBHOOK 推送模式时由 TM IM 签发
    agent:
      provider: 'deepseek-official'
      model: 'deepseek-chat'
    enableAgentTakeover: true
```

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | — | TM IM 基础地址，不要带 `/v1` 后缀。 |
| `credential.kind` | `'apikey' \| 'password'` | — | 认证方式。 |
| `credential.token` | string | — | Agent Takeover 的 api_key（`apikey` 方式时）。 |
| `credential.username`/`password` | string | — | TM IM 登录账号/密码（`password` 方式时）。 |
| `deviceId` | string | `dsh-<pid>` | 通过 `X-TM-Device-Id` 上报。 |
| `enableAgentTakeover` | boolean | `false` | 启动时是否 POST takeover 配置。 |
| `webhook.enabled` | boolean | `false` | 是否挂载 webhook 接收器。 |
| `webhook.path` | string | `/tm/callback` | URL 路径；必须是可公网访问的 HTTPS 地址。 |
| `webhook.secret` | string | `''` | `webhook_secret`（启用时必填）。 |
| `webhook.maxSkewSeconds` | number | `300` | 防重放的时钟偏移上限。 |
| `agent.provider` / `agent.model` | string | — | 桥接智能体作答所使用的模型。 |
| `tools` | boolean | `true` | 是否注册主动式的 TM IM 工具。 |
| `relay` | boolean | `true` | 是否将智能体回复转发回 TM IM。 |

> ⚠️ `webhook_secret` 只会由 TM IM **展示一次**（在启用 WEBHOOK 时或显式轮换时）。
> 不要依赖通过 API 重新读取它。

## 桥接工作原理

1. TM IM 以带 `X-TM-Signature` 的请求向 `webhook.path` POST 一个事件。
2. 接收器校验 `HMAC-SHA256(secret, "<ts>.<rawBody>")` 以及时间新鲜度，然后立刻返回
   `200`（那 5 秒预算只用于返回 HTTP 响应，而不是用于 LLM 的处理）。
3. 每个 TM IM 会话对应一个唯一的 Harness 会话（`tmim:<convId>`），入站文本通过
   `agent.followup(createUserMessage(...))` 送入。
4. 监听 `session/event` 的 `assistant/message` 事件，并把最终文本回复通过
   `POST /v1/conversations/{id}/messages` 发回会话。

使用相同的会话 id 可以做到重启后恢复，因此会话上下文在重启后仍然保留。

## 工具

当 `tools: true` 时注册以下工具：

| 工具 | 用途 |
|---|---|
| `tmim_send_text` | 向会话发送文本消息（支持 Markdown）。 |
| `tmim_get_or_create_direct_conversation` | 将对方 handle 解析为 `convId`。 |
| `tmim_create_group_conversation` | 创建群组。 |
| `tmim_list_conversations` | 列出最近的会话。 |
| `tmim_pull_messages` | 基于 `since_seq` 增量拉取会话消息。 |

## Webhook 校验（自测）

签名逻辑通过 TM IM 文档中的测试向量进行验证（共 6 个用例：HMAC 自测向量、有效校验、
摘要不匹配、过期/重放的时间戳、格式错误的头、原始请求体敏感度）。在 harness 工作区中：

```sh
cd _harness/deepseek-harness-master/packages/tmim/dsh-plugin-tmim
pnpm test
```

> 本包自带 `vitest.config.ts`，因为 monorepo 根配置驱动的工作区工程拓扑只会发现
> `packages/*/*/tests/**` 下的测试；从插件目录运行可以让签名测试基于
> `node:crypto` + `src/*` 独立进行（无需仓库路径别名）。

## 安全注意事项

- 永远不要记录（log）webhook secret 或 api key。
- webhook 处理器使用**原始请求体字节**进行校验——不要重新序列化 JSON。
- 生产环境必须使用 HTTPS 且公网可达的 `endpoint_url`。

## 许可证

MIT
