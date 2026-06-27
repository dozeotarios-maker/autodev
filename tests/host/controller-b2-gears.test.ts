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
    changedFiles: vi.fn().mockResolvedValue([]),
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

// ── Task 2: task-type router — debug: now enters _runDebugTrack ──────────────
// REPLACED: the old stub test ('debug track not yet implemented') is no longer
// valid — debug: now invokes _runDebugTrack instead of the stub escalation.

describe('B2 Task2: debug: → enters _runDebugTrack (not old stub), no build-pipeline phase', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-debug-router-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: enters _runDebugTrack — no old stub msg, no P1 DISCOVER steer, lock released', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    // steerTimeoutMs=50 → D1 steer times out → escalates quickly
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50,
      boundedExec: {
        run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: '', timedOut: false, blocked: false }),
      },
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)

    await waitForLockRelease(tmpDir)

    // Must NOT emit the old stub message
    const logCalls = (transparency.log as ReturnType<typeof vi.fn>).mock.calls as [string][]
    expect(logCalls.some(([m]) => m.includes('debug track not yet implemented'))).toBe(false)

    // Must NOT have steered P1 DISCOVER (build pipeline not entered)
    const steerCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as [string][]
    expect(steerCalls.some(([m]) => m.includes('P1 DISCOVER'))).toBe(false)

    // Lock released (debug track terminated via escalation)
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // ESCALATE fired (debug track ran and hit a terminal)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
  }, 15_000)
})

describe('B2 Finding2: debug: after prior run escalates under a FRESH run-id', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-router-runid-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: run after prior quick run captures two distinct run-ids via retroWriter', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()

    // Capture run-ids via retroWriter mock (the only place currentRunId flows into an observable)
    const retroRunIds: string[] = []
    const retroWriter = {
      write: vi.fn(async ({ runId }: { runId: string }) => {
        retroRunIds.push(runId)
      }),
    } as unknown as import('../../src/engine/retro.js').RetroWriter

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // short: quick run times out immediately; debug D1 steer also times out
      retroWriter,
      // boundedExec required by debug track (D1 gate); won't be called because D1 steer times out first
      boundedExec: {
        run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: '', timedOut: false, blocked: false }),
      },
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // ── First run: quick gear, times out → escalates (retroWriter.write called with run-id 1) ──
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)
    await waitForLockRelease(tmpDir)

    expect(retroRunIds.length).toBeGreaterThanOrEqual(1)
    const firstRunId = retroRunIds[0]
    expect(firstRunId).toMatch(/^run-/)

    // ── Second run: debug: → _runDebugTrack (D1 steer times out → escalates with fresh run-id) ──
    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await waitForLockRelease(tmpDir)

    expect(retroRunIds.length).toBeGreaterThanOrEqual(2)
    const secondRunId = retroRunIds[retroRunIds.length - 1]
    expect(secondRunId).toMatch(/^run-/)
    // The two runs must have DIFFERENT run-ids (fresh reset on second run)
    expect(secondRunId).not.toBe(firstRunId)

    // Lock must be released after the debug escalation
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
    // debug track now ESCALATEs (D1 steer timeout) instead of emitting old stub
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
  }, 15_000)
})

describe('B2 Task2: refactor: → runs refactor track (R1 steer fires, no P1 steer)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-refactor-router-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('refactor: idea enters refactor track (R1 steer fires), not the old stub escalation', async () => {
    const { pi, fire, sendUserMessageCalls } = makeMockPi()
    const transparency = makeNullTransparency()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 500, // short timeout → R1 steer times out quickly → ESCALATE from track, not stub
      boundedExec: {
        run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
      },
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('refactor: extract auth module from monolith'), ctx)

    await waitForLockRelease(tmpDir)

    // Stub message must NOT appear (refactor track replaced the stub)
    expect(transparency.log).not.toHaveBeenCalledWith(
      expect.stringContaining('refactor track not yet implemented')
    )

    // Lock released (refactor track ran and terminated)
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)

    // R1 steer must have fired (sendUserMessage called with R1 CHARACTERIZE instruction)
    // The short timeout causes R1 to escalate, but the steer WAS sent
    expect(sendUserMessageCalls.some(p => p.includes('R1 CHARACTERIZE'))).toBe(true)

    // build pipeline never entered
    expect(sendUserMessageCalls.some(p => p.includes('P1 DISCOVER'))).toBe(false)

    // The run terminated via ESCALATE (R1 steer timeout), not the old stub
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
  }, 15_000)
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
    let steerCallCount = 0

    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')

    // Finding 4: drive ALL 4 steers (seed + P4 + P5 + P6) so end-to-end chain runs.
    // Each sendUserMessage call writes the appropriate phase file so the next steer can fire.
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn(async (content: string) => {
      steerContents.push(content)
      steerCallCount++
      await fs.mkdir(outputDir, { recursive: true })
      if (steerCallCount === 1) {
        // Seed steer: write single combined quick-seed.json (Finding 1 fix)
        await fs.writeFile(path.join(outputDir, 'quick-seed.json'), JSON.stringify({
          spec: 'Add a slugify function that converts strings to URL-safe slugs',
          plan: {
            goal: 'Add slugify function',
            successCriteria: ['slugify("Hello World") === "hello-world"'],
            fileDAG: [{ file: 'src/slugify.ts', lane: 0, deps: [] }],
            examplesTable: [{ scenario: 'basic', input: 'slugify("Hello World")', expectedOutput: '"hello-world"' }],
          },
        }))
      } else if (steerCallCount === 2) {
        // P4 steer
        await fs.writeFile(path.join(outputDir, 'p4-build.json'), JSON.stringify({
          phase: 'P4',
          laneResults: [{ laneId: 0, status: 'success', output: 'ok' }],
          artifacts: ['src/slugify.ts'],
        }))
      } else if (steerCallCount === 3) {
        // P5 steer
        await fs.writeFile(path.join(outputDir, 'p5-verify.json'), JSON.stringify({
          phase: 'P5',
          verifyReport: { deterministicPassed: true, holdoutPassed: true, securityClean: true },
          reviewFindings: [],
        }))
      } else if (steerCallCount === 4) {
        // P6 steer
        await fs.writeFile(path.join(outputDir, 'p6-release.json'), JSON.stringify({
          phase: 'P6',
          commitSha: 'quickabc123',
          pushResult: 'pushed',
        }))
      }
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)

    // Drive all 4 steers: poll for new sendUserMessage, fire agent_end to advance each phase.
    const drivePhases = async () => {
      let driven = 0
      const deadline = Date.now() + 20_000
      while (driven < 4 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 30))
        if (steerCallCount > driven) {
          await new Promise(r => setTimeout(r, 50))
          driven = steerCallCount
          fire('agent_end', makeAgentEndEvent('output written'), ctx)
          await new Promise(r => setTimeout(r, 50))
        }
      }
    }
    await drivePhases()
    await waitForLockRelease(tmpDir)

    // Steer 1 must be the quick seed (not P1 DISCOVER)
    expect(steerContents.length).toBeGreaterThanOrEqual(1)
    expect(steerContents[0]).not.toContain('P1 DISCOVER phase')
    expect(steerContents[0]).toContain('quick')

    // Finding 4: assert seed→P4→P5→P6→release end-to-end
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const journalExists = await fs.access(journalPath).then(() => true).catch(() => false)
    expect(journalExists).toBe(true)
    const journalText = await fs.readFile(journalPath, 'utf-8')
    expect(journalText).toContain('P6 release (quick gear)')
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (quick gear)'))
  }, 30_000)

  it('quick: seed file present but plan missing → clean escalate + lock released', async () => {
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
    void fire('input', makeInputEvent('quick: add a slugify function'), ctx)

    // Wait for seed steer to fire
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 3_000
      const check = () => {
        const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls
        if (calls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // Write a seed file with spec but NO plan field — should trigger clean escalate
    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'quick-seed.json'), JSON.stringify({
      spec: 'Add a slugify function',
      // plan field intentionally absent
    }))
    fire('agent_end', makeAgentEndEvent('seed written (no plan)'), ctx)

    // Wait for escalation + lock release
    await waitForLockRelease(tmpDir)

    // Must escalate cleanly (no crash), lock must be released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    expect(locked).toBe(false)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    // Escalate message must mention "plan" (Finding 5: includes raw excerpt context)
    const escalateCalls = (transparency.log as ReturnType<typeof vi.fn>).mock.calls
    const escalateMsg = escalateCalls.find((args: unknown[]) =>
      typeof args[0] === 'string' && (args[0] as string).includes('ESCALATE')
    )?.[0] as string | undefined
    expect(escalateMsg).toBeDefined()
    expect(escalateMsg).toContain('plan')
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

    // Finding 3 fix: hard assert that the 2nd steer fired — a conditional guard
    // silently passed with zero assertions if the steer never arrived.
    expect(steerContents.length).toBeGreaterThanOrEqual(2)
    // The 2nd steer must be P3 (not P2 persona debate)
    expect(steerContents[1]).toContain('P3 PLAN')
    expect(steerContents[1]).not.toContain('P2 ELABORATE')

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
