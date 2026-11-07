/** Bilingual copy for the TM IM settings page. */
export const en = {
  title: 'TM IM',
  panel: 'TM IM',
  description: 'Bridge TM IM messages to a DeepSeek Harness agent.',
  unavailable: 'TM IM is not composed in this deployment.',
  readOnly: 'TM IM settings are read-only in this deployment.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The server did not accept the change.',
  invalidNumber: 'Not a number',
  reset: 'Reset',
  overridden: 'Overridden',
  /** Sections */
  sectionConnection: 'Connection',
  sectionCredential: 'Credential',
  sectionInbound: 'Message delivery (inbound)',
  sectionAgent: 'Agent',
  sectionAdvanced: 'Advanced',
  /** Connection fields */
  baseUrl: 'TM IM server URL',
  baseUrlHint: 'Without a /v1 suffix. Trailing slash is normalized automatically. e.g. http://tmim.stkg.ltd/',
  deviceId: 'Device id',
  deviceIdHint: "Reported as X-TM-Device-Id.",
  /** Credential */
  credentialHint: 'Optional — the plugin starts with none, but needs one to send/receive.',
  credKindApikey: 'API key',
  credKindPassword: 'Account / password',
  credToken: 'API key (Agent Takeover)',
  credTokenHint: 'sk_… long-lived key from TM IM “Agent Takeover” page.',
  credUsername: 'TM IM username',
  credPassword: 'TM IM password',
  /** WS */
  wsEnabled: 'WebSocket long-connection',
  wsEnabledHint: 'Receive inbound messages in real time via WS (recommended).',
  wsUrl: 'WebSocket URL',
  wsUrlHint: 'Blank derives ws(s)://<host>/ws from the server URL.',
  wsHeartbeat: 'Heartbeat interval (ms)',
  /** Webhook */
  webhookEnabled: 'Webhook receiver',
  webhookEnabledHint: 'Alternative realtime delivery; needs a public HTTPS endpoint.',
  webhookPath: 'Webhook path',
  webhookPathHint: 'Corresponds to TM IM endpoint_url.',
  webhookSecret: 'Webhook secret',
  webhookSecretHint: 'One-time webhook_secret issued by TM IM; required when enabled.',
  webhookMaxSkew: 'Replay clock skew (s)',
  /** Takeover */
  enableAgentTakeover: 'Enable Agent Takeover on startup',
  enableAgentTakeoverHint: 'POST the takeover config on startup (needs a credential).',
  /** Agent */
  agentProvider: 'Provider',
  agentModel: 'Model',
  agentModelHint: 'Leave blank to use the host default model route.',
  agentPreset: 'Agent preset',
  agentPresetHint: 'Blank uses the host default preset (desktop composes tools behind presets). “inert” disables preset mounting.',
  cwd: 'Working directory',
  cwdHint: 'For agents this plugin creates.',
  /** Tools */
  tools: 'Register proactive TM IM tools',
  toolsHint: 'Send messages, manage conversations, pull history.',
} as const

export const zh = {
  title: 'TM IM',
  panel: 'TM IM',
  description: '把 TM IM 消息桥接到 DeepSeek Harness 智能体。',
  unavailable: '当前部署没有装配 TM IM。',
  readOnly: '当前部署中 TM IM 设置为只读。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '服务器没有接受该修改。',
  invalidNumber: '不是数字',
  reset: '重置',
  overridden: '已覆盖',
  /** Sections */
  sectionConnection: '连接',
  sectionCredential: '凭证',
  sectionInbound: '消息接收（入站）',
  sectionAgent: '智能体',
  sectionAdvanced: '高级',
  /** Connection */
  baseUrl: 'TM IM 服务器地址',
  baseUrlHint: '不带 /v1 后缀，末尾斜杠会自动归一化。例如：http://tmim.stkg.ltd/',
  deviceId: '设备标识',
  deviceIdHint: '随请求上报（X-TM-Device-Id）。',
  /** Credential */
  credentialHint: '可选——无凭证插件也能启动，但发送/接收消息需要配置凭证。',
  credKindApikey: 'API 密钥',
  credKindPassword: '账号 / 密码',
  credToken: 'API 密钥（Agent Takeover）',
  credTokenHint: '从 TM IM 的「Agent 接管」页获取，sk_ 开头，长期有效。',
  credUsername: 'TM IM 登录账号',
  credPassword: 'TM IM 登录密码',
  /** WS */
  wsEnabled: 'WebSocket 长连接',
  wsEnabledHint: '通过 WebSocket 实时接收 TM IM 消息（推荐）。',
  wsUrl: 'WebSocket 地址',
  wsUrlHint: '留空则按服务器地址自动推导为 ws(s)://<host>/ws。',
  wsHeartbeat: '心跳间隔（毫秒）',
  /** Webhook */
  webhookEnabled: 'Webhook 接收器',
  webhookEnabledHint: '实时接收的备选方案；需要公网可达的 HTTPS 地址。',
  webhookPath: 'Webhook 路径',
  webhookPathHint: '对应 TM IM 的 endpoint_url。',
  webhookSecret: 'Webhook 密钥',
  webhookSecretHint: 'TM IM 签发的一次性 webhook_secret；启用时必填。',
  webhookMaxSkew: '防重放时钟偏移（秒）',
  /** Takeover */
  enableAgentTakeover: '启动时开启 Agent Takeover',
  enableAgentTakeoverHint: '启动时自动 POST takeover 配置（需要已配置凭证）。',
  /** Agent */
  agentProvider: '模型提供商',
  agentModel: '模型',
  agentModelHint: '留空则使用宿主默认模型路由。',
  agentPreset: 'Agent preset',
  agentPresetHint: '留空使用宿主默认 preset（桌面版把工具都放在 preset 里）；“inert” 关闭预设挂载。',
  cwd: '工作目录',
  cwdHint: '为此插件创建的智能体使用的工作目录。',
  /** Tools */
  tools: '注册主动式 TM IM 工具',
  toolsHint: '发消息、管理会话、拉取历史等。',
} as const

export type TmimLocaleKey = keyof typeof zh
