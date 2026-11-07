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

describe('TmimBridge agent preset mounting', () => {
  it('mounts the resolved host preset via setup for fresh agents', async () => {
    const mounted: string[] = []
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_ctx: any, id?: string) => { mounted.push(id!) }),
    }
    let capturedSetup: any
    const ctx: any = {
      get: vi.fn((key: string) => (key === 'agentPresets' ? presets : undefined)),
      agents: {
        get: () => undefined,
        create: vi.fn(async (opts: any) => {
          capturedSetup = opts.setup
          return { agent: { followup: vi.fn() } }
        }),
        resume: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(() => () => {}),
    }
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      cwd: process.cwd(),
    })
    await bridge.ingestMessage({ convId: 55, senderId: 2, text: 'hi' })

    // create must carry meta.agentPreset + a setup that mounts the preset
    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ agentPreset: 'standard' }),
    }))
    expect(capturedSetup).toBeTypeOf('function')
    // Running the setup on an agent ctx mounts the preset
    await capturedSetup({ fake: 'agentCtx' } as any)
    expect(mounted).toEqual(['standard'])
    expect(presets.resolve).toHaveBeenCalledWith(undefined)
  })

  it('passes an explicit agentPreset through and does not mount when inert', async () => {
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'x' })),
      mount: vi.fn(async () => {}),
    }
    const ctx: any = {
      get: vi.fn((key: string) => (key === 'agentPresets' ? presets : undefined)),
      agents: {
        get: () => undefined,
        create: vi.fn(async () => ({ agent: { followup: vi.fn() } })),
        resume: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(() => () => {}),
    }
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentPreset: 'minimal',
      cwd: process.cwd(),
    })
    await bridge.ingestMessage({ convId: 7, senderId: 2, text: 'hi' })
    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ agentPreset: 'minimal' }),
    }))

    // inert: no preset resolve/mount, no meta.agentPreset
    presets.resolve.mockClear()
    const bridge2 = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentPreset: 'inert',
      cwd: process.cwd(),
    })
    await bridge2.ingestMessage({ convId: 8, senderId: 2, text: 'hi' })
    expect(presets.resolve).not.toHaveBeenCalled()
    expect(ctx.agents.create).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.not.objectContaining({ agentPreset: 'minimal' }),
    }))
  })

  it('still creates the agent when preset resolution fails (no tools, but no crash)', async () => {    const presets = { resolve: vi.fn(async () => { throw new Error('boom') }), mount: vi.fn() }
    const ctx: any = {
      get: vi.fn((key: string) => (key === 'agentPresets' ? presets : undefined)),
      agents: {
        get: () => undefined,
        create: vi.fn(async () => ({ agent: { followup: vi.fn() } })),
        resume: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(() => () => {}),
    }
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentPreset: 'standard',
      cwd: process.cwd(),
    })
    const result = await bridge.ingestMessage({ convId: 9, senderId: 2, text: 'hi' })
    expect(result.sessionId).toBe('tmim:9')
    expect(ctx.agents.create).toHaveBeenCalled()
  })

  it('treats the empty-string schema default as “use host default” (forwards undefined)', async () => {
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async () => {}),
    }
    const ctx: any = {
      get: vi.fn((key: string) => (key === 'agentPresets' ? presets : undefined)),
      agents: {
        get: () => undefined,
        create: vi.fn(async () => ({ agent: { followup: vi.fn() } })),
        resume: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(() => () => {}),
    }
    const bridge = new TmimBridge(ctx, {
      getClient: () => ({} as any),
      agentPreset: '', // schema default
      cwd: process.cwd(),
    })
    await bridge.ingestMessage({ convId: 11, senderId: 2, text: 'hi' })
    // '' must be forwarded as undefined so the registry falls back to its default
    expect(presets.resolve).toHaveBeenCalledWith(undefined)
    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ agentPreset: 'standard' }),
    }))
  })
})
