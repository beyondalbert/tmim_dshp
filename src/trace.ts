/**
 * Minimal file-backed trace logger for the TM IM bridge.
 *
 * The host's `ctx.logger` output is not written to disk by default, which makes
 * it hard to observe what the plugin is doing in production. This writes a
 * plain-text trace directly to a file so we can follow the full pipeline
 * (WS push -> ingest -> agent -> relay) regardless of host log routing.
 *
 * File location: `<os.tmpdir()>/dsh-tmim-trace.log` (rotated on each start).
 */

import { openSync, writeSync, closeSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TRACE_FILE = join(tmpdir(), 'dsh-tmim-trace.log')

let fd: number | null = null

function ensureOpen(): void {
  if (fd === null) {
    // Truncate on each process start.
    try {
      fd = openSync(TRACE_FILE, 'a')
    } catch {
      fd = null
    }
  }
}

export function trace(...parts: unknown[]): void {
  ensureOpen()
  if (fd === null) return
  const line =
    new Date().toISOString() +
    ' ' +
    parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ')
  try {
    writeSync(fd, line + '\n')
  } catch {
    /* ignore write errors */
  }
}

export function traceFile(): string {
  return TRACE_FILE
}

export function traceClose(): void {
  if (fd !== null) {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    fd = null
  }
}
