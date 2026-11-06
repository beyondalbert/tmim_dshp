/**
 * TM IM realtime transport via WebSocket (binary protobuf frames).
 *
 * Implements the byte-level protocol from the TM IM integration doc:
 *   - a WS binary message == one complete Frame (no length prefix)
 *   - frame: { cmd(varint=1), req_id(varint=2), payload(bytes=3) }
 *   - first frame must be CMD_AUTH (AuthRequest) with the Agent api_key
 *   - server pushes inbound messages as CMD_PUSH (PushMessage)
 *   - keepalive via CMD_PING / CMD_PONG
 *   - all outbound "write" actions still go over REST; the WS only receives.
 *
 * The wire encoding is a tiny self-contained protobuf codec (only the fields
 * we need), so no external dependency is required.
 */

export const CMD = {
  AUTH: 1,
  AUTH_OK: 2,
  PING: 3,
  PONG: 4,
  PUSH: 12,
  KICK: 20,
  ERROR: 21,
} as const

const MSG_TYPE_TEXT = 1

export interface InboundMessage {
  messageId: string
  /** Conversation id. This is a snowflake id > Number.MAX_SAFE_INTEGER, so it is a string. */
  convId: string
  seq: number
  senderId: string
  msgType: number
  contentJson: string
  replyTo: string
  createdAtMs: string
}

export interface TmimWsOptions {
  /** WebSocket URL, e.g. `ws://tmim.stkg.ltd/ws`. */
  url: string
  /** Agent takeover api_key (AUTH token). */
  token: string
  /** Reported client version (optional, sent on AUTH). */
  clientVersion?: string
  /** Reported device id (optional, sent on AUTH). */
  deviceId?: string
  /** Heartbeat interval in ms. */
  heartbeatMs?: number
  /** Backoff (ms) for the first reconnect attempt; doubles up to a cap. */
  minReconnectMs?: number
  maxReconnectMs?: number
  /** How a decoded inbound PUSH message is delivered. */
  onMessage: (msg: InboundMessage) => void
  /** State changes for logging. */
  onState?: (state: string, detail?: string) => void
  /** Invoked once authentication succeeds (after AUTH_OK). */
  onAuthenticated?: (info: { actorId: string; handle?: string }) => void
}

// ---------------------------------------------------------------------------
// Protobuf wire primitives
// ---------------------------------------------------------------------------

type Uint8 = Uint8Array

/** Read a varint; returns [value, nextIndex]. Handles up to 64-bit as BigInt. */
function readVarint(buf: Uint8, start: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let i = start
  for (;;) {
    const b = buf[i]
    if (b === undefined) break
    i += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [result, i]
}

/** Read a length-delimited field; returns [subBytes, nextIndex]. */
function readBytes(buf: Uint8, start: number): [Uint8, number] {
  const [len, after] = readVarint(buf, start)
  const n = Number(len)
  return [buf.slice(after, after + n), after + n]
}

// ---------------------------------------------------------------------------
// Frame / message decoding
// ---------------------------------------------------------------------------

export interface RawFrame {
  cmd: number
  reqId: number
  payload: Uint8
}

export function decodeFrame(buf: Uint8): RawFrame {
  const frame: RawFrame = { cmd: 0, reqId: 0, payload: new Uint8Array(0) }
  let i = 0
  while (i < buf.length) {
    const [tag, t2] = readVarint(buf, i)
    i = t2
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [bytes, b2] = readBytes(buf, i)
      i = b2
      if (field === 3) frame.payload = bytes
    } else if (wire === 0) {
      const [v, v2] = readVarint(buf, i)
      i = v2
      if (field === 1) frame.cmd = Number(v)
      else if (field === 2) frame.reqId = Number(v)
    }
  }
  return frame
}

export function decodeMessage(body: Uint8): {
  messageId: string
  convId: string
  seq: number
  senderId: string
  msgType: number
  contentJson: string
  replyTo: string
  createdAtMs: string
} {
  const out = {
    messageId: '0',
    convId: '0',
    seq: 0,
    senderId: '0',
    msgType: 0,
    contentJson: '',
    replyTo: '0',
    createdAtMs: '0',
  }
  let i = 0
  while (i < body.length) {
    const [tag, t2] = readVarint(body, i)
    i = t2
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 2) {
      const [bytes, b2] = readBytes(body, i)
      i = b2
      if (field === 6) out.contentJson = new TextDecoder().decode(bytes)
    } else if (wire === 0) {
      const [v, v2] = readVarint(body, i)
      i = v2
      switch (field) {
        case 1:
          out.messageId = v.toString()
          break
        case 2:
          out.convId = v.toString()
          break
        case 3:
          out.seq = Number(v)
          break
        case 4:
          out.senderId = v.toString()
          break
        case 5:
          out.msgType = Number(v)
          break
        case 7:
          out.replyTo = v.toString()
          break
        case 8:
          out.createdAtMs = v.toString()
          break
        default:
          break
      }
    }
  }
  return out
}

export function decodePushMessage(payload: Uint8): InboundMessage {
  let inner: Uint8 | null = null
  let i = 0
  while (i < payload.length) {
    const [tag, t2] = readVarint(payload, i)
    i = t2
    const field = Number(tag >> 3n)
    if ((tag & 7n) === 2n) {
      const [bytes, b2] = readBytes(payload, i)
      i = b2
      if (field === 1) inner = bytes
    } else if ((tag & 7n) === 0n) {
      const [, v2] = readVarint(payload, i)
      i = v2
    }
  }
  if (!inner) throw new Error('PushMessage missing message field')
  return decodeMessage(inner)
}

export function decodeAuthResponse(body: Uint8): { actorId: string; handle: string } {
  let actorId = '0'
  let handle = ''
  let i = 0
  while (i < body.length) {
    const [tag, t2] = readVarint(body, i)
    i = t2
    const field = Number(tag >> 3n)
    if ((tag & 7n) === 2n) {
      const [bytes, b2] = readBytes(body, i)
      i = b2
      if (field === 2) handle = new TextDecoder().decode(bytes)
    } else if ((tag & 7n) === 0n) {
      const [v, v2] = readVarint(body, i)
      i = v2
      if (field === 1) actorId = v.toString()
    }
  }
  return { actorId, handle }
}

export function parseAuthResponse(body: Uint8): { actorId: string; handle: string } {
  return decodeAuthResponse(body)
}

// Keep the public API names used elsewhere.
export function parseInbound(buf: Uint8): RawFrame {
  return decodeFrame(buf)
}
export function parsePush(payload: Uint8): InboundMessage {
  return decodePushMessage(payload)
}

// ---------------------------------------------------------------------------
// Field encoders (client -> server)
// ---------------------------------------------------------------------------

function varintBytes(value: number): number[] {
  const out: number[] = []
  let v = value >>> 0
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

function stringField(field: number, value: string): number[] {
  const bytes = new TextEncoder().encode(value)
  const out: number[] = []
  out.push(...varintBytes((field << 3) | 2))
  out.push(...varintBytes(bytes.length))
  out.push(...Array.from(bytes))
  return out
}

function uintField(field: number, value: number): number[] {
  return [...varintBytes((field << 3) | 0), ...varintBytes(value >>> 0)]
}

function authPayload(token: string, clientVersion: string, deviceId: string): Uint8 {
  return new Uint8Array([
    ...stringField(1, token),
    ...stringField(2, clientVersion),
    ...stringField(3, deviceId),
  ])
}

function frame(cmd: number, reqId: number, payloadParam: Uint8 = new Uint8Array(0)): Uint8 {
  const body: number[] = [
    ...uintField(1, cmd),
    ...uintField(2, reqId),
    ...varintBytes((3 << 3) | 2),
    ...varintBytes(payloadParam.length),
    ...Array.from(payloadParam),
  ]
  return new Uint8Array(body)
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

export class TmimWsClient {
  private ws: WebSocket | null = null
  private reqId = 1
  private closed = false
  private stopping = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: TmimWsOptions) {}

  start(): void {
    if (!this.stopping && this.ws) return
    this.closed = false
    this.open()
  }

  stop(): void {
    this.stopping = true
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
    if (this.ws) {
      try {
        this.ws.close(1000, 'plugin stop')
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private open(): void {
    if (this.closed || this.stopping) return
    this.emitState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
      ws.binaryType = 'arraybuffer'
    } catch (err) {
      this.onTransportError(String(err))
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (ws !== this.ws) return
      this.reconnectAttempt = 0
      this.emitState('open')
      try {
        const payload = authPayload(
          this.opts.token,
          this.opts.clientVersion ?? 'dsh-1.0.0',
          this.opts.deviceId ?? 'dsh-agent',
        )
        ws.send(frame(CMD.AUTH, this.reqId++, payload))
      } catch (err) {
        this.emitState('error', `auth send failed: ${String(err)}`)
      }
    }
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return
      this.handleMessage(ev.data)
    }
    ws.onerror = () => {
      if (ws !== this.ws) return
      this.onTransportError('websocket error')
    }
    ws.onclose = (ev) => {
      if (ws !== this.ws) return
      this.ws = null
      this.teardownPing()
      this.emitState('closed', `code=${ev.code} reason=${ev.reason || ''}`)
      if (!this.closed && !this.stopping) this.scheduleReconnect()
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') return
    const buf = new Uint8Array(data as ArrayBuffer)
    let parsed: RawFrame
    try {
      parsed = decodeFrame(buf)
    } catch (err) {
      this.emitState('error', `frame parse failed: ${String(err)}`)
      return
    }
    switch (parsed.cmd) {
      case CMD.AUTH_OK:
        try {
          const info = decodeAuthResponse(parsed.payload)
          this.opts.onAuthenticated?.(info)
        } catch {
          /* ignore */
        }
        this.emitState('authenticated')
        this.startPing()
        break
      case CMD.PING:
        this.sendPong(parsed.reqId)
        break
      case CMD.PONG:
        break
      case CMD.PUSH:
        try {
          const msg = decodePushMessage(parsed.payload)
          if (msg.msgType !== MSG_TYPE_TEXT) break
          this.opts.onMessage(msg)
        } catch (err) {
          this.emitState('error', `push parse failed: ${String(err)}`)
        }
        break
      case CMD.ERROR:
        this.emitState('error', `server error (req ${parsed.reqId})`)
        break
      case CMD.KICK:
        this.emitState('kicked')
        break
      default:
        break
    }
  }

  private startPing(): void {
    this.teardownPing()
    const ws = this.ws
    if (!ws) return
    const ms = this.opts.heartbeatMs ?? 25_000
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
      try {
        this.ws.send(frame(CMD.PING, this.reqId++))
      } catch (err) {
        this.onTransportError(`ping failed: ${String(err)}`)
      }
    }, ms)
  }

  private sendPong(reqId: number): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(frame(CMD.PONG, reqId))
    } catch {
      /* ignore */
    }
  }

  private teardownPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private onTransportError(detail: string): void {
    this.emitState('error', detail)
    const ws = this.ws
    if (ws) {
      try {
        ws.close(4000, 'transport error')
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.stopping) return
    const min = this.opts.minReconnectMs ?? 2000
    const max = this.opts.maxReconnectMs ?? 30_000
    const backoff = Math.min(max, min * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.emitState('reconnecting', `in ${backoff}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed && !this.stopping) this.open()
    }, backoff)
  }

  private emitState(state: string, detail?: string): void {
    try {
      this.opts.onState?.(state, detail)
    } catch {
      /* ignore */
    }
  }
}
