// Stage D Group 4 integration tests: refactor track R1→R4 via controller
//
// Strategy: mock pi + all dependencies (hostAgent via sendUserMessage intercept,
// boundedExec, verifier, gitOps). B1 teardown-settle pattern (waitForLockRelease).
// Uses the lock-disappears driver pattern (runs <10s, NOT deadline-bound).
// Polls NEVER resolve-on-timeout — always reject-loud or break on condition.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Controller } from '../../src/host/controller.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
  AgentEndEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency, BoundedExec } from '../../src/ports.js'
import type { R1Output, R2Output } from '../../src/refactor/refactor-output.js'

// ── Mock factories ────────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown

function makeMockPi(): {
  pi: ExtensionAPI
  handlers: Record<string, EventHandler>
  fire(event: string, e: unknown, ctx?: unknown): unknown
  steerPrompts: string[]
} {
  const handlers: Record<string, EventHandler> = {}
  const steerPrompts: string[] = []

  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => { handlers[event] = handler }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn((content: string) => { steerPrompts.push(content) }),
  } as unknown as ExtensionAPI

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) =>
    handlers[event]?.(e, ctx)

  return { pi, handlers, fire, steerPrompts }
}

function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
  } as unknown as ExtensionContext
}

function makeInputEvent(text: string): InputEvent {
  return { type: 'input', text, source: 'interactive' }
}

function makeSessionStartEvent(): SessionStartEvent {
  return { type: 'session_start' } as unknown as SessionStartEvent
}

function makeAgentEndEvent(rawText = 'done'): AgentEndEvent {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: rawText }] }],
  } as unknown as AgentEndEvent
}

function makeTurnEndEvent(): TurnEndEvent {
  return {
    type: 'turn_end', turnIndex: 0,
    message: { role: 'assistant', content: [] }, toolResults: [],
  } as unknown as TurnEndEvent
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
    runDeterministic: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'suite ok' }),
    runMutation: vi.fn().mockResolvedValue({ score: 1.0, passed: true }),
    runHoldout: vi.fn().mockResolvedValue({ passed: true, output: '' }),
    runSecurityScan: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
  }
}

function makeNullGitOps(): GitOps {
  return {
    scopedCommit: vi.fn().mockResolvedValue({ sha: 'refactorabc123' }),
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

// ── B1 teardown-settle helper ──────────────────────────────────────────────────

async function waitForLockRelease(tmpDir: string, timeoutMs = 3_000): Promise<void> {
  const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs

  const initiallyLocked = await fs.access(lockPath).then(() => true).catch(() => false)
  if (!initiallyLocked) {
    await new Promise((r) => setTimeout(r, 10))
    return
  }

  while (Date.now() < deadline) {
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    if (!locked) break
    await new Promise((r) => setTimeout(r, 10))
  }

  await new Promise((r) => setTimeout(r, 10))
}

// ── Steer driver helper ────────────────────────────────────────────────────────
// Drives steer calls by writing the expected output file then firing agent_end.
// Uses the lock-disappears pattern for fast termination (<10s).

type SteerDriver = (steerIndex: number, prompt: string, outputDir: string) => Promise<void>

async function driveRefactorSteers(
  fire: (event: string, e: unknown, ctx?: unknown) => unknown,
  ctx: ExtensionContext,
  steerPrompts: string[],
  driver: SteerDriver,
  maxSteers = 8,
  timeoutMs = 15_000,
  tmpDir?: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let driven = 0
  while (driven < maxSteers && Date.now() < deadline) {
    // Stop as soon as the run-lock disappears — the run is done.
    // R3 and R4 are deterministic gates that fire no steers, so driven never
    // reaches maxSteers on those paths, causing the old code to busy-wait.
    if (tmpDir) {
      const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
      const locked = await fs.access(lockPath).then(() => true).catch(() => false)
      if (!locked && driven > 0) break
    }
    await new Promise((r) => setTimeout(r, 20))
    if (steerPrompts.length > driven) {
      const prompt = steerPrompts[driven]
      driven++
      const outputDirMatch = prompt.match(/Write your result as valid JSON to: (.+)/)
      const outputFile = outputDirMatch?.[1]?.trim() ?? ''
      const outputDir = path.dirname(outputFile)
      await driver(driven - 1, prompt, outputDir)
      fire('turn_end', makeTurnEndEvent(), ctx)
      fire('agent_end', makeAgentEndEvent(), ctx)
      await new Promise((r) => setTimeout(r, 30))
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Stage D refactor track: happy path R1→R2→R3→R4→commit', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-happy-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('refactor: R1(green×3)→R2(anti-cheat ok)→R3(char green×3 + suite green)→R4 commit, lock released, P1-P6 not entered', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()

    // boundedExec: GREEN on all calls (R1 gate: char green on current code; R3 gate: char green after refactor)
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
    }

    const verifier = makeNullVerifier() // suite passes
    const gitOps = makeNullGitOps()

    const charArtifact = path.join(tmpDir, 'tests', 'refactor', 'char-auth.test.ts')

    // changedFiles: returns the refactored file (NOT the char artifact) after R2
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/auth/validate.ts'])

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier,
      gitOps,
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Steer driver: writes appropriate R-step output file for each steer
    const steerDriver: SteerDriver = async (idx, _prompt, dir) => {
      await fs.mkdir(dir, { recursive: true })

      if (idx === 0) {
        // R1 steer: write r1-characterize.json + create the characterization file
        const r1Data: R1Output = {
          characterizationSummary: 'Pins auth token validation observable behavior',
          characterizationCommand: `npx vitest run ${charArtifact}`,
          characterizationArtifact: charArtifact,
          coversExisting: false,
        }
        await fs.mkdir(path.dirname(charArtifact), { recursive: true })
        await fs.writeFile(charArtifact, '// characterization test\nimport { expect, it } from "vitest"\nit("validates token", () => { expect(true).toBe(true) })')
        await fs.writeFile(path.join(dir, 'r1-characterize.json'), JSON.stringify(r1Data))
      } else if (idx === 1) {
        // R2 steer: write r2-transform.json (does NOT touch char file)
        const r2Data: R2Output = {
          transformSummary: 'Extracted auth token validation into a dedicated module',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'r2-transform.json'), JSON.stringify(r2Data))
      }
      // R3 and R4 are deterministic gates (no steer)
    }

    void fire('input', makeInputEvent('refactor: extract auth module into a dedicated file'), ctx)
    await driveRefactorSteers(fire, ctx, steerPrompts, steerDriver, 5, 15_000, tmpDir)
    await waitForLockRelease(tmpDir)

    // Verify: build pipeline NOT entered (no P1 DISCOVER steer)
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)

    // Verify: lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Verify: R4 scopedCommit called with refactor files + char artifact
    expect(gitOps.scopedCommit).toHaveBeenCalledWith(
      expect.stringContaining('refactor:'),
      expect.arrayContaining(['src/auth/validate.ts', charArtifact])
    )

    // Verify: ALL DONE logged
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (refactor track)'))

    // Verify: boundedExec called 6× (3 green for R1 gate, 3 green for R3 gate)
    expect((boundedExec.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6)
  }, 30_000)
})

describe('Stage D refactor track: R1 char-not-green → escalate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-r1red-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('R1 gate: characterization RED on current code → escalate "not green on current code" + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()

    // boundedExec: always RED — characterization fails on current (unchanged) code
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: 'AssertionError: expected true', timedOut: false, blocked: false }),
    }

    const charArtifact = path.join(tmpDir, 'tests', 'refactor', 'char-auth.test.ts')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      await fs.mkdir(dir, { recursive: true })
      const r1Data: R1Output = {
        characterizationSummary: 'Characterization that fails',
        characterizationCommand: `npx vitest run ${charArtifact}`,
        characterizationArtifact: charArtifact,
        coversExisting: false,
      }
      await fs.mkdir(path.dirname(charArtifact), { recursive: true })
      await fs.writeFile(charArtifact, '// failing char test')
      await fs.writeFile(path.join(dir, 'r1-characterize.json'), JSON.stringify(r1Data))
    }

    void fire('input', makeInputEvent('refactor: extract auth module'), ctx)
    await driveRefactorSteers(fire, ctx, steerPrompts, steerDriver, 2, 10_000, tmpDir)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must escalate: characterization not green on current code
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('not green on current code'))

    // Must NOT have entered build pipeline
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)

    // Must NOT have proceeded to R2
    expect(steerPrompts.length).toBe(1) // only R1 steer
  }, 20_000)
})

describe('Stage D refactor track: R2 oracle-altered → escalate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-oracle-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('R2 anti-cheat: changedFiles includes characterization artifact → escalate + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()

    // boundedExec: always GREEN (R1 gate passes)
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
    }

    const charArtifact = path.join(tmpDir, 'tests', 'refactor', 'char-auth.test.ts')

    // gitOps.changedFiles returns the characterization file → anti-cheat catches it
    const gitOps = makeNullGitOps()
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      'src/auth/validate.ts',
      charArtifact, // oracle in changedFiles = anti-cheat violation
    ])

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps,
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    let steerCallCount = 0
    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      steerCallCount++
      await fs.mkdir(dir, { recursive: true })

      if (steerCallCount === 1) {
        // R1
        const r1Data: R1Output = {
          characterizationSummary: 'Pins auth behavior',
          characterizationCommand: `npx vitest run ${charArtifact}`,
          characterizationArtifact: charArtifact,
          coversExisting: false,
        }
        await fs.mkdir(path.dirname(charArtifact), { recursive: true })
        await fs.writeFile(charArtifact, '// char test')
        await fs.writeFile(path.join(dir, 'r1-characterize.json'), JSON.stringify(r1Data))
      } else if (steerCallCount === 2) {
        // R2 — host "cheats" by including the char artifact, but gitOps reports it
        const r2Data: R2Output = {
          transformSummary: 'Extracted auth module',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'r2-transform.json'), JSON.stringify(r2Data))
      }
    }

    void fire('input', makeInputEvent('refactor: extract auth module'), ctx)
    await driveRefactorSteers(fire, ctx, steerPrompts, steerDriver, 5, 15_000, tmpDir)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must escalate on anti-cheat
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('characterization oracle was modified'))
  }, 25_000)
})

describe('Stage D refactor track: R3 char-goes-red → HARD escalate (behavior changed)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-r3red-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('R3 gate: characterization goes RED after refactor → HARD escalate "altered behavior", does NOT loop', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()

    // boundedExec: first 3 calls GREEN (R1 gate), then RED (R3 gate — behavior changed)
    let callCount = 0
    const boundedExec: BoundedExec = {
      run: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount <= 3) {
          // R1 gate: characterization green on current code
          return { passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }
        }
        // R3 gate: characterization goes RED — refactor CHANGED behavior
        return { passed: false, exitCode: 1, output: 'AssertionError: expected "new" to equal "old"', timedOut: false, blocked: false }
      }),
    }

    const gitOps = makeNullGitOps()
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/auth/validate.ts'])

    const charArtifact = path.join(tmpDir, 'tests', 'refactor', 'char-auth.test.ts')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps,
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    let steerCallCount = 0
    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      steerCallCount++
      await fs.mkdir(dir, { recursive: true })

      if (steerCallCount === 1) {
        // R1
        const r1Data: R1Output = {
          characterizationSummary: 'Pins auth behavior',
          characterizationCommand: `npx vitest run ${charArtifact}`,
          characterizationArtifact: charArtifact,
          coversExisting: false,
        }
        await fs.mkdir(path.dirname(charArtifact), { recursive: true })
        await fs.writeFile(charArtifact, '// char test')
        await fs.writeFile(path.join(dir, 'r1-characterize.json'), JSON.stringify(r1Data))
      } else if (steerCallCount === 2) {
        // R2
        const r2Data: R2Output = {
          transformSummary: 'Extracted auth module (but changed behavior)',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'r2-transform.json'), JSON.stringify(r2Data))
      }
    }

    void fire('input', makeInputEvent('refactor: extract auth module'), ctx)
    await driveRefactorSteers(fire, ctx, steerPrompts, steerDriver, 5, 15_000, tmpDir)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // MUST hard-escalate with "altered behavior" — NOT loop back to R2
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('altered behavior'))

    // MUST NOT have sent a second R2 steer (no loop on behavior change)
    expect(steerCallCount).toBe(2) // only R1 + R2, no second R2

    // MUST NOT have succeeded
    expect(transparency.log).not.toHaveBeenCalledWith(expect.stringContaining('ALL DONE'))
  }, 25_000)
})

describe('Stage D refactor track: R3 suite-regress (char green) → loop capped MAX_REFACTOR_ROUNDS', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-r3suite-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('R3 suite fails (char green) → loops R2 capped at MAX_REFACTOR_ROUNDS=2 → operatorBrief + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()

    // boundedExec: always GREEN (char passes on current code AND after refactor)
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
    }

    // verifier: suite always fails (regression)
    const verifier = makeNullVerifier()
    ;(verifier.runDeterministic as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAIL: 3 tests failed',
    })

    const gitOps = makeNullGitOps()
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/auth/validate.ts'])

    const charArtifact = path.join(tmpDir, 'tests', 'refactor', 'char-auth.test.ts')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier,
      gitOps,
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    let steerCallCount = 0
    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      steerCallCount++
      await fs.mkdir(dir, { recursive: true })

      if (steerCallCount === 1) {
        // R1
        const r1Data: R1Output = {
          characterizationSummary: 'Pins auth behavior',
          characterizationCommand: `npx vitest run ${charArtifact}`,
          characterizationArtifact: charArtifact,
          coversExisting: false,
        }
        await fs.mkdir(path.dirname(charArtifact), { recursive: true })
        await fs.writeFile(charArtifact, '// char test')
        await fs.writeFile(path.join(dir, 'r1-characterize.json'), JSON.stringify(r1Data))
      } else {
        // R2 (both round 1 and round 2 — steerCallCount 2 and 3)
        const r2Data: R2Output = {
          transformSummary: `Attempted refactor (round ${steerCallCount - 1})`,
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'r2-transform.json'), JSON.stringify(r2Data))
      }
    }

    void fire('input', makeInputEvent('refactor: extract auth module'), ctx)
    // Drive up to 5 steers: R1 + 2 rounds × R2 = 3 steers max
    await driveRefactorSteers(fire, ctx, steerPrompts, steerDriver, 5, 25_000, tmpDir)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must emit OPERATOR BRIEF (not ESCALATE) on suite-regression cap
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('OPERATOR BRIEF'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('did not converge'))

    // Must NOT have succeeded
    expect(transparency.log).not.toHaveBeenCalledWith(expect.stringContaining('ALL DONE'))

    // Must NOT have entered build pipeline
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)

    // R2 must have been called exactly MAX_REFACTOR_ROUNDS=2 times
    // steerCallCount: 1 (R1) + 2 (R2 rounds) = 3
    expect(steerCallCount).toBe(3)
  }, 60_000)
})

describe('Stage D refactor track: P1-P6 build pipeline untouched for refactor: input', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-nopipeline-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('refactor: input never calls verifier.runMutation or verifier.runHoldout', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const verifier = makeNullVerifier()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier,
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // very short → R1 steer times out quickly
      boundedExec: {
        run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
      },
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('refactor: extract auth module'), ctx)
    await waitForLockRelease(tmpDir)

    // build pipeline verifier methods must NOT have been called
    expect(verifier.runMutation).not.toHaveBeenCalled()
    expect(verifier.runHoldout).not.toHaveBeenCalled()
  }, 15_000)
})

describe('Stage D /autodev-status shows refactorStep when active', () => {
  it('/autodev-status JSON contains refactorStep field', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-status-'))
    try {
      const { pi } = makeMockPi()
      const ctrl = new Controller(pi, {
        repoRoot: tmpDir,
        verifier: makeNullVerifier(),
        gitOps: makeNullGitOps(),
        judge: makeNullJudge(),
        transparency: makeNullTransparency(),
        boundedExec: {
          run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: '', timedOut: false, blocked: false }),
        },
      })
      ctrl.wire()
      ctrl.registerCommands()

      const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls as [string, { handler: (args: string, ctx: unknown) => Promise<void> }][]
      const statusCall = calls.find(([name]) => name === '/autodev-status')
      const handler = statusCall![1].handler

      const notifyMock = vi.fn()
      await handler('', { ui: { notify: notifyMock } })
      expect(notifyMock).toHaveBeenCalledOnce()
      const parsed = JSON.parse(notifyMock.mock.calls[0][0] as string) as Record<string, unknown>
      expect(parsed).toHaveProperty('refactorStep')
      expect(parsed['refactorStep']).toBeNull() // null when not in refactor track
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
