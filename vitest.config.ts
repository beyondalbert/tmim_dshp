import { defineConfig } from 'vitest/config'

// Standalone config for the plugin's own unit tests.
//
// The harness monorepo root drives a workspace topology that only discovers
// tests under `packages/*/*/tests/**`, so the plugin's nested location needs a
// package-local config (see _harness copy). This standalone repo keeps the same
// self-contained config: tests only import `node:crypto` and `src/*` (no repo
// path aliases), so a minimal config is sufficient.
export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    environment: 'node',
  },
})
