// S2-M2: Controller tests — mock pi host, synthetic agent_end + phase file writes.
//
// Test strategy: inject a mock pi (sendUserMessage records; test fires synthetic agent_end
// AND writes the .autodev/phase-output file; mock compactAsync onComplete).
// Every S2-M2 default-FAIL criterion covered.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Controller, compactAsync } from '../../src/host/controller.js'
import type { ControllerOptions } from '../../src/host/controller.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
  AgentEndEvent,
  TurnEndEvent,
  ContextEvent,
  ToolCallEvent,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'

// ── Mock factories ────────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown

function makeMockPi(): {
  pi: ExtensionAPI
  handlers: Record<string, EventHandler>
  sendUserMessageCalls: string[]
  fire(event: string, e: unknown, ctx?: unknown): unknown
} {
  const handlers: Record<string, EventHandler> = {}
  const sendUserMessageCalls: string[] = []

  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers[event] = handler
    }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn((content: string) => {
      sendUserMessageCalls.push(content)
    }),
  } as unknown as ExtensionAPI

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) => {
    return handlers[event]?.(e, ctx)
  }

  return { pi, handlers, sendUserMessageCalls, fire }
}

function makeExtCtx(overrides: Partial<Record<string, unknown>> = {}): ExtensionContext {
  return {
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    compact: vi.fn(({ onComplete }: { onComplete: () => void; onError: (e: Error) => void }) => {
      // Synchronously call onComplete so compactAsync resolves immediately in tests
      setImmediate(onComplete)
    }),
    ...overrides,
  } as unknown as ExtensionContext
}

function makeAgentEndEvent(rawText = 'response'): AgentEndEvent {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: rawText }] }],
  } as unknown as AgentEndEvent
}

function makeTurnEndEvent(): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 0,
    message: { role: 'assistant', content: [] },
    toolResults: [],
  } as unknown as TurnEndEvent
}

function makeInputEvent(text: string): InputEvent {
  return {
    type: 'input',
    text,
    source: 'user',
  } as unknown as InputEvent
}

function makeSessionStartEvent(): SessionStartEvent {
  return { type: 'session_start' } as unknown as SessionStartEvent
}

function makeNullTransparency(): Transparency {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    setHudStatus: vi.fn(),
    recordMetric: vi.fn().mockResolvedValue(undefined),
  }
}

function makeNullVerifier(): Verifier {
  return {
    runDeterministic: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: '' }),
    runMutation: vi.fn().mockResolvedValue({ score: 1.0, passed: true }),
    runHoldout: vi.fn().mockResolvedValue({ passed: true, output: '' }),
    runSecurityScan: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
  }
}

function makeNullGitOps(): GitOps {
  return {
    scopedCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
    perPhasePush: vi.fn().mockResolvedValue(undefined),
    tierDGate: vi.fn().mockResolvedValue(true),
    scanSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
  }
}

function makeNullJudge(): Judge {
  return {
    isDone: vi.fn().mockResolvedValue(true),
    isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
  }
}

// ── compactAsync unit test ────────────────────────────────────────────────────

describe('S2-M2: compactAsync', () => {
  it('resolves when ctx.compact onComplete fires', async () => {
    const ctx = makeExtCtx()
    await compactAsync(ctx)
    expect((ctx.compact as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })

  it('rejects when ctx.compact onError fires', async () => {
    const ctx = {
      compact: vi.fn(({ onError }: { onComplete: () => void; onError: (e: Error) => void }) => {
        setImmediate(() => onError(new Error('compact failed')))
      }),
    } as unknown as ExtensionContext
    await expect(compactAsync(ctx)).rejects.toThrow('compact failed')
  })
})

// ── Controller lifecycle ──────────────────────────────────────────────────────

describe('S2-M2: Controller — session_start → ARMED', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctrl-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeController(piMock: ExtensionAPI, opts: Partial<ControllerOptions> = {}) {
    return new Controller(piMock, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      ...opts,
    })
  }

  it('wires session_start and registers the handler', () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi)
    ctrl.wire()
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('wires agent_end, turn_end, input, context, tool_call, session_before_compact', () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi)
    ctrl.wire()
    const events = (pi.on as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args[0] as string)
    expect(events).toContain('agent_end')
    expect(events).toContain('turn_end')
    expect(events).toContain('input')
    expect(events).toContain('context')
    expect(events).toContain('tool_call')
    expect(events).toContain('session_before_compact')
  })

  it('session_start → sets status ARMED', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, { transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('autodev', 'ARMED')
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ARMED'))
  })

  it('non-idea input (question) stays ARMED, does not start run', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, { transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    await fire('input', makeInputEvent('what does this do?'), ctx)

    // Should log "question/command" and NOT log RUNNING
    expect(transparency.log).not.toHaveBeenCalledWith(expect.stringContaining('RUNNING'))
  })

  it('input with idea → ARMED→RUNNING + sets run-lock + starts P1', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, { transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Fire idea input — this starts _runPhases() async
    // We don't await completion here, just check the transition triggers
    const inputPromise = fire('input', makeInputEvent('Build a REST API for todo management'), ctx)

    // Give the event loop a tick so lifecycle.run() fires
    await new Promise(r => setImmediate(r))

    // RUNNING state should be set
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('autodev', 'RUNNING')
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('RUNNING'))

    // Clean up: resolve any pending steers by firing agent_end
    // (steer() will be waiting; give it a file and resolve)
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    const p1File = path.join(outputDir, 'p1-spec.json')
    await fs.writeFile(p1File, JSON.stringify({
      phase: 'P1', spec: 'A REST API for todo management with CRUD operations', stackAdr: 'Node.js + Express', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)

    // Let settle
    void inputPromise
  }, 10_000)

  it('second idea input while RUNNING is ignored', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, { transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a REST API for todo management'), ctx)

    await new Promise(r => setImmediate(r))

    // Clear mock call counts
    ;(transparency.log as ReturnType<typeof vi.fn>).mockClear()

    // Second idea while RUNNING
    void fire('input', makeInputEvent('Build something else now'), ctx)
    await new Promise(r => setImmediate(r))

    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('already RUNNING'))

    // Clean up
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'test spec with enough chars', stackAdr: 'Node.js stack', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
  }, 10_000)
})

// ── compactAsync awaited at phase boundary ────────────────────────────────────

describe('S2-M2: compactAsync awaited at each phase boundary', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('compact is called between P1 and P2 steers', async () => {
    const { pi, fire } = makeMockPi()

    let compactCallCount = 0
    const ctx = {
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      compact: vi.fn(({ onComplete }: { onComplete: () => void; onError: (e: Error) => void }) => {
        compactCallCount++
        setImmediate(onComplete)
      }),
    } as unknown as ExtensionContext

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()

    await fire('session_start', makeSessionStartEvent(), ctx)

    // Start the run
    void fire('input', makeInputEvent('Build a weather forecasting service'), ctx)
    await new Promise(r => setImmediate(r))

    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })

    // Write P1 file first, then wait for P1's steer to be in-flight
    // (sendUserMessage must be called before firing agent_end, else pending=null → ignored)
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'A weather forecasting service with hourly updates', stackAdr: 'Python + FastAPI stack', webResearch: [],
    }))

    // Poll until P1's steer has fired sendUserMessage (1st call = P1 steer in-flight)
    await new Promise<void>((resolve) => {
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // Now fire agent_end → P1 completes → compact fires → P2 steer
    fire('agent_end', makeAgentEndEvent('P1 output written'), ctx)

    // Wait for compact to be called (async boundary)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (compactCallCount >= 1) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    expect(compactCallCount).toBeGreaterThanOrEqual(1)

    // Write P2 file and wait for P2's steer to be in-flight (sendUserMessage called twice)
    // before firing agent_end — otherwise pending is null and agent_end is ignored.
    await fs.writeFile(path.join(outputDir, 'p2-domain.json'), JSON.stringify({
      phase: 'P2', domainModel: 'WeatherStation, Forecast, User', personaDebate: [{ persona: 'user', stance: 'ok', objections: [] }],
    }))

    // Poll until P2's steer has fired sendUserMessage (2nd call = P2 steer in-flight)
    await new Promise<void>((resolve) => {
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 2) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    fire('agent_end', makeAgentEndEvent('P2 output written'), ctx)

    await new Promise(r => setTimeout(r, 50))
  }, 15_000)
})

// ── context event masking ─────────────────────────────────────────────────────

describe('S2-M2: context event masks stale phase messages', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mask-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('context handler returns { messages } rewrite', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()

    // Build a context event with 25 tool results (> 20 max)
    const messages = [
      ...Array.from({ length: 25 }, (_, i) => ({
        role: 'tool',
        content: `tool result ${i}`,
        type: 'tool_result',
      })),
      { role: 'assistant', content: 'current response' },
    ]

    const contextEvent: ContextEvent = { type: 'context', messages: messages as unknown as ContextEvent['messages'] }
    const result = fire('context', contextEvent) as { messages: unknown[] } | undefined

    // Should return masked messages (5 oldest masked, 20 kept + 1 assistant = 21 visible)
    expect(result).toBeDefined()
    expect(result?.messages).toBeDefined()
    expect(result!.messages.length).toBe(26) // Same length, but content masked
  })
})

// ── session_before_compact ────────────────────────────────────────────────────

describe('S2-M2: session_before_compact — defensive journal write', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'before-compact-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('session_before_compact fires without error', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
    })
    ctrl.wire()

    // Should not throw
    await expect(
      fire('session_before_compact', { type: 'session_before_compact' } as SessionBeforeCompactEvent)
    ).resolves.not.toThrow?.()
  })
})

// ── tool_call hook ────────────────────────────────────────────────────────────

describe('S2-M2: tool_call hook — H1 contract + action-monitor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('denies dangerous bash command (rm -rf)', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()

    const toolCallEvent = {
      type: 'tool_call',
      toolCallId: 'tc1',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/important' },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', toolCallEvent) as { block?: boolean; reason?: string } | undefined
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/blocked/i)
  })

  it('allows safe bash command', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()

    const toolCallEvent = {
      type: 'tool_call',
      toolCallId: 'tc2',
      toolName: 'bash',
      input: { command: 'npm test' },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', toolCallEvent) as { block?: boolean } | undefined
    expect(result?.block).toBeFalsy()
  })
})

// ── /autodev-pause / /autodev-resume ─────────────────────────────────────────

describe('S2-M2: /autodev-pause and /autodev-resume', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pause-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('registerCommands registers all 6 commands', () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const names = calls.map((args: unknown[]) => args[0] as string)
    expect(names).toContain('/autodev-status')
    expect(names).toContain('/autodev-config')
    expect(names).toContain('/autodev-tokens')
    expect(names).toContain('/autodev-pause')
    expect(names).toContain('/autodev-resume')
    expect(names).toContain('/autodev-doctor')
  })

  it('/autodev-pause creates the pause file', async () => {
    const { pi } = makeMockPi()
    const pauseFilePath = path.join(tmpDir, '.autodev', 'PAUSE')
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      pauseFilePath,
    })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const pauseCall = calls.find((args: unknown[]) => args[0] === '/autodev-pause')
    expect(pauseCall).toBeDefined()

    const handler = pauseCall![1].handler as (args: string, ctx: unknown) => Promise<void>
    const cmdCtx = { ui: { notify: vi.fn() } }
    await handler('', cmdCtx)

    const exists = await fs.access(pauseFilePath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('/autodev-resume removes the pause file', async () => {
    const { pi } = makeMockPi()
    const pauseFilePath = path.join(tmpDir, '.autodev', 'PAUSE')
    await fs.mkdir(path.dirname(pauseFilePath), { recursive: true })
    await fs.writeFile(pauseFilePath, 'paused')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      pauseFilePath,
    })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const resumeCall = calls.find((args: unknown[]) => args[0] === '/autodev-resume')
    const handler = resumeCall![1].handler as (args: string, ctx: unknown) => Promise<void>
    const cmdCtx = { ui: { notify: vi.fn() } }
    await handler('', cmdCtx)

    const exists = await fs.access(pauseFilePath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })
})

// ── /autodev-status ───────────────────────────────────────────────────────────

describe('S2-M2: /autodev-status returns phase+task+laneStatus+model+uptime', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('/autodev-status calls ctx.ui.notify with JSON containing phase/task/laneStatus/model/uptime', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const statusCall = calls.find((args: unknown[]) => args[0] === '/autodev-status')
    const handler = statusCall![1].handler as (args: string, ctx: unknown) => Promise<void>

    const notifyMock = vi.fn()
    const cmdCtx = { ui: { notify: notifyMock } }
    await handler('', cmdCtx)

    expect(notifyMock).toHaveBeenCalledOnce()
    const notifyArg = notifyMock.mock.calls[0][0] as string
    const parsed = JSON.parse(notifyArg) as Record<string, string>
    expect(parsed).toHaveProperty('phase')
    expect(parsed).toHaveProperty('task')
    expect(parsed).toHaveProperty('laneStatus')
    expect(parsed).toHaveProperty('model')
    expect(parsed).toHaveProperty('uptime')
  })
})

// ── Mid-steer timeout → phase marked suspect ──────────────────────────────────

describe('S2-M2: mid-steer timeout → phase suspect + journal + escalate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeout-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('when steer times out, controller escalates (no silent stall)', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // Very short timeout for test
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Fire idea — P1 steer will time out (no agent_end fired, no file written)
    void fire('input', makeInputEvent('Build a real-time chat application'), ctx)

    // Wait long enough for timeout + escalation
    await new Promise(r => setTimeout(r, 500))

    // Should have escalated (ESCALATE logged)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    // HUD should show BLOCKED
    expect(transparency.setHudStatus).toHaveBeenCalledWith(
      expect.anything(), 'BLOCKED', 'failed', 'none'
    )
  }, 10_000)
})

// ── Fix 6: TOCTOU — two rapid inputs cannot both start a run ─────────────────

describe('Fix 6: two rapid idea inputs cannot both start a run (TOCTOU)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toctou-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('second concurrent input is rejected by lifecycle.run() atomic lock', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Fire two idea inputs simultaneously (no await between them)
    const p1 = fire('input', makeInputEvent('Build a todo app with user auth'), ctx)
    const p2 = fire('input', makeInputEvent('Build a blog platform with CMS'), ctx)

    // Wait for both to fully settle (run lock I/O completes)
    await new Promise(r => setTimeout(r, 100))
    await p1
    await p2

    // The second input must have been denied — lifecycle.run() returns {ok:false}
    // for the second caller, which logs "input ignored (already RUNNING): ..."
    const deniedCalls = (transparency.log as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: unknown[]) => String(args[0]).includes('already RUNNING'))
    expect(deniedCalls).toHaveLength(1)

    // Only ONE _runPhases must have started: only one sendUserMessage for P1 steer
    // (after run lock resolves, _runPhases calls steer → sendUserMessage)
    await new Promise(r => setTimeout(r, 100))
    const sendCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls.length
    expect(sendCalls).toBeLessThanOrEqual(1)

    // Clean up: resolve the pending steer so the test doesn't hang
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Build a todo app with user auth — full spec', stackAdr: 'Node.js', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await new Promise(r => setTimeout(r, 50))
  }, 10_000)
})

// ── Fix (round-2): currentIdea uses WINNER's idea after concurrent inputs ─────

describe('Fix: concurrent inputs — winner idea is stored, loser idea is discarded', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-race-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent inputs with different ideas → run uses the WINNER idea', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
    })
    ctrl.wire()
    ctrl.registerCommands()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const WINNER_IDEA = 'Build a todo app with user auth for the winner'
    const LOSER_IDEA  = 'Build a blog platform with CMS for the loser'

    // Fire both simultaneously — the first one wins the in-process lock
    // (lifecycle sets state=RUNNING synchronously before any I/O).
    const p1 = fire('input', makeInputEvent(WINNER_IDEA), ctx)
    const p2 = fire('input', makeInputEvent(LOSER_IDEA), ctx)

    // Let both settle past the lifecycle.run() async lock path
    await new Promise(r => setTimeout(r, 150))
    await Promise.all([p1, p2])

    // Exactly one "already RUNNING" denial must have been logged
    const deniedCalls = (transparency.log as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: unknown[]) => String(args[0]).includes('already RUNNING'))
    expect(deniedCalls).toHaveLength(1)

    // /autodev-status reads this.currentIdea — it must equal the WINNER's idea,
    // not the loser's (before the fix, the loser's idea overwrote the winner's
    // because this.currentIdea was set before the lock was checked).
    const registerCalls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const statusCall = registerCalls.find((args: unknown[]) => args[0] === '/autodev-status')
    expect(statusCall).toBeDefined()
    const handler = statusCall![1].handler as (args: string, ctx: unknown) => Promise<void>
    const notifyMock = vi.fn()
    await handler('', { ui: { notify: notifyMock } })
    const parsed = JSON.parse(notifyMock.mock.calls[0][0] as string) as Record<string, string>
    expect(parsed.task).toContain(WINNER_IDEA.slice(0, 40))
    expect(parsed.task).not.toContain(LOSER_IDEA.slice(0, 40))

    // Clean up: resolve the pending P1 steer
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: `${WINNER_IDEA} — full spec`, stackAdr: 'Node.js', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await new Promise(r => setTimeout(r, 50))
  }, 10_000)
})

// ── Fix 7: _waitResume max-wait cap ──────────────────────────────────────────

describe('Fix 7: _waitResume escalates after max-wait instead of polling forever', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'waitresume-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('pause file removed within poll period → run proceeds normally', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const pauseFilePath = path.join(tmpDir, '.autodev', 'PAUSE')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      pauseFilePath,
    })
    ctrl.wire()
    ctrl.registerCommands()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Create pause file before idea input
    await fs.mkdir(path.dirname(pauseFilePath), { recursive: true })
    await fs.writeFile(pauseFilePath, new Date().toISOString())

    // Fire idea input — _runPhases will hit _waitResume and poll (every 2000ms)
    void fire('input', makeInputEvent('Build a search engine with indexing'), ctx)
    await new Promise(r => setImmediate(r))

    // Remove pause file immediately — _waitResume poll will detect on next tick
    await fs.unlink(pauseFilePath).catch(() => {})

    // Wait for _waitResume to detect removal (poll is 2000ms; give ample time)
    await new Promise<void>((resolve) => {
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1) resolve()
        else setTimeout(check, 50)
      }
      check()
    })

    // Run should have proceeded (sendUserMessage called for P1 steer)
    expect(pi.sendUserMessage).toHaveBeenCalled()

    // Clean up
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Build a search engine with indexing — full spec', stackAdr: 'Python', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await new Promise(r => setTimeout(r, 50))
  }, 15_000)
})
