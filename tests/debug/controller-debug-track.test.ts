// C-1 Group 4 integration tests: debug track D1→D5 via controller
//
// Strategy: mock pi + all dependencies (hostAgent via sendUserMessage intercept,
// boundedExec, verifier, gitOps, judge). B1 teardown-settle pattern (waitForLockRelease).
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
import type { D1Output, D2Output, D3Output } from '../../src/debug/debug-output.js'

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
    scopedCommit: vi.fn().mockResolvedValue({ sha: 'debugabc123' }),
    perPhasePush: vi.fn().mockResolvedValue(undefined),
    tierDGate: vi.fn().mockResolvedValue(true),
    scanSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
    changedFiles: vi.fn().mockResolvedValue([]),
  }
}

function makeNullJudge(): Judge {
  return {
    isDone: vi.fn().mockResolvedValue(true), // faithful by default
    isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
  }
}

// ── B1 teardown-settle helper ──────────────────────────────────────────────────

async function waitForLockRelease(tmpDir: string, timeoutMs = 20_000): Promise<void> {
  const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs

  // Phase 1: wait for lock to appear (run started).
  // Break early if lock never appears (run completed so fast it was never observed,
  // or run already completed before we started polling — both are valid "done" states).
  // Cap phase-1 at 2s so we don't block 20s waiting for a lock that won't come.
  const phase1Deadline = Math.min(deadline, Date.now() + 2_000)
  while (Date.now() < phase1Deadline) {
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

// ── Steer driver helper ────────────────────────────────────────────────────────
// Drives steer calls by writing the expected output file then firing agent_end.

type SteerDriver = (steerIndex: number, prompt: string, outputDir: string) => Promise<void>

async function driveDebugSteers(
  pi: ExtensionAPI,
  fire: (event: string, e: unknown, ctx?: unknown) => unknown,
  ctx: ExtensionContext,
  steerPrompts: string[],
  driver: SteerDriver,
  maxSteers = 8,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let driven = 0
  while (driven < maxSteers && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    if (steerPrompts.length > driven) {
      const prompt = steerPrompts[driven]
      driven++
      // driver writes the file, then we fire agent_end + turn_end
      // outputDir is embedded in the prompt as the file path
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

describe('C-1 debug track: happy path D1→D5→commit', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-happy-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: D1→D5 happy path: repro red×3 then fix then green×3 + suite green → commit', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'debug-output')

    // boundedExec: first 3 calls RED (D1 gate), next 3 calls GREEN (D4 gate)
    let boundedExecCallCount = 0
    const boundedExec: BoundedExec = {
      run: vi.fn(async () => {
        boundedExecCallCount++
        const isGreen = boundedExecCallCount > 3
        return { passed: isGreen, exitCode: isGreen ? 0 : 1, output: isGreen ? 'PASS' : 'AssertionError: expected true', timedOut: false, blocked: false }
      }),
    }

    const verifier = makeNullVerifier() // suite passes
    const gitOps = makeNullGitOps()
    // changedFiles returns the fix file (but NOT the repro) after D3
    let changedFilesCallCount = 0
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      changedFilesCallCount++
      return ['src/auth/validate.ts'] // fix file only, repro NOT included
    })

    const judge = makeNullJudge() // isDone=true → repro is faithful

    const reproArtifact = path.join(tmpDir, 'tests', 'debug', 'repro-auth.test.ts')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier,
      gitOps,
      judge,
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Steer driver: writes appropriate D-step output file for each steer
    const steerDriver: SteerDriver = async (idx, _prompt, dir) => {
      await fs.mkdir(dir, { recursive: true })

      if (idx === 0) {
        // D1 steer: write d1-reproduce.json + create the repro file
        const d1Data: D1Output = {
          reproSummary: 'Repro that fails on auth token validation',
          reproCommand: `npx vitest run ${reproArtifact}`,
          reproArtifact,
        }
        await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
        await fs.writeFile(reproArtifact, '// repro test\nimport { expect, it } from "vitest"\nit("fails", () => { expect(false).toBe(true) })')
        await fs.writeFile(path.join(dir, 'd1-reproduce.json'), JSON.stringify(d1Data))
      } else if (idx === 1) {
        // D2 steer: write d2-root-cause.json
        const d2Data: D2Output = {
          hypotheses: [
            { claim: 'Regex is wrong', evidenceFor: 'special chars rejected', evidenceAgainst: 'basic tokens pass' },
            { claim: 'TTL not checked', evidenceFor: 'no expiry', evidenceAgainst: 'fresh tokens work' },
          ],
          rootCause: 'Regex rejects valid special chars in tokens',
          rootCauseLocation: 'src/auth/validate.ts:23',
        }
        await fs.writeFile(path.join(dir, 'd2-root-cause.json'), JSON.stringify(d2Data))
      } else if (idx === 2) {
        // D3 steer: write d3-fix.json (does NOT touch repro file)
        const d3Data: D3Output = {
          fixSummary: 'Updated regex to allow special characters',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'd3-fix.json'), JSON.stringify(d3Data))
      }
      // D4 and D5 are deterministic gates (no steer), so no further steer files needed
    }

    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await driveDebugSteers(pi, fire, ctx, steerPrompts, steerDriver, 5, 15_000)
    await waitForLockRelease(tmpDir)

    // Verify: build pipeline NOT entered (no P1 DISCOVER steer)
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)

    // Verify: lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Verify: D5 scopedCommit called with fix + repro
    expect(gitOps.scopedCommit).toHaveBeenCalledWith(
      expect.stringContaining('Regex rejects valid special chars'),
      expect.arrayContaining(['src/auth/validate.ts', reproArtifact])
    )

    // Verify: ALL DONE logged
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (debug track)'))

    // Verify: boundedExec called 6× (3 red for D1, 3 green for D4)
    expect(boundedExecCallCount).toBe(6)
  }, 30_000)
})

describe('C-1 debug track: D1 no-repro (boundedExec green) → escalate + lock released', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-norepro-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('D1 gate: repro runs GREEN → operatorBrief + lock released (not ESCALATE)', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'debug-output')

    // boundedExec: always GREEN → repro is not red
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'PASS', timedOut: false, blocked: false }),
    }

    const reproArtifact = path.join(tmpDir, 'tests', 'debug', 'repro-auth.test.ts')

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
      const d1Data: D1Output = {
        reproSummary: 'Repro test',
        reproCommand: `npx vitest run ${reproArtifact}`,
        reproArtifact,
      }
      await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
      await fs.writeFile(reproArtifact, '// repro')
      await fs.writeFile(path.join(dir, 'd1-reproduce.json'), JSON.stringify(d1Data))
    }

    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await driveDebugSteers(pi, fire, ctx, steerPrompts, steerDriver, 2, 10_000)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must emit OPERATOR BRIEF (not consistently red)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('OPERATOR BRIEF'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('could not reproduce consistently'))

    // Must NOT have entered build pipeline
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)
  }, 20_000)
})

describe('C-1 debug track: D1 faithfulness-fail → escalate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-faith-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('D1 faithfulness: judge says not faithful → escalate + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'debug-output')

    // boundedExec: always RED → repro consistently fails (gate passes)
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: 'AssertionError: fail', timedOut: false, blocked: false }),
    }

    // judge: not faithful
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false), // repro does NOT demonstrate the bug
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }

    const reproArtifact = path.join(tmpDir, 'tests', 'debug', 'repro-auth.test.ts')

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge,
      transparency,
      steerTimeoutMs: 5_000,
      boundedExec,
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      await fs.mkdir(dir, { recursive: true })
      const d1Data: D1Output = {
        reproSummary: 'Repro test',
        reproCommand: `npx vitest run ${reproArtifact}`,
        reproArtifact,
      }
      await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
      await fs.writeFile(reproArtifact, '// repro')
      await fs.writeFile(path.join(dir, 'd1-reproduce.json'), JSON.stringify(d1Data))
    }

    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await driveDebugSteers(pi, fire, ctx, steerPrompts, steerDriver, 2, 10_000)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must escalate (faithfulness failed)
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('faithfulness'))
  }, 20_000)
})

describe('C-1 debug track: D3 repro-altered → escalate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-anticheat-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('D3 anti-cheat: changedFiles includes repro → escalate + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'debug-output')

    // boundedExec: RED for D1 gate
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: 'AssertionError: fail', timedOut: false, blocked: false }),
    }

    const reproArtifact = path.join(tmpDir, 'tests', 'debug', 'repro-auth.test.ts')

    // gitOps.changedFiles returns the repro file → anti-cheat catches it
    const gitOps = makeNullGitOps()
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      'src/auth/validate.ts',
      reproArtifact, // repro file in changedFiles = anti-cheat violation
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
        // D1
        const d1Data: D1Output = {
          reproSummary: 'Repro',
          reproCommand: `npx vitest run ${reproArtifact}`,
          reproArtifact,
        }
        await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
        await fs.writeFile(reproArtifact, '// repro')
        await fs.writeFile(path.join(dir, 'd1-reproduce.json'), JSON.stringify(d1Data))
      } else if (steerCallCount === 2) {
        // D2
        const d2Data: D2Output = {
          hypotheses: [
            { claim: 'H1', evidenceFor: 'e1', evidenceAgainst: 'a1' },
            { claim: 'H2', evidenceFor: 'e2', evidenceAgainst: 'a2' },
          ],
          rootCause: 'Root cause',
          rootCauseLocation: 'src/x.ts:1',
        }
        await fs.writeFile(path.join(dir, 'd2-root-cause.json'), JSON.stringify(d2Data))
      } else if (steerCallCount === 3) {
        // D3 — host "cheats" by including repro in changedFiles, but gitOps already reports it
        const d3Data: D3Output = {
          fixSummary: 'Fixed it',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'd3-fix.json'), JSON.stringify(d3Data))
      }
    }

    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await driveDebugSteers(pi, fire, ctx, steerPrompts, steerDriver, 5, 15_000)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must escalate on anti-cheat
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ESCALATE'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('repro was modified'))
  }, 25_000)
})

describe('C-1 debug track: D4 non-convergence → operatorBrief + lock released', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-d4fail-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('D4 stays RED after MAX_DEBUG_ROUNDS → operatorBrief + lock released', async () => {
    const { pi, fire, steerPrompts } = makeMockPi()
    const transparency = makeNullTransparency()
    const outputDir = path.join(tmpDir, '.autodev', 'debug-output')

    // boundedExec: ALWAYS RED — D1 gate passes (red consistently) but D4 never turns green
    const boundedExec: BoundedExec = {
      run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: 'AssertionError: still failing', timedOut: false, blocked: false }),
    }

    const reproArtifact = path.join(tmpDir, 'tests', 'debug', 'repro-auth.test.ts')

    // changedFiles: returns fix file (non-empty, repro not included) — anti-cheat passes
    const gitOps = makeNullGitOps()
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/auth/validate.ts'])

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

    // steer driver: handles D1, then repeating D2+D3 for each round (MAX_DEBUG_ROUNDS=3)
    let steerCallCount = 0
    const steerDriver: SteerDriver = async (_idx, _prompt, dir) => {
      steerCallCount++
      await fs.mkdir(dir, { recursive: true })

      if (steerCallCount === 1) {
        // D1
        const d1Data: D1Output = {
          reproSummary: 'Repro',
          reproCommand: `npx vitest run ${reproArtifact}`,
          reproArtifact,
        }
        await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
        await fs.writeFile(reproArtifact, '// repro')
        await fs.writeFile(path.join(dir, 'd1-reproduce.json'), JSON.stringify(d1Data))
      } else if (steerCallCount % 2 === 0) {
        // D2 (even steers after D1: 2, 4, 6)
        const d2Data: D2Output = {
          hypotheses: [
            { claim: 'H1', evidenceFor: 'e1', evidenceAgainst: 'a1' },
            { claim: 'H2', evidenceFor: 'e2', evidenceAgainst: 'a2' },
          ],
          rootCause: 'Root cause',
          rootCauseLocation: 'src/x.ts:1',
        }
        await fs.writeFile(path.join(dir, 'd2-root-cause.json'), JSON.stringify(d2Data))
      } else {
        // D3 (odd steers after D1: 3, 5, 7)
        const d3Data: D3Output = {
          fixSummary: 'Attempted fix',
          filesChanged: ['src/auth/validate.ts'],
        }
        await fs.writeFile(path.join(dir, 'd3-fix.json'), JSON.stringify(d3Data))
      }
    }

    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    // Drive up to 8 steers: D1 + 3 rounds × (D2 + D3) = 7 steers max
    await driveDebugSteers(pi, fire, ctx, steerPrompts, steerDriver, 8, 25_000)
    await waitForLockRelease(tmpDir)

    // Lock released
    const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // Must emit OPERATOR BRIEF (not ESCALATE) on D4 cap
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('OPERATOR BRIEF'))
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('did not converge'))

    // Must NOT have entered build pipeline
    expect(steerPrompts.some(p => p.includes('P1 DISCOVER'))).toBe(false)
  }, 60_000)
})

describe('C-1 debug track: P1-P6 build pipeline untouched for debug: input', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-nopipeline-'))
  })

  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: input never calls verifier.runDeterministic or verifier.runMutation', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const verifier = makeNullVerifier()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier,
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 50, // very short → D1 steer times out quickly
      boundedExec: {
        run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: '', timedOut: false, blocked: false }),
      },
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('debug: tests fail in the auth module'), ctx)
    await waitForLockRelease(tmpDir)

    // build pipeline verifier methods must NOT have been called (P5 uses runMutation/runHoldout)
    expect(verifier.runMutation).not.toHaveBeenCalled()
    expect(verifier.runHoldout).not.toHaveBeenCalled()
    // runDeterministic may be called by D4 but NOT by P5 (and D4 is never reached here)
    // Since D1 steer times out before D4, runDeterministic should not be called at all
    expect(verifier.runDeterministic).not.toHaveBeenCalled()
  }, 15_000)
})

describe('C-1 /autodev-status shows debugStep when active', () => {
  it('/autodev-status JSON contains debugStep field', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-status-'))
    try {
      const { pi } = makeMockPi()
      const ctrl = new Controller(pi, {
        repoRoot: tmpDir,
        verifier: makeNullVerifier(),
        gitOps: makeNullGitOps(),
        judge: makeNullJudge(),
        transparency: makeNullTransparency(),
        boundedExec: {
          run: vi.fn().mockResolvedValue({ passed: false, exitCode: 1, output: '', timedOut: false, blocked: false }),
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
      expect(parsed).toHaveProperty('debugStep')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
