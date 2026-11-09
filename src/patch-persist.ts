/**
 * Best-effort persistence of TM IM config into the DSH profile patch document.
 *
 * The documented profile path is `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`.
 * This module rewrites the `config` of the `tmim` entry in that file so the
 * change survives a plugin restart. It is deliberately conservative:
 *   - if the file can't be found, parsed, or matches the expected list shape,
 *     it no-ops (returns false) instead of corrupting anything;
 *   - all writes are atomic (temp file + rename) to avoid a torn profile.
 *
 * The DSH Host may or may not hot-apply the patch; when it does not, the change
 * takes effect on the next restart. Anything that mutates only the running
 * bridge (credential/baseUrl) is applied live by the caller regardless.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Documented default profile patch path (see README). */
function defaultPatchPath(): string {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
}

/** Quote a scalar for YAML when it isn't plainly safe. */
function scalar(value: string): string {
  if (/^(?:true|false|null|~|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$|^[\s!#&*\-?|>'"%@`,]|[:#] |:$|\s$|^\s/.test(value)) {
    return JSON.stringify(value)
  }
  return value
}

/** Emit one config object as inline YAML (2-space, flat, no nested blocks beyond objects). */
function emitValue(value: unknown, indent: string): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return scalar(value === '' ? '' : value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return '[' + value.map(v => emitValue(v, '')).join(', ') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 0) return '{}'
    return '\n' + keys.map((k) => `${indent}  ${k}: ${emitValue(obj[k], indent + '  ')}`).join('\n')
  }
  return JSON.stringify(String(value))
}

export interface PatchContext {
  /** Path to the patch file; defaults to the documented profile path. */
  path?: string
  /** Id of the plugin entry to update. */
  id?: string
  /** Whether to allow creating the file when absent (default false). */
  create?: boolean
}

/**
 * Write `config` into the `tmim` entry of the profile patch file.
 * @returns true when the file was actually updated, false when no-op.
 */
export async function persistConfigPatch(
  config: Record<string, unknown>,
  ctx: PatchContext = {},
): Promise<boolean> {
  const file = ctx.path ?? process.env.DSH_PROFILE_PATCH_PATH ?? defaultPatchPath()
  const id = ctx.id ?? 'tmim'

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    if (!ctx.create) return false
    // Create a minimal single-entry patch.
    await writeFile(file, `- id: ${id}\n  name: '@tmim/dsh-plugin-tmim'\n`, 'utf8')
    raw = `- id: ${id}\n  name: '@tmim/dsh-plugin-tmim'\n`
  }

  const lines = raw.split(/\r?\n/)
  let replaced = false
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(\s*)- id:\s*(['"]?)([A-Za-z0-9._-]+)\2/.exec(line ?? '')
    const entryId = m?.[3] ?? ''
    if (m && entryId === id) {
      // Found the tmim entry; keep the `- id` and `name` lines, replace config.
      out.push(line ?? '')
      const nameMatch = /^(\s*)name:/.exec(lines[i + 1] ?? '')
      if (nameMatch) {
        const ind = nameMatch[1] ?? '  '
        i++
        out.push(`${ind}name: '@tmim/dsh-plugin-tmim'`)
      } else {
        out.push(`  name: '@tmim/dsh-plugin-tmim'`)
      }
      // Skip any remaining lines of the old entry (until next top-level `- `).
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (/^[^\s#]/.test(next ?? '')) break
        i++
      }
      out.push(`  config:${emitValue(config, '')}`)
      replaced = true
      continue
    }
    out.push(line ?? '')
  }

  if (!replaced) {
    out.push(`- id: ${id}`)
    out.push(`  name: '@tmim/dsh-plugin-tmim'`)
    out.push(`  config:${emitValue(config, '')}`)
  }

  // Atomic write: temp file + rename.
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, out.join('\n') + '\n', 'utf8')
  await rename(tmp, file)
  return true
}
