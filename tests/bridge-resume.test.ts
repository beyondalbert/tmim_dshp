import { describe, expect, it, vi } from 'vitest'
import { TmimBridge } from '../src/bridge.ts'

class SessionAlreadyExistsError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SessionAlreadyExistsError'
  }
}

function makeCtx(behavior: { get?: any; createError?: Error; resumeReject?: Error; resumeReturns?: any } = {}) {
  const followup = vi.fn()
  const agents = {
    get: behavior.get ?? (() => undefined),
    create: vi.fn(async () => {
      if (behavior.createError) throw behavior.createError
      return { agent: { followup } }
    }),
    resume: vi.fn(async () => {
      if (behavior.resumeReject) throw behavior.resumeReject
      return behavior.resumeReturns ?? { agent: { followup } }
    }),
  }
  const ctx: any = {
    agents,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(() => () => {}),
  }
  return { ctx, agents, followup }
}

describe('TmimBridge ingestMessage crash-safety', () => {
  it('falls back to resume when create throws SessionAlreadyExists', async () => {
    const { ctx, agents, followup } = makeCtx({
      createError: new SessionAlreadyExistsError('session "tmim:X" already exists'),
    })
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentOptions: { provider: 'p', model: 'm' },
      cwd: process.cwd(),
    })
    const result = await bridge.ingestMessage({ convId: 123, senderId: 2, text: 'hi' })
    expect(result.sessionId).toBe('tmim:123')
    expect(agents.resume).toHaveBeenCalledOnce()
    expect(agents.resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'tmim:123' }),
    )
    expect(followup).toHaveBeenCalledOnce()
  })

  it('does not throw when create fails for an unrelated reason', async () => {
    const { ctx, agents } = makeCtx({
      createError: new Error('some other failure'),
    })
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentOptions: { provider: 'p', model: 'm' },
      cwd: process.cwd(),
    })
    // Must NOT reject — the async path is fire-and-forget, an escape here would crash the host.
    const result = await bridge.ingestMessage({ convId: 1, senderId: 2, text: 'hi' })
    expect(result.sessionId).toBe('tmim:1')
    expect(agents.resume).not.toHaveBeenCalled()
  })

  it('does not throw when resume also fails', async () => {
    const { ctx, agents } = makeCtx({
      createError: new SessionAlreadyExistsError('already exists'),
      resumeReject: new Error('resume exploded'),
    })
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentOptions: { provider: 'p', model: 'm' },
    })
    const result = await bridge.ingestMessage({ convId: 2, senderId: 2, text: 'hi' })
    expect(result.sessionId).toBe('tmim:2')
    expect(agents.resume).toHaveBeenCalledOnce()
  })
})
