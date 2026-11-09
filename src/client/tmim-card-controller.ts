import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The resolved config the page reads and edits (booleans coerced). */
export interface TmimConfig {
  baseUrl: string
  deviceId: string
  enableAgentTakeover: boolean
  agentPreset: string
  cwd: string
  tools: boolean
  ws: { enabled: boolean; url: string; heartbeatMs: number }
  webhook: { enabled: boolean; path: string; secret: string; maxSkewSeconds: number }
  credential?: { kind: 'apikey' | 'password'; token?: string; username?: string; password?: string }
  agent: { provider: string; model: string }
}

/** One field's staged draft. */
type Draft =
  | { kind: 'text'; text: string }
  | { kind: 'secret'; text: string }
  | { kind: 'number'; text: string; valid: boolean }
  | { kind: 'bool'; value: boolean }

/** Dotted-path helper. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

/** TM IM management RPC endpoint (mirrors the Host-side settings-rpc.ts). */
export const TMIM_RPC_CHANNEL = '/config'

/** Host-provided Connection service (from @deepseek-ai/dsh-client-connection). */
export interface TmimClientConnection {
  rpc: {
    call(endpointBase: string, endpoint: string, message: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

/**
 * The staged TM IM settings card. Instead of `configForms` (which only works when
 * the Host serves a `tmim` settings namespace — absent for cordis.patch-installed
 * plugins), it reads/writes config over the plugin's own Host management RPC fault.
 * An initial `get` loads the running config; `save` sends the merged payload back.
 */
export class TmimCardController {
  private readonly store: SnapshotStore<TmimCardView>
  private readonly drafts = new Map<string, Draft>()
  private saving = false
  private failed = false
  private validError: string | undefined
  private loaded = false
  private readonly connection: TmimClientConnection | undefined

  constructor(private readonly ctx: ClientContext) {
    this.store = createSnapshotStore(this.project('loading'))
    this.connection = (ctx as any).connection as TmimClientConnection | undefined
    void this.load()
  }

  private async load(): Promise<void> {
    if (!this.connection) {
      this.store.set(this.project('unavailable'))
      return
    }
    try {
      const result = await callRpc(this.connection, 'get', null)
      if (!result.ok) throw new Error(result.error?.message ?? 'RPC failed')
      this.configure(result.value as Record<string, unknown> | undefined)
    } catch {
      this.store.set(this.project('unavailable'))
    }
  }

  /** Store the resolved config and re-project from it. */
  private configure(raw: Record<string, unknown> | undefined): void {
    this.raw = raw
    this.loaded = true
    this.store.set(this.project('ready'))
    // Mark text fields dirty=null so the page renders the loaded values exactly once.
  }

  private raw: Record<string, unknown> | undefined

  private value(): TmimConfig | undefined {
    const raw = this.raw
    if (!raw) return undefined
    const credential = raw.credential
    const kind = (credential as any)?.kind === 'password' ? 'password' : 'apikey'
    return {
      baseUrl: str(raw.baseUrl),
      deviceId: str(raw.deviceId),
      enableAgentTakeover: !!raw.enableAgentTakeover,
      agentPreset: str(raw.agentPreset),
      cwd: str(raw.cwd),
      tools: raw.tools !== false,
      ws: {
        enabled: !!(raw.ws as any)?.enabled,
        url: str((raw.ws as any)?.url),
        heartbeatMs: num((raw.ws as any)?.heartbeatMs, 25000),
      },
      webhook: {
        enabled: !!(raw.webhook as any)?.enabled,
        path: str((raw.webhook as any)?.path),
        secret: str((raw.webhook as any)?.secret),
        maxSkewSeconds: num((raw.webhook as any)?.maxSkewSeconds, 300),
      },
      credential:
        kind === 'password'
          ? {
              kind: 'password',
              username: str((credential as any)?.username),
              password: str((credential as any)?.password),
            }
          : { kind: 'apikey', token: str((credential as any)?.token) },
      agent: {
        provider: str((raw.agent as any)?.provider),
        model: str((raw.agent as any)?.model),
      },
    }
  }

  private invalid(): boolean {
    return [...this.drafts.values()].some(d => d.kind === 'number' && !d.valid)
  }

  private project(status: 'loading' | 'ready' | 'unavailable' = this.loaded ? 'ready' : this.connection ? 'loading' : 'unavailable'): TmimCardView {
    const val = this.value()
    const available = status === 'ready'
    return {
      status,
      value: val,
      writable: available,
      dirty: this.drafts.size > 0,
      saving: this.saving,
      failed: this.failed,
      invalid: this.invalid(),
      available,
      revision: undefined,
    }
  }

  /** Current rendered text of a field, from a draft or the resolved value. */
  textOf(path: string): string {
    const d = this.drafts.get(path)
    if (d) return d.kind === 'text' || d.kind === 'secret' ? d.text : d.kind === 'number' ? d.text : String(d.value)
    const v = this.value()
    const cell = v === undefined ? undefined : getPath(v, path)
    return cell == null ? '' : String(cell)
  }

  /** Edit a free-text field. Empty clears it (inherits composed default). */
  editText(path: string, text: string): void {
    this.drafts.set(path, { kind: 'text', text })
    this.store.set(this.project())
  }

  /** Edit a write-only secret field. */
  editSecret(path: string, text: string): void {
    this.drafts.set(path, { kind: 'secret', text })
    this.store.set(this.project())
  }

  /** Edit a numeric field; an empty draft or non-finite text blocks the save. */
  editNumber(path: string, text: string): void {
    const trimmed = text.trim()
    const valid = trimmed === '' || Number.isFinite(Number(trimmed))
    this.drafts.set(path, { kind: 'number', text: trimmed, valid })
    this.store.set(this.project())
  }

  /** Edit a boolean field. */
  editBool(path: string, value: boolean): void {
    this.drafts.set(path, { kind: 'bool', value })
    this.store.set(this.project())
  }

  /** Switch credential kind; clear the other branch's fields. */
  setCredentialKind(kind: 'apikey' | 'password'): void {
    const other = kind === 'apikey'
      ? ['credential.username', 'credential.password']
      : ['credential.token']
    for (const path of other) if (!this.drafts.has(path)) this.drafts.set(path, { kind: 'text', text: '' })
    this.drafts.set('credential.kind', { kind: 'text', text: kind })
    this.store.set(this.project())
  }

  /** Reset one field by clearing its override. */
  resetField(path: string): void {
    this.drafts.set(path, { kind: 'text', text: '' })
    this.store.set(this.project())
  }

  /** Build the merged config from the loaded value + staged drafts, then save via RPC. */
  async save(): Promise<void> {
    if (this.saving || this.invalid() || !this.connection) return
    this.saving = true
    this.failed = false
    this.store.set(this.project())
    const merged: Record<string, unknown> = JSON.parse(JSON.stringify(this.raw ?? {}))
    for (const [path, d] of this.drafts) {
      const parts = path.split('.')
      let node: any = merged
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i] as string
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
        node = node[key]
      }
      const last = parts[parts.length - 1] as string
      if (d.kind === 'text' || d.kind === 'secret') {
        const trimmed = d.text.trim()
        if (trimmed === '') delete node[last]
        else node[last] = d.kind === 'text' ? trimmed : d.text
      } else if (d.kind === 'number') {
        const trimmed = d.text.trim()
        if (trimmed === '') delete node[last]
        else node[last] = Number(trimmed)
      } else {
        node[last] = d.value
      }
    }
    try {
      const result = await callRpc(this.connection, 'set', merged)
      if (result.ok) {
        this.drafts.clear()
        this.configure(result.value as Record<string, unknown> | undefined)
      } else {
        this.failed = true
      }
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.store.set(this.project())
    }
  }

  /** The registration face the page's slot entry injects. */
  inject(): TmimCardFace {
    return {
      hooks: { tmim: this.store },
      text: this.textOf.bind(this),
      editText: this.editText.bind(this),
      editSecret: this.editSecret.bind(this),
      editNumber: this.editNumber.bind(this),
      editBool: this.editBool.bind(this),
      setCredentialKind: this.setCredentialKind.bind(this),
      resetField: this.resetField.bind(this),
      save: () => { void this.save() },
    }
  }

  dispose(): void {
    /* no-op: RPC reads are fire-and-forget; nothing to unsubscribe. */
  }
}

/** One `connection.rpc.call` against the TM IM management channel. */
async function callRpc(
  connection: TmimClientConnection,
  method: string,
  payload: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error?: { message?: string } }> {
  const endpoint = `tmim${TMIM_RPC_CHANNEL}`
  const response = await connection.rpc.call('/api', endpoint, { method, payload })
  return response as any
}

/** What a read of the card produces. */
export interface TmimCardView {
  status: 'loading' | 'ready' | 'unavailable'
  value: TmimConfig | undefined
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  invalid: boolean
  available: boolean
  revision: number | undefined
}

/** The registration-side face the page's slot entry injects. */
export interface TmimCardFace {
  hooks: { tmim: SnapshotStore<TmimCardView> }
  text: (path: string) => string
  editText: (path: string, text: string) => void
  editSecret: (path: string, text: string) => void
  editNumber: (path: string, text: string) => void
  editBool: (path: string, next: boolean) => void
  setCredentialKind: (kind: 'apikey' | 'password') => void
  resetField: (path: string) => void
  save: () => void
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown, d: number): number { return typeof v === 'number' ? v : d }
