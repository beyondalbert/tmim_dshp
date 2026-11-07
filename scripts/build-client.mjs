import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const entry = resolve(packageRoot, 'src', 'client', 'index.ts')
const outputPath = resolve(packageRoot, 'dist', 'client.js')
const loaderId = process.env.TMIM_CLIENT_ID ?? '@tmim/dsh-plugin-tmim'

/**
 * Build the browser client bundle for the DSH web client kernel. The kernel
 * loads bundles through `window.__ModuleLoader__.load({ id, factory })`; the
 * factory's module exports are read back when the plugin is materialized.
 * React and the DSH client packages are provided by the host module loader and
 * must NOT be bundled here (they appear as `require(dep)` against the loader).
 */
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
  // DSH client packages and react are host-provided through the module loader.
  external: [
    'react',
    'react-dom',
    '@deepseek-ai/*',
  ],
})

const bundled = result.outputFiles?.[0]?.text
if (!bundled) throw new Error('esbuild did not produce a client bundle')

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped, 'utf8')
console.log(`Wrote ${outputPath}`)
