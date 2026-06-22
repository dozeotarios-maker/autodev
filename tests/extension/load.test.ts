// M0 tests — written FIRST (D1), all should fail before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentRunner } from '../../src/lanes/subagent-runner.js'
import { buildExtension } from '../../src/extension/index.js'

function makeMockPi() {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerFlag: vi.fn(),
    registerShortcut: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    getThinkingLevel: vi.fn(),
    exec: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
    getFlag: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    registerMessageRenderer: vi.fn(),
  }
}

function makeMockCtx(cwd = '/tmp/test-repo') {
  return {
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd,
    mode: 'rpc' as const,
    hasUI: false,
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => false),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ''),
    sessionManager: {} as any,
    modelRegistry: {} as any,
    model: undefined,
  }
}

describe('M0: Extension scaffold', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('exports a default function (ExtensionFactory shape)', async () => {
    const mod = await import('../../src/extension/index.js')
    expect(typeof mod.default).toBe('function')
  })

  it('registers a session_start handler when called', async () => {
    const { default: autodevExtension } = await import('../../src/extension/index.js')
    const mockPi = makeMockPi()
    autodevExtension(mockPi as any)
    const sessionStartCalls = mockPi.on.mock.calls.filter((c: any[]) => c[0] === 'session_start')
    expect(sessionStartCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('logs ARMED on session_start and sets status', async () => {
    const { default: autodevExtension } = await import('../../src/extension/index.js')
    const mockPi = makeMockPi()

    autodevExtension(mockPi as any)

    const sessionStartCall = mockPi.on.mock.calls.find((c: any[]) => c[0] === 'session_start')
    expect(sessionStartCall).toBeDefined()

    const handler = sessionStartCall![1]
    const ctx = makeMockCtx()
    await handler({ type: 'session_start', reason: 'startup' }, ctx)

    // Transparency port's log() is called instead of console.log (finding 8 fix).
    // Verify status is set to ARMED — this is the observable side-effect.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('autodev', 'ARMED')
  })

  it('makes ZERO side-effect pi calls during registration (no writes, exec, or messages)', async () => {
    // Extension must only call pi.on() at load time — no writes, no exec, no messages.
    const { default: autodevExtension } = await import('../../src/extension/index.js')
    const mockPi = makeMockPi()
    autodevExtension(mockPi as any)

    expect(mockPi.exec).not.toHaveBeenCalled()
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled()
    expect(mockPi.sendMessage).not.toHaveBeenCalled()
    expect(mockPi.appendEntry).not.toHaveBeenCalled()
    // on() IS expected (registering handlers) — everything else must be silent
    expect(mockPi.on).toHaveBeenCalled()
  })
})

describe('buildLaneAdapter: lane invokes mocked subagent-runner (Finding 7)', () => {
  it('lane run() delegates to injected SubagentRunner when provided', async () => {
    const ext = buildExtension()

    // Build a mock Lane to back the SubagentRunner
    const mockLane = {
      id: 'mock',
      files: [],
      run: vi.fn().mockResolvedValue({ output: 'runner output', exitCode: 0 }),
      status: () => 'idle' as const,
    }
    const runner = new SubagentRunner(mockLane)

    // buildLane accepts an optional runner as the third argument
    const lane = ext.buildLane('test-lane', ['src/foo.ts'], runner)
    const result = await lane.run('implement foo', { workdir: '/tmp' })

    expect(mockLane.run).toHaveBeenCalledWith('implement foo', { workdir: '/tmp' })
    expect(result.output).toBe('runner output')
    expect(result.exitCode).toBe(0)
  })

  it('lane run() returns stub output when no runner is provided', async () => {
    const ext = buildExtension()
    const lane = ext.buildLane('stub-lane', [])
    const result = await lane.run('stub task')

    expect(result.output).toContain('stub-lane')
    expect(result.exitCode).toBe(0)
  })
})
