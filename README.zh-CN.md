# @tmim/dsh-plugin-tmim

> 🇬🇧 [English README](README.md) · 🇨🇳 简体中文

**一句话简介**：`@tmim/dsh-plugin-tmim` 是一个 DeepSeek Harness 插件，通过 WebSocket 长连接（或 webhook）接收入站消息、驱动 Harness 智能体作答，并把回复连同主动式工具（发消息、建会话、查历史等）能力一起回接到 TM IM 网络。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用于将
Harness 接入 **TM IM** 网络。它把 TM IM 变成 Harness 智能体的消息通道：

- **入站（Inbound）**：TM IM 的入站消息通过 **WebSocket 长连接（默认）** 或
  **Agent Takeover Webhook（备选）** 接收，经校验、去重后，喂给 Harness 智能体的一次作答（turn）。
- **出站（Outbound）**：智能体（assistant）的回复被转发回发起对话的 TM IM 会话。
- **工具（Tools）**：智能体可以主动通过 TM IM REST API 发送消息、创建/查找会话、
  拉取历史消息。

协议文档：https://tmim.stkg.ltd/about/integration —— 本仓库也附带了提取出来的协议
契约副本：[`docs-extra/tmim-integration.md`](docs-extra/tmim-integration.md)。

---

## 运行环境要求

- Node.js ≥ 20（Harness 建议 ≥ 24）
- 一个正在运行的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主
  （桌面版 / `web` profile）
- 一个已开启 **Agent Takeover** 且带有 **api_key**（推荐）的 TM IM 账号
- 你的 TM IM 基础地址（base URL），例如 `http://tmim.stkg.ltd/`

---

## 快速安装与配置（Quick Start）

以下步骤以 **DeepSeek Harness 桌面版（desktop profile）** 为例。`dsh` CLI 位于
Harness 安装目录 `resources/runtime/cli/bin/dsh.cmd`（可将其加入 PATH 后直接使用 `dsh`）。

### 1. 安装插件

```sh
# 安装（或升级）插件到 desktop profile
dsh plugin --profile desktop add @tmim/dsh-plugin-tmim

# 安装指定版本
dsh plugin --profile desktop add "@tmim/dsh-plugin-tmim@0.1.16"
```

安装后 **必须重启 DeepSeek Harness 的 Electron 应用**，修改才会生效。

### 2. 配置（示例）

编辑 profile 的覆盖文件 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，
添加（或更新）`tmim` 条目：

```yaml
- id: tmim
  name: '@tmim/dsh-plugin-tmim'
  config:
    baseUrl: 'http://tmim.stkg.ltd/'     # 你的 TM IM 基础地址（末尾斜杠会自动归一化）
    credential:
      kind: apikey                       # 或: kind: 'password', username, password
      token: 'sk_live_xxxxxxxx'          # Agent Takeover api_key
    agent:
      provider: ''                       # 留空 = 使用宿主默认模型路由
      model: ''
    # agentPreset: ''                    # 留空 = 挂载宿主默认 preset（桌面版=standard，含全部工具）；'inert' 关闭
    enableAgentTakeover: true
```

> 也可以在桌面版 **设置 → 插件 → TM IM** 界面里填写同样的配置项（推荐，保存即生效并写入
> `cordis.patch.yml`）。配置界面由插件的客户端 bundle 提供：在侧边的 **插件（Plugins）** 页面点开
> `@tmim/dsh-plugin-tmim` 即可看到“TM IM”设置表单。

### 2.1 通过 YAML 配置（备选）

### 3. 重启并验证

1. 重启 DeepSeek Harness。
2. 在 TM IM 里给该 Agent 发送一条消息。
3. 查看 trace 日志 `%TEMP%\dsh-tmim-trace.log`，确认出现：
   - WS 认证 / 入站消息被 ingest；
   - `[composeSetup]` 成功解析并挂载 preset；
   - `[relay] SENT to TM IM` 表示回复已回写。

### 4. 排查要点

| 现象 | 检查 |
|---|---|
| 收不到消息 / 无回复 | 确认 `baseUrl` 为 `http://tmim.stkg.ltd/`（不要带 `/v1`；末尾斜杠会自动处理）；确认 WS 已启用（`ws.enabled: true`） |
| 回复能发出但“没有执行工具” | 确认 `agentPreset` 留空（挂载宿主默认 preset），且 trace 中 `[composeSetup]` 没有 FAILED |
| 改了配置不生效 | 每次 `dsh plugin ... add` 或改配置后都需**重启 Electron 应用** |

---

## 安装（通用 / 源码）

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
    baseUrl: 'http://tmim.example.com'
    credential:
      kind: 'apikey'          # 或: kind: 'password', username, password
      token: 'tm_xxxxxxxx'
    ws:
      enabled: true           # 默认：WebSocket 长连接接收
    # 备选推送模式（需要公网 HTTPS + 一次性 webhook_secret）：
    # webhook:
    #   enabled: true
    #   path: '/tm/callback'
    #   secret: 'whsec_...'
    agent:
      provider: ''            # 留空 = 使用宿主默认模型路由
      model: ''
    enableAgentTakeover: true
```

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | — | TM IM 基础地址，不要带 `/v1` 后缀（末尾斜杠会自动归一化）。 |
| `credential.kind` | `'apikey' \| 'password'` | — | 认证方式。 |
| `credential.token` | string | — | Agent Takeover 的 api_key（`apikey` 方式时）。 |
| `credential.username`/`password` | string | — | TM IM 登录账号/密码（`password` 方式时）。 |
| `deviceId` | string | `dsh-<pid>` | 通过 `X-TM-Device-Id` 上报。 |
| `enableAgentTakeover` | boolean | `false` | 启动时是否 POST takeover 配置。 |
| `ws.enabled` | boolean | `true` | 是否用 WebSocket 长连接接收入站消息。 |
| `ws.url` | string | 派生 | `ws(s)://<baseUrl host>/ws`，除非显式覆盖。 |
| `ws.heartbeatMs` | number | `25000` | 心跳间隔（毫秒）。 |
| `webhook.enabled` | boolean | `false` | 是否挂载 webhook 接收器（WS 的备选方案）。 |
| `webhook.path` | string | `/tm/callback` | URL 路径；必须是可公网访问的 HTTPS 地址。 |
| `webhook.secret` | string | `''` | `webhook_secret`（启用时必填）。 |
| `webhook.maxSkewSeconds` | number | `300` | 防重放的时钟偏移上限。 |
| `agent.provider` / `agent.model` | string | — | 桥接智能体作答所使用的模型；留空 = 使用宿主默认。 |
| `agentPreset` | string | `''` | 每个会话智能体挂载的 Agent preset；留空 = 宿主默认（桌面版把工具都放在 preset 里，挂载后智能体才有完整工具集）；`'inert'` 关闭预设挂载。 |
| `cwd` | string | `process.cwd()` | 新建智能体的工作目录。 |
| `tools` | boolean | `true` | 是否注册主动式的 TM IM 工具。 |
| `relay` | boolean | `true` | 是否将智能体回复转发回 TM IM。 |

> ⚠️ `webhook_secret` 只会由 TM IM **展示一次**（在启用 WEBHOOK 时或显式轮换时）。
> 不要依赖通过 API 重新读取它。

---

## 桥接工作原理

默认情况下，插件 **通过 WebSocket 长连接接收** TM IM 的入站消息（`ws.enabled: true`）：

1. 启动时连接到 `ws(s)://<host>/ws`，发送首帧 `CMD_AUTH`（携带 Agent api_key）。
2. 认证成功（`CMD_AUTH_OK`）后，服务端把新消息以 `CMD_PUSH` 帧推送到套接字，插件将其
   送入对应的 Harness 会话（`tmim:<convId>`）。
3. 监听 `session/event` 的 `assistant/message` 事件，并把最终文本回复通过 REST
   `POST /v1/conversations/{id}/messages` 发回会话。
4. 心跳（`CMD_PING`/`CMD_PONG`）保持连接；断开时会指数退避重连。

> 如果你更想用 **webhook** 投递（需要公网 HTTPS endpoint）：设 `ws.enabled: false`、
> `webhook.enabled: true` 并配置 `webhook.secret`。建议同时只启用一种入站模式。

使用相同的会话 id 可以做到重启后恢复，因此会话上下文在重启后仍然保留。

## 智能体工具与 Agent preset

TM IM 会话对应的 Harness 智能体通过 `agents.create`/`resume` 创建。**桌面版 / web
profile 把所有工具插件（bash、fs、web 等）都放在 agent preset 后面**，只有挂载了
preset 的智能体才有执行工具。插件会自动解析并挂载宿主默认 preset（见 `agentPreset`
配置）；因此在不额外配置的情况下，TM IM 智能体就能使用宿主的完整工具集。

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
摘要不匹配、过期/重放的时间戳、格式错误的头、原始请求体敏感度）。在插件目录中：

```sh
pnpm test
```

> 本包自带 `vitest.config.ts`，因为它作为独立包运行测试（无需仓库路径别名）。

## 安全注意事项

- 永远不要记录（log）webhook secret 或 api key。
- webhook 处理器使用**原始请求体字节**进行校验——不要重新序列化 JSON。
- 生产环境必须使用 HTTPS 且公网可达的 `endpoint_url`。

## 许可证

MIT
