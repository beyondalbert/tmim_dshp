import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { persistConfigPatch } from '../src/patch-persist.ts'

async function tmpPatch(initial: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmim-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  await writeFile(file, initial, 'utf8')
  return file
}

describe('persistConfigPatch', () => {
  it('updates an existing tmim entry and preserves other comments/entries', async () => {
    const file = await tmpPatch(`# header
- id: other
  name: '@other/x'
  config:
    foo: 1
- id: tmim
  name: '@tmim/dsh-plugin-tmim'
  config:
    baseUrl: 'http://old'
`)
    const ok = await persistConfigPatch({ baseUrl: 'http://new', tools: true }, { path: file })
    expect(ok).toBe(true)
    const out = await readFile(file, 'utf8')
    expect(out).toContain("baseUrl: http://new")
    expect(out).toContain("tools: true")
    // Old value gone, other entry intact.
    expect(out).not.toContain('http://old')
    expect(out).toContain("name: '@other/x'")
    expect(out).toContain('foo: 1')
    expect(out).toContain('# header')
  })

  it('appends a tmim entry when absent', async () => {
    const file = await tmpPatch(`- id: other
  name: '@other/x'
`)
    const ok = await persistConfigPatch({ baseUrl: 'http://x' }, { path: file })
    expect(ok).toBe(true)
    const out = await readFile(file, 'utf8')
    expect(out).toContain('- id: tmim')
    expect(out).toContain('baseUrl: http://x')
  })

  it('no-ops (returns false) on a missing file without create', async () => {
    const file = join(tmpdir(), `none-${Date.now()}-cordis.patch.yml`)
    const ok = await persistConfigPatch({ baseUrl: 'http://x' }, { path: file })
    expect(ok).toBe(false)
  })
})
