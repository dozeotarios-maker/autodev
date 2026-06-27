// B2: Gear dispatch + quick/middle gear methods + task-type router + journal/status
//
// Test strategy: mock pi + phase deps (same as controller.test.ts pattern).
// afterEach uses the B1 deterministic teardown-settle pattern: wait for
// .autodev/running.lock to release + 25ms margin before rmdir.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Controller } from '../../src/host/controller.js'
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

// ── Mock factories (same as controller.test.ts) ───────────────────────────────

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

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) =>
    handlers[event]?.(e, ctx)

  return { pi, handlers, sendUserMessageCalls, fire }
}

function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void; onError: (e: Error) => void }) => {
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

// ── B1 teardown-settle helper ─────────────────────────────────────────────────

/**
 * Wait for a run to start (lock appears) then finish (lock disappears).
 * First polls until the lock file exists (run started), then polls until it
 * disappears (lock released). Falls through if the lock never appears
 * (run completed so fast the lock was never observed, or run never started).
 */
async function waitForLockRelease(tmpDir: string, timeoutMs = 6_000): Promise<void> {
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

// ── Task 2: task-type router stubs ────────────────────────────────────────────

describe('B2 Task2: debug: → escalates with stub message, starts no phase', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-debug-router-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: idea escalates with stub message and no P1 steer fires', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)

    // Wait for escalation to complete
    await waitForLockRelease(tmpDir)

    // Must escalate with the stub message
    expect(transparency.log).toHaveBeenCalledWith(
      expect.stringContaining('debug track not yet implemented')
    )
    // Must NOT have steered P1 (no sendUserMessage calls)
    expect(pi.sendUserMessage).not.toHaveBeenCalled()
    // Lock must be released (escalate path calls lifecycle.release)
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
  }, 10_000)
})

describe('B2 Task2: refactor: → escalates with stub message, starts no phase', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-refactor-router-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('refactor: idea escalates with stub message and no P1 steer fires', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('refactor: extract auth module from monolith'), ctx)

    await waitForLockRelease(tmpDir)

    expect(transparency.log).toHaveBeenCalledWith(
      expect.stringContaining('refactor track not yet implemented')
    )
    expect(pi.sendUserMessage).not.toHaveBeenCalled()
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
  }, 10_000)
})

describe('B2 Task2: build:/no-prefix → proceeds normally (enters full _runPhases, P1 steer fires)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-build-router-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('no-prefix idea → P1 steer fires (full path runs)', async () => {
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

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('add a slugify utility function with tests'), ctx)

    // Wait for P1 steer to be in-flight
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    expect(pi.sendUserMessage).toHaveBeenCalled()
    // Drain: write P1 file and fire agent_end to let steer complete/timeout
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Add a slugify utility function with comprehensive tests', stackAdr: 'Node.js', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await waitForLockRelease(tmpDir)
  }, 10_000)

  it('build: idea → P1 steer fires (build: taskType is the default)', async () => {
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

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('build: a REST API for user management'), ctx)

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    expect(pi.sendUserMessage).toHaveBeenCalled()
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Build a REST API for user management with CRUD endpoints', stackAdr: 'Node.js + Express', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await waitForLockRelease(tmpDir)
  }, 10_000)
})

// ── Task 3: gear dispatch ─────────────────────────────────────────────────────

describe('B2 Task3: quick: → _runPhasesQuick invoked (seed steer, no P1Discover/P2/P3 ceremony)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-quick-dispatch-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('quick: prefix → seed steer fires (sendUserMessage called), NOT the P1Discover ceremony steer', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const steerContents: string[] = []
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn((content: string) => {
      steerContents.push(content)
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)

    // Wait for seed steer to fire
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        if (steerContents.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    expect(steerContents.length).toBeGreaterThanOrEqual(1)
    // Seed steer must NOT contain the P1 DISCOVER role directive
    expect(steerContents[0]).not.toContain('P1 DISCOVER phase')
    // Seed steer must contain a build-plan/minimal-plan request
    expect(steerContents[0]).toContain('quick')

    // Drain: write seed output files and fire agent_end
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    // Write both seed files (p1-spec.json and p3-plan.json) before agent_end
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Add a slugify function that converts strings to URL-safe slugs', stackAdr: '(quick gear — no ADR)', webResearch: [],
    }))
    await fs.writeFile(path.join(outputDir, 'p3-plan.json'), JSON.stringify({
      phase: 'P3',
      fileDAG: [{ file: 'src/slugify.ts', lane: 0, deps: [] }],
      panelObjCount: 0,
      sprintContract: { goal: 'Add slugify function', successCriteria: ['slugify("Hello World") === "hello-world"'], outOfScope: [] },
      examplesTable: [{ scenario: 'basic', input: 'slugify("Hello World")', expectedOutput: '"hello-world"' }],
    }))
    fire('agent_end', makeAgentEndEvent('seed output written'), ctx)

    await waitForLockRelease(tmpDir)
  }, 10_000)

  it('quick: run releases the lock on escalation (seed fails)', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // very short → seed steer times out → escalate
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)

    // Wait for escalation + lock release
    await waitForLockRelease(tmpDir)

    // Lock must be released after escalation
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
  }, 10_000)
})

describe('B2 Task3: mid: → _runPhasesMiddle invoked (P1 steer fires, NO P2 persona steer)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-middle-dispatch-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('mid: prefix → P1 steer fires (P1Discover runs), then NO P2 persona steer', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const steerContents: string[] = []
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn((content: string) => {
      steerContents.push(content)
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('mid: build a payments API with Stripe integration'), ctx)

    // Wait for P1 steer to be in-flight
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        if (steerContents.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    expect(steerContents.length).toBeGreaterThanOrEqual(1)
    // First steer must be the P1 DISCOVER steer
    expect(steerContents[0]).toContain('P1 DISCOVER')

    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Build a payments API with Stripe integration and webhook handling', stackAdr: 'Node.js + Stripe SDK', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent('P1 done'), ctx)

    // Wait for P3 steer to be in-flight (2nd steer: P3, NOT P2 persona)
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        if (steerContents.length >= 2 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // The 2nd steer must be P3 (not P2 persona debate)
    if (steerContents.length >= 2) {
      expect(steerContents[1]).toContain('P3 PLAN')
      expect(steerContents[1]).not.toContain('P2 ELABORATE')
    }

    // Write P3 file and drain
    await fs.writeFile(path.join(outputDir, 'p3-plan.json'), JSON.stringify({
      phase: 'P3',
      fileDAG: [{ file: 'src/payments.ts', lane: 0, deps: [] }],
      panelObjCount: 0,
      sprintContract: { goal: 'Build payments API', successCriteria: ['Stripe webhook handled'], outOfScope: [] },
      examplesTable: [{ scenario: 'payment', input: 'POST /pay', expectedOutput: '200' }],
    }))
    fire('agent_end', makeAgentEndEvent('P3 done'), ctx)

    await waitForLockRelease(tmpDir)
  }, 15_000)

  it('mid: run releases the lock on escalation (P1 fails)', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // very short → P1 steer times out → escalate
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('mid: build a payments API with Stripe integration'), ctx)

    await waitForLockRelease(tmpDir)

    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
  }, 10_000)
})

describe('B2 Task3: full:/no-prefix → existing _runPhases (P1 ceremony steer fires)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-full-dispatch-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('full: prefix → _runPhases runs (P1Discover fires its role directive)', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const steerContents: string[] = []
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn((content: string) => {
      steerContents.push(content)
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 200,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('full: build a distributed microservice platform'), ctx)

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        if (steerContents.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // P1 DISCOVER must fire (full gear uses _runPhases)
    expect(steerContents[0]).toContain('P1 DISCOVER')

    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
      phase: 'P1', spec: 'Build a distributed microservice platform with event sourcing', stackAdr: 'Kubernetes + Kafka', webResearch: [],
    }))
    fire('agent_end', makeAgentEndEvent(), ctx)
    await waitForLockRelease(tmpDir)
  }, 10_000)
})

// ── Task 6: gear in journal + /autodev-status ─────────────────────────────────

describe('B2 Task6: run-start journals gear + task-type', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-journal-gear-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('quick: idea → journal contains "gear: quick"', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // short → times out quickly, let it escalate
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)

    await waitForLockRelease(tmpDir)

    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const exists = await fs.access(journalPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
    const journal = await fs.readFile(journalPath, 'utf-8')
    expect(journal).toContain('gear: quick')
  }, 10_000)

  it('mid: idea → journal contains "gear: middle"', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('mid: build a payments API with Stripe'), ctx)

    await waitForLockRelease(tmpDir)

    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const journal = await fs.readFile(journalPath, 'utf-8')
    expect(journal).toContain('gear: middle')
  }, 10_000)

  it('no-prefix idea → journal contains "gear: full"', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('add a slugify function with comprehensive tests'), ctx)

    await waitForLockRelease(tmpDir)

    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const journal = await fs.readFile(journalPath, 'utf-8')
    expect(journal).toContain('gear: full')
  }, 10_000)

  it('debug: idea → journal contains "task-type: debug"', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)

    await waitForLockRelease(tmpDir)

    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const exists = await fs.access(journalPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
    const journal = await fs.readFile(journalPath, 'utf-8')
    expect(journal).toContain('task-type: debug')
  }, 10_000)
})

describe('B2 Task6: /autodev-status shows the gear', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-status-gear-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('/autodev-status JSON contains a "gear" field', async () => {
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
    const parsed = JSON.parse(notifyMock.mock.calls[0][0] as string) as Record<string, unknown>
    expect(parsed).toHaveProperty('gear')
  })
})
