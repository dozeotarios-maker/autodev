// M0 tests — written FIRST (D1), all should fail before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    autodevExtension(mockPi as any)

    const sessionStartCall = mockPi.on.mock.calls.find((c: any[]) => c[0] === 'session_start')
    expect(sessionStartCall).toBeDefined()

    const handler = sessionStartCall![1]
    const ctx = makeMockCtx()
    await handler({ type: 'session_start', reason: 'startup' }, ctx)

    const armedLog = consoleSpy.mock.calls.some((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a.includes('ARMED'))
    )
    expect(armedLog).toBe(true)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('autodev', 'ARMED')
    consoleSpy.mockRestore()
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
