import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Settings namespace the Host serves for this plugin row (`id: tmim`). */
export const TMIM_NS = 'tmim'

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

/**
 * One field's staged draft. A text/secret draft holds a raw string; a number
 * draft holds `{ text, valid }`; a boolean holds a direct value.
 */
type Draft =
  | { kind: 'text'; text: string }
  | { kind: 'secret'; text: string }
  | { kind: 'number'; text: string; valid: boolean }
  | { kind: 'bool'; value: boolean }

/** Dotted-path helper. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

/**
 * The staged TM IM settings card. Subscribes to the shared `tmim` namespace
 * (writes land in `cordis.patch.yml` and hot-reload the plugin via Host
 * `configEditor`), keeps a local draft map, and writes all edits in one
 * revision-fenced mutate.
 */
export class TmimCardController {
  private readonly form: ConfigForm<Record<string, unknown>>
  private readonly store: SnapshotStore<TmimCardView>
  private readonly drafts = new Map<string, Draft>()
  private saving = false
  private failed = false
  private validError: string | undefined
  private readonly unsubscribe: () => void

  constructor(private readonly ctx: ClientContext) {
    this.form = ctx.configForms.get(TMIM_NS)
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = this.form.subscribe(() => { this.store.set(this.project()) })
  }

  private resolved(): Record<string, unknown> | undefined {
    return this.form.getSnapshot().value as Record<string, unknown> | undefined
  }

  private value(): TmimConfig | undefined {
    const raw = this.resolved()
    if (!raw) return undefined
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
      credential: raw.credential as TmimConfig['credential'],
      agent: {
        provider: str((raw.agent as any)?.provider),
        model: str((raw.agent as any)?.model),
      },
    }
  }

  private invalid(): boolean {
    return [...this.drafts.values()].some(d => d.kind === 'number' && !d.valid)
  }

  private project(): TmimCardView {
    const snap = this.form.getSnapshot()
    const available = snap.status === 'ready'
    return {
      status: snap.status,
      value: this.value(),
      writable: available && snap.writable,
      dirty: this.drafts.size > 0,
      saving: this.saving,
      failed: this.failed,
      invalid: this.invalid(),
      available,
      revision: snap.revision,
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

  /** Atomic save of every staged edit, fenced by the revision the drafts started from. */
  async save(): Promise<void> {
    if (this.saving || this.invalid()) return
    this.saving = true
    this.failed = false
    this.store.set(this.project())
    const ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> = []
    for (const [path, d] of this.drafts) {
      const parts = path.split('.')
      if (d.kind === 'text' || d.kind === 'secret') {
        const trimmed = d.text.trim()
        if (trimmed === '') ops.push({ op: 'unset', path: parts })
        else ops.push({ op: 'set', path: parts, value: d.kind === 'text' ? trimmed : d.text })
      } else if (d.kind === 'number') {
        const trimmed = d.text.trim()
        if (trimmed === '') ops.push({ op: 'unset', path: parts })
        else ops.push({ op: 'set', path: parts, value: Number(trimmed) })
      } else {
        ops.push({ op: 'set', path: parts, value: d.value })
      }
    }
    try {
      const accepted = await this.form.mutate(ops, this.form.getSnapshot().revision)
      if (accepted) this.drafts.clear()
      else this.failed = true
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

  /** Release the form subscription. */
  dispose(): void { this.unsubscribe() }
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
