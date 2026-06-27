// B3a: Phase-by-phase mode — step: prefix + _phaseGate + guarded hook + /autodev-status
//
// Test strategy: TDD order — Task1 (prefix), Task2 (phaseGate unit), Task3 (integration),
// Task4 (status command). Uses the B1 waitForLockRelease teardown-settle pattern.
//
// Key invariant: existing test mocks use ui:{setStatus,notify} with NO hasUI / NO ui.select
// → ctx.hasUI is falsy → _phaseGate short-circuits to 'continue' without touching ui.
// This file proves the same by asserting select is never called on default runs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Controller, parseOverrides } from '../../src/host/controller.js'
import type { ControllerOptions } from '../../src/host/controller.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
  AgentEndEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'

// ── Mock factories ────────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown

function makeMockPi(): {
  pi: ExtensionAPI
  handlers: Record<string, EventHandler>
  fire(event: string, e: unknown, ctx?: unknown): unknown
} {
  const handlers: Record<string, EventHandler> = {}
  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers[event] = handler
    }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) =>
    handlers[event]?.(e, ctx)

  return { pi, handlers, fire }
}

/** Standard ctx — NO hasUI, NO ui.select. Same as existing tests. */
function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void; onError: (e: Error) => void }) => {
      setImmediate(onComplete)
    }),
  } as unknown as ExtensionContext
}

/** UI-capable ctx for Task 2 / Task 3 B3a-gated tests */
function makeUiCtx(selectImpl: (...args: unknown[]) => Promise<string | undefined>): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(selectImpl),
    },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
      setImmediate(onComplete)
    }),
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
  return { type: 'input', text, source: 'interactive' }
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

// ── B1 teardown-settle helper (same as controller-b2-gears.test.ts) ───────────

async function waitForLockRelease(tmpDir: string, timeoutMs = 8_000): Promise<void> {
  const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs

  // Phase 1: wait for lock to appear (run started)
  while (Date.now() < deadline) {
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    if (locked) break
    await new Promise((r) => setTimeout(r, 10))
  }

  // Phase 2: wait for lock to disappear (run released)
  while (Date.now() < deadline) {
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    if (!locked) break
    await new Promise((r) => setTimeout(r, 15))
  }

  await new Promise((r) => setTimeout(r, 25))
}

// ════════════════════════════════════════════════════════════════════════════════
// Task 1 — step: prefix plumbing (parseOverrides unit tests)
// ════════════════════════════════════════════════════════════════════════════════

describe('B3a Task1: parseOverrides — step: prefix (unit)', () => {
  it('step: sets phaseByPhase=true, strips prefix, no forcedTier', () => {
    const r = parseOverrides('step: add user auth')
    expect(r.idea).toBe('add user auth')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBeUndefined()
    expect(r.taskType).toBe('build')
  })

  it('step: full: → phaseByPhase=true + forcedTier=XL + both stripped', () => {
    const r = parseOverrides('step: full: build a payments system')
    expect(r.idea).toBe('build a payments system')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('XL')
  })

  it('full: step: → same (both orders work)', () => {
    const r = parseOverrides('full: step: build a payments system')
    expect(r.idea).toBe('build a payments system')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('XL')
  })

  it('step: mid: → phaseByPhase=true + forcedTier=M', () => {
    const r = parseOverrides('step: mid: add auth module')
    expect(r.idea).toBe('add auth module')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('M')
  })

  it('mid: step: → same (both orders)', () => {
    const r = parseOverrides('mid: step: add auth module')
    expect(r.idea).toBe('add auth module')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('M')
  })

  it('step: mid-sentence NOT stripped — only leading prefix stripped', () => {
    const r = parseOverrides('add a step: thing to the pipeline')
    expect(r.idea).toBe('add a step: thing to the pipeline')
    expect(r.phaseByPhase).toBe(false)
  })

  it('no prefix → phaseByPhase=false (default)', () => {
    const r = parseOverrides('add user auth')
    expect(r.phaseByPhase).toBe(false)
  })

  it('quick: → phaseByPhase=false (step not present)', () => {
    const r = parseOverrides('quick: add a function')
    expect(r.phaseByPhase).toBe(false)
    expect(r.forcedTier).toBe('XS')
  })

  it('step: quick: → phaseByPhase=true + forcedTier=XS', () => {
    const r = parseOverrides('step: quick: add a function')
    expect(r.idea).toBe('add a function')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('XS')
  })

  it('loop cap 3: step: full: build: all three stripped', () => {
    // With cap=3, step: full: build: are all stripped
    const r = parseOverrides('step: full: build: create a thing')
    expect(r.idea).toBe('create a thing')
    expect(r.phaseByPhase).toBe(true)
    expect(r.forcedTier).toBe('XL')
    expect(r.taskType).toBe('build')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 2 — _phaseGate unit tests (exposed via Controller._phaseGate)
// We test via integration: flag OFF → gate no-op; flag ON + mocked ctx.ui.select
// We use a minimal Controller and call _phaseGate directly by accessing private field via cast.
// ════════════════════════════════════════════════════════════════════════════════

describe('B3a Task2: _phaseGate — hasUI=false → returns continue without calling select', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-gate-noui-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('ctx.hasUI falsy → _phaseGate returns continue, ui.select NOT called', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
    })

    const selectMock = vi.fn()
    // ctx without hasUI=true
    const ctx = {
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: selectMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    // Access private method via cast
    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P1', ctx)

    expect(result).toBe('continue')
    expect(selectMock).not.toHaveBeenCalled()
  })
})

describe('B3a Task2: _phaseGate — hasUI=true + ui.select mock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-gate-ui-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('select returns "continue" → gate returns continue', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
    })

    const ctx = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
        select: vi.fn().mockResolvedValue('continue'),
      },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P1', ctx)
    expect(result).toBe('continue')
    expect((ctx.ui as unknown as { select: ReturnType<typeof vi.fn> }).select).toHaveBeenCalledWith(
      expect.stringContaining('P1'),
      expect.arrayContaining(['continue', 'adjust', 'stop']),
      expect.objectContaining({ timeout: 100 })
    )
  })

  it('select returns "adjust" → gate returns adjust', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
    })

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn().mockResolvedValue('adjust') },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P2', ctx)
    expect(result).toBe('adjust')
  })

  it('select returns "stop" → gate returns stop', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
    })

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn().mockResolvedValue('stop') },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P3', ctx)
    expect(result).toBe('stop')
  })

  it('select returns undefined (timeout) → gate returns continue', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
    })

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn().mockResolvedValue(undefined) },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P4', ctx)
    expect(result).toBe('continue')
  })

  it('select returns unknown value → gate returns continue (safe default)', async () => {
    const { pi } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
    })

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn().mockResolvedValue('bogus') },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as { _phaseGate(p: string, c: ExtensionContext): Promise<'continue'|'adjust'|'stop'> })._phaseGate
    const result = await gate.call(ctrl, 'P5', ctx)
    expect(result).toBe('continue')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 3 — guarded hook in _runPhases integration tests
// ════════════════════════════════════════════════════════════════════════════════

describe('B3a Task3: flag OFF → existing full path, ui.select NEVER called', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-flag-off-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('no step: prefix → phaseByPhase=false → P1 steer fires, ui.select never called', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const selectMock = vi.fn()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 200,
    })
    ctrl.wire()

    // Use a UI ctx — but phaseByPhase=false so select should never fire
    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: selectMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('add a slugify utility function with tests'), ctx)

    // Let P1 steer fire then let timeout kill it
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // P1 fired, run will time out and escalate — verify select never called
    expect(selectMock).not.toHaveBeenCalled()

    await waitForLockRelease(tmpDir)
    // Even after run completes, select must not have been called
    expect(selectMock).not.toHaveBeenCalled()
  }, 12_000)
})

describe('B3a Task3: flag ON + select→continue → run proceeds normally', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-continue-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('step: prefix + select returns continue → P1 succeeds, P2 phase begins', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')

    let steerCount = 0
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn(async () => {
      steerCount++
      await fs.mkdir(outputDir, { recursive: true })
      if (steerCount === 1) {
        // P1 output — spec must be ≥20 chars to pass P1Discover validation
        await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
          phase: 'P1', spec: 'Add user authentication system with JWT tokens', stackAdr: 'Node.js + Express', webResearch: [],
        }))
      }
      // Further phases: steerTimeout will kill them after P1 gate fires
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 300,
      dialogueTimeoutMs: 100,
    })
    ctrl.wire()

    const selectMock = vi.fn().mockResolvedValue('continue')
    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: selectMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('step: add user auth system'), ctx)

    // Drive P1: wait for first steer, fire agent_end
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 4_000
      const check = () => {
        if (steerCount >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 20)
      }
      check()
    })
    fire('agent_end', makeAgentEndEvent(), ctx)

    // After P1 completes, _phaseGate should be called with 'P1'
    // Give time for gate to fire
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        if (selectMock.mock.calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 20)
      }
      check()
    })

    // Gate fired with P1
    expect(selectMock).toHaveBeenCalledWith(
      expect.stringContaining('P1'),
      expect.arrayContaining(['continue', 'adjust', 'stop']),
      expect.any(Object)
    )

    await waitForLockRelease(tmpDir)
  }, 15_000)
})

describe('B3a Task3: flag ON + select→stop → _operatorBrief called, lock released', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-stop-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('step: prefix + select returns stop → _operatorBrief fires + lock released', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')

    let steerCount = 0
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn(async () => {
      steerCount++
      await fs.mkdir(outputDir, { recursive: true })
      if (steerCount === 1) {
        // spec must be ≥20 chars to pass P1Discover validation
        await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
          phase: 'P1', spec: 'Add user authentication system with JWT tokens', stackAdr: 'Node.js + Express', webResearch: [],
        }))
      }
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 300,
      dialogueTimeoutMs: 100,
    })
    ctrl.wire()

    const selectMock = vi.fn().mockResolvedValue('stop')
    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: selectMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('step: add user auth system'), ctx)

    // Drive P1 steer
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 4_000
      const check = () => {
        if (steerCount >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 20)
      }
      check()
    })
    fire('agent_end', makeAgentEndEvent(), ctx)

    // Wait for gate to fire then run to terminate
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)

    // Transparency must reflect OPERATOR NEEDED (from _operatorBrief) or phase-by-phase stop
    expect(transparency.log).toHaveBeenCalledWith(
      expect.stringContaining('phase-by-phase: human chose stop')
    )
  }, 15_000)
})

describe('B3a Task3: adjust → re-runs phase, capped at 3 then continues', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-adjust-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('4 consecutive adjust responses → capped at 3 then continues (journal records cap exceeded)', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')

    let steerCount = 0
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn(async () => {
      steerCount++
      await fs.mkdir(outputDir, { recursive: true })
      // Write P1 on every steer (initial + up to 3 re-runs) — spec/stackAdr pass validation
      await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
        phase: 'P1',
        spec: 'Add user authentication system with JWT tokens',
        stackAdr: 'Node.js + Express',
        webResearch: [],
      }))
    })

    let selectCallCount = 0
    // Return 'adjust' 4 times — cap is 3, so 4th adjust is force-continued without calling select a 4th time
    const selectMock = vi.fn(async () => {
      selectCallCount++
      if (selectCallCount <= 4) return 'adjust'
      return 'continue'
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 2_000,  // generous: re-runs need time
      dialogueTimeoutMs: 100,
    })
    ctrl.wire()

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), select: selectMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('step: add user auth system'), ctx)

    // Drive ALL steers: poll for new sendUserMessage calls, fire agent_end for each.
    // Do NOT break on lock release — re-runs happen after lock is still held.
    // Run until the lock releases naturally (run finishes after adjust-cap + escalation/timeout).
    const driverRunning = { stop: false }
    const driverDone = (async () => {
      let driven = 0
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline && !driverRunning.stop) {
        await new Promise(r => setTimeout(r, 20))
        if (steerCount > driven) {
          // New steer appeared — wait briefly for file write, then fire agent_end
          await new Promise(r => setTimeout(r, 30))
          driven = steerCount
          fire('agent_end', makeAgentEndEvent(), ctx)
          await new Promise(r => setTimeout(r, 30))
        }
      }
    })()

    await waitForLockRelease(tmpDir)
    driverRunning.stop = true
    await driverDone

    // P1 must have run more than once (initial + at least 1 re-run due to adjust)
    expect(steerCount).toBeGreaterThanOrEqual(2)

    // Journal must record "adjust limit reached" (hit after 3 adjusts)
    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const journalExists = await fs.access(journalPath).then(() => true).catch(() => false)
    expect(journalExists).toBe(true)
    const journalText = await fs.readFile(journalPath, 'utf-8')
    expect(journalText).toContain('adjust limit')
  }, 35_000)
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 4 — /autodev-status includes phaseByPhase flag
// ════════════════════════════════════════════════════════════════════════════════

describe('B3a Task4: /autodev-status includes phaseByPhase flag', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3a-status-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('status reflects phaseByPhase=false by default', async () => {
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
    await handler('', { ui: { notify: notifyMock } })

    expect(notifyMock).toHaveBeenCalledOnce()
    const parsed = JSON.parse(notifyMock.mock.calls[0][0] as string) as Record<string, unknown>
    expect(parsed).toHaveProperty('phaseByPhase', false)
  })

  it('status reflects phaseByPhase=true after step: input starts a run', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 200,
    })
    ctrl.wire()
    ctrl.registerCommands()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('step: add user auth system'), ctx)

    // Wait for P1 steer to start (phaseByPhase set by then)
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const statusCall = calls.find((args: unknown[]) => args[0] === '/autodev-status')
    const handler = statusCall![1].handler as (args: string, ctx: unknown) => Promise<void>

    const notifyMock = vi.fn()
    await handler('', { ui: { notify: notifyMock } })

    expect(notifyMock).toHaveBeenCalledOnce()
    const parsed = JSON.parse(notifyMock.mock.calls[0][0] as string) as Record<string, unknown>
    expect(parsed).toHaveProperty('phaseByPhase', true)

    await waitForLockRelease(tmpDir)
  }, 12_000)
})
