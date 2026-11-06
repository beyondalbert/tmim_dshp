/**
 * Minimal TM IM REST client (user-end `/v1`) for a Harness agent.
 *
 * Implements the endpoints a connector needs:
 *   - auth (login / refresh / agent takeover api key)
 *   - direct conversation get-or-create
 *   - group conversation create
 *   - list conversations
 *   - send a text message (with idempotent client_msg_id)
 *   - incremental pull (since_seq) and cursor pull
 *   - agent takeover configuration (auth + status + enable/disable WEBHOOK)
 *
 * All requests expect the TM IM unified envelope:
 *   { "code": 0, "message": "ok", "data": {...} }
 * where a non-zero `code` is a business error returned over HTTP 200.
 */

export interface TmimConfig {
  /** Base URL, e.g. `https://tmim.example.com`. Do NOT append `/v1`. */
  baseUrl: string
  /** Authentication: either an Agent takeover api_key (`Bearer`) ... */
  token?: string
  /** ... or credentials used to log in and obtain a JWT. */
  username?: string
  password?: string
  /** Stable device id reported via `X-TM-Device-Id`. */
  deviceId?: string
  /** Custom fetch; defaults to global fetch. */
  fetch?: typeof fetch
  /** Timeout for each HTTP request, ms. */
  timeoutMs?: number
}

interface TmimEnvelope<T> {
  code: number
  message: string
  data: T | null
}

export class TmimError extends Error {
  constructor(
    /** Business code from the envelope. 0 means transport-level success. */
    public readonly code: number,
    message: string,
    public readonly httpStatus?: number,
    public readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'TmimError'
  }
}

export class TmimClient {
  private token: string | undefined
  private fetchImpl: typeof fetch
  private timeoutMs: number

  constructor(private readonly config: TmimConfig) {
    this.token = config.token
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = config.timeoutMs ?? 15_000
  }

  /** Current bearer token (may be a JWT or an Agent api_key). */
  get authToken(): string | undefined {
    return this.token
  }

  // ---- low level ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = `${this.config.baseUrl}/v1${path}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    if (this.config.deviceId) headers['X-TM-Device-Id'] = this.config.deviceId
    if (opts.auth !== false && this.token) headers['Authorization'] = `Bearer ${this.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      let envelope: TmimEnvelope<T> | undefined
      let text = ''
      try {
        text = await res.text()
        envelope = JSON.parse(text) as TmimEnvelope<T>
      } catch {
        envelope = undefined
      }

      if (res.status === 401 || res.status === 403) {
        throw new TmimError(res.status, `tmim auth failed (HTTP ${res.status})`, res.status, text)
      }
      if (!res.ok && !envelope) {
        throw new TmimError(0, `tmim HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text)
      }
      if (envelope && envelope.code !== 0) {
        throw new TmimError(envelope.code, envelope.message ?? `tmim error ${envelope.code}`, res.status, envelope)
      }
      return envelope?.data ?? (undefined as T)
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- auth ----

  /** Login with handle/password; stores the returned JWT. */
  async login(handle: string, password: string): Promise<{ token: string; refreshToken: string }> {
    const data = await this.request<{
      token: string
      refresh_token: string
      actor: unknown
    }>('POST', '/auth/login', { handle, password }, { auth: false })
    this.token = data.token
    return { token: data.token, refreshToken: data.refresh_token }
  }

  /** Exchange a refresh token for a new access token (refresh_token is one-time). */
  async refresh(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
    const data = await this.request<{ token: string; refresh_token: string }>(
      'POST',
      '/auth/refresh',
      { refresh_token: refreshToken },
      { auth: false },
    )
    this.token = data.token
    return { token: data.token, refreshToken: data.refresh_token }
  }

  /** Set an explicit bearer token (e.g. an Agent takeover api_key). */
  setToken(token: string): this {
    this.token = token
    return this
  }

  // ---- agent takeover ----

  /**
   * Configure Agent Takeover.
   * doc: POST /v1/me/agent-takeover
   * Returns the issued webhook_secret ONLY when the merged push mode is
   * WEBHOOK and no secret existed yet (shown exactly once).
   */
  async configureAgentTakeover(args: {
    pushMode: 1 | 2 | 3 // 1=WEBHOOK, 2=LONG_POLL, 3=PULL
    endpointUrl?: string
    capabilities?: string[]
    modelInfo?: string
    rateLimit?: number
  }): Promise<{ webhookSecret?: string }> {
    const body: Record<string, unknown> = { push_mode: args.pushMode }
    if (args.endpointUrl !== undefined) body.endpoint_url = args.endpointUrl
    if (args.capabilities !== undefined) body.capabilities = args.capabilities
    if (args.modelInfo !== undefined) body.model_info = args.modelInfo
    if (args.rateLimit !== undefined) body.rate_limit = args.rateLimit
    return this.request<{ webhookSecret?: string }>('POST', '/me/agent-takeover', body)
  }

  /** Rotate the webhook secret; returns the new plaintext exactly once. */
  async rotateWebhookSecret(): Promise<{ webhookSecret: string }> {
    return this.request<{ webhookSecret: string }>(
      'POST',
      '/me/agent-takeover/rotate-webhook-secret',
    )
  }

  /** Disable Agent Takeover entirely. */
  async disableAgentTakeover(): Promise<void> {
    await this.request<null>('DELETE', '/me/agent-takeover')
  }

  /** Read current takeover config (never includes secrets). */
  async getAgentTakeoverStatus(): Promise<{
    actorId: number
    enabled: boolean
    pushMode: number
    endpointUrl?: string
    hasApiKey: boolean
    hasWebhookSecret: boolean
  }> {
    const d = await this.request<{
      actor_id: number
      enabled: boolean
      push_mode: number
      endpoint_url?: string
      has_api_key: boolean
      has_webhook_secret: boolean
    }>('GET', '/me/agent-takeover')
    return {
      actorId: d.actor_id,
      enabled: d.enabled,
      pushMode: d.push_mode,
      ...(d.endpoint_url === undefined ? {} : { endpointUrl: d.endpoint_url }),
      hasApiKey: d.has_api_key,
      hasWebhookSecret: d.has_webhook_secret,
    }
  }

  // ---- conversations ----

  /** Get or create a direct (1:1) conversation with a peer. */
  async getOrCreateDirectConversation(peer: string): Promise<{
    convId: number
    convType: number
    peer: { actor_id: number; handle: string; display_name: string; online: boolean }
    created: boolean
    lastSeq: number
  }> {
    const d = await this.request<{
      conv_id: number
      conv_type: number
      peer: { actor_id: number; handle: string; display_name: string; online: boolean }
      created: boolean
      last_seq: number
    }>('POST', '/conversations/direct', { peer })
    return {
      convId: d.conv_id,
      convType: d.conv_type,
      peer: d.peer,
      created: d.created,
      lastSeq: d.last_seq,
    }
  }

  /** Create a group conversation. `members` excludes the caller. */
  async createGroupConversation(title: string, members: string[]): Promise<{ convId: number }> {
    const d = await this.request<{ conv_id: number }>('POST', '/conversations/group', { title, members })
    return { convId: d.conv_id }
  }

  /** List the caller's conversations (cursor paginated). */
  async listConversations(limit = 50, cursor?: string): Promise<{
    items: Array<{ conv_id: number; conv_type: number; title: string | null; last_seq: number }>
    nextCursor: string | null
  }> {
    const q = new URLSearchParams({ limit: String(limit) })
    if (cursor) q.set('cursor', cursor)
    const d = await this.request<{ items: Array<{ conv_id: number } & Record<string, unknown>>; next_cursor: string | null }>('GET', `/conversations?${q}`)
    return { items: d.items as any, nextCursor: d.next_cursor }
  }

  // ---- messages ----

  /**
   * Send a text message. `clientMsgId` is the idempotency key; re-sending the
   * same key returns the identical original message (no duplicate).
   */
  async sendText(convId: number | string, text: string, clientMsgId: string, replyTo?: number): Promise<{
    messageId: number
    convId: number
    seq: number
    clientMsgId: string
    senderId: number
    createdAt: string
  }> {
    const d = await this.request<{
      message_id: number
      conv_id: number
      seq: number
      client_msg_id: string
      sender_id: number
      created_at: string
    }>('POST', `/conversations/${convId}/messages`, {
      msg_type: 'TEXT',
      client_msg_id: clientMsgId,
      content: { text },
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    })
    return {
      messageId: d.message_id,
      convId: d.conv_id,
      seq: d.seq,
      clientMsgId: d.client_msg_id,
      senderId: d.sender_id,
      createdAt: d.created_at,
    }
  }

  /** Incremental pull: messages with seq > sinceSeq, ascending. */
  async pullMessagesSince(convId: number, sinceSeq: number, limit = 200): Promise<Array<{
    message_id: number
    conv_id: number
    seq: number
    sender_id: number
    msg_type: string
    content: { text?: string }
    created_at: string
  }>> {
    const q = new URLSearchParams({ since_seq: String(sinceSeq), limit: String(limit) })
    const d = await this.request<{ items: Array<any> }>('GET', `/conversations/${convId}/messages?${q}`)
    return d.items ?? []
  }

  /** Cursor pull: newest-first history page. */
  async pullConversationHistory(convId: number, cursor?: string, limit = 50): Promise<{
    items: Array<Record<string, unknown>>
    nextCursor: string | null
    hasMore: boolean
  }> {
    const q = new URLSearchParams({ limit: String(limit) })
    if (cursor) q.set('cursor', cursor)
    const d = await this.request<{
      items: Array<Record<string, unknown>>
      next_cursor: string | null
      has_more: boolean
    }>('GET', `/conversations/${convId}/messages?${q}`)
    return { items: d.items ?? [], nextCursor: d.next_cursor, hasMore: d.has_more }
  }
}
