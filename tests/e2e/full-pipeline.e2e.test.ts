// E2E test harness: proves the WHOLE pipeline wires together.
//
// Drives the REAL Controller + REAL phase/track classes + REAL engine
// (FSM, sizing, lifecycle, action-monitor, partitioner) with ONLY the
// host LLM stubbed via StubHost.
//
// Scenarios:
//   1. Full build pipeline (no prefix): idea → P1→P6, all 6 output files exist+valid,
//      commit made, lock released.
//   2. Quick gear (quick:): seed→P4→P5→P6, P1/P2/P3 ceremony NOT steered, commit made.
//   3. Debug track (debug:): D1→D5 happy path, P1-P6 NOT entered, commit made.
//   4. Self-steer isolation: source=extension input ignored, no run starts.
//   5. Middle gear (mid:): P1→P3→P4→P5→P6, P2 skipped.
//   6. Phase chaining: P3 prompt contains P1 spec; P4 prompt contains P3 goal.
//   7. Concurrent input rejected (lifecycle lock).
//
// Key patterns:
//   - B1 teardown-settle: waitForLockRelease (appear→disappear) before rm
//   - stub.steeredPrompts: prompts recorded inside StubHost.install() impl
//   - Temp git repo per test (real gitOps requires .git)
//   - reject-loud: assertions after waitForLockRelease, never resolve-on-timeout

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { Controller } from '../../src/host/controller.js'
import type { ControllerOptions } from '../../src/host/controller.js'
import type { ExtensionContext, AgentEndEvent, TurnEndEvent } from '@earendil-works/pi-coding-agent'
import type { BoundedExec } from '../../src/ports.js'
import type { D1Output, D2Output, D3Output } from '../../src/debug/debug-output.js'

import {
  StubHost,
  makeMockPi,
  makeExtCtx,
  makeInputEvent,
  makeSessionStartEvent,
  makeNullTransparency,
  makeNullVerifier,
  makeNullJudge,
  makeNullGitOps,
  waitForLockRelease,
  CANNED_P1,
  CANNED_P3,
  CANNED_P4,
} from './stub-host.js'

const execFileAsync = promisify(execFile)

// ── Git repo init helper ──────────────────────────────────────────────────────

async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'e2e@pi-autodev.test'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'pi-autodev-e2e'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'README.md'), '# e2e test repo\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'chore: init'], { cwd: dir })
}

// ── Controller factory ────────────────────────────────────────────────────────

function makeCtrl(
  pi: ReturnType<typeof makeMockPi>['pi'],
  repoDir: string,
  overrides: Partial<ControllerOptions> = {}
): Controller {
  return new Controller(pi, {
    repoRoot: repoDir,
    verifier: makeNullVerifier(),
    gitOps: makeNullGitOps(),
    judge: makeNullJudge(),
    transparency: makeNullTransparency(),
    steerTimeoutMs: 8_000,
    ...overrides,
  })
}

// ── Phase file helpers ────────────────────────────────────────────────────────

async function phaseFileExists(outputDir: string, filename: string): Promise<boolean> {
  return fs.access(path.join(outputDir, filename)).then(() => true).catch(() => false)
}

async function readPhaseFile(outputDir: string, filename: string): Promise<unknown> {
  const content = await fs.readFile(path.join(outputDir, filename), 'utf-8')
  return JSON.parse(content)
}

// ── inline event factories (avoid import duplication) ────────────────────────

function makeTurnEndEvent(): TurnEndEvent {
  return {
    type: 'turn_end', turnIndex: 0,
    message: { role: 'assistant', content: [] }, toolResults: [],
  } as unknown as TurnEndEvent
}

function makeAgentEndEvent(text = 'done'): AgentEndEvent {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
  } as unknown as AgentEndEvent
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 1: Full build pipeline — no prefix → P1→P6
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 1: Full build pipeline P1→P6', () => {
  let tmpDir: string
  let repoDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-full-'))
    repoDir = path.join(tmpDir, 'repo')
    outputDir = path.join(repoDir, '.autodev', 'phase-output')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 15_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('idea → REAL P1→P6: all 6 phase-output files exist+valid, commit made, lock released', async () => {
    const { pi, fire } = makeMockPi()
    const gitOps = makeNullGitOps()
    const transparency = makeNullTransparency()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir, { gitOps, transparency })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('Add a greet(name) function to src/utils.ts that returns Hello name'), ctx)

    await waitForLockRelease(repoDir, 20_000)

    // ── Assert: all 6 phase-output files exist ────────────────────────────────
    expect(await phaseFileExists(outputDir, 'p1-spec.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p2-domain.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p3-plan.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p4-build.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p5-verify.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p6-release.json')).toBe(true)

    // ── Assert: P1 output is valid ────────────────────────────────────────────
    const p1 = await readPhaseFile(outputDir, 'p1-spec.json') as typeof CANNED_P1
    expect(p1.phase).toBe('P1')
    expect(p1.spec.length).toBeGreaterThanOrEqual(20)
    expect(p1.stackAdr.length).toBeGreaterThanOrEqual(10)

    // ── Assert: P3 output is valid ────────────────────────────────────────────
    const p3 = await readPhaseFile(outputDir, 'p3-plan.json') as typeof CANNED_P3
    expect(p3.phase).toBe('P3')
    expect(p3.fileDAG.length).toBeGreaterThanOrEqual(1)
    expect(p3.sprintContract.goal.length).toBeGreaterThanOrEqual(10)
    expect(p3.examplesTable.length).toBeGreaterThanOrEqual(1)

    // ── Assert: P6 output has commit sha ─────────────────────────────────────
    const p6 = await readPhaseFile(outputDir, 'p6-release.json') as { phase: string; commitSha: string; pushResult: string }
    expect(p6.phase).toBe('P6')
    expect(p6.commitSha.length).toBeGreaterThan(0)

    // ── Assert: scopedCommit called (P6 ran gitOps) ───────────────────────────
    expect(gitOps.scopedCommit).toHaveBeenCalled()

    // ── Assert: lock released ─────────────────────────────────────────────────
    const lockPath = path.join(repoDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // ── Assert: ALL DONE logged ───────────────────────────────────────────────
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE'))

    // ── Assert: 6 steers (one per phase P1..P6) ───────────────────────────────
    expect(stub.steeredPrompts.length).toBeGreaterThanOrEqual(6)

    // ── Assert: all 6 phase steer prompts contain expected role headers ────────
    expect(stub.steeredPrompts.some(p => p.includes('Discovery Agent (P1)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Elaboration Agent (P2)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Planning Agent (P3)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Build Agent (P4)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Verifier Agent (P5)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Release Agent (P6)'))).toBe(true)
  }, 40_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 2: Quick gear — seed→P4→P5→P6, P1/P2/P3 skipped
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 2: Quick gear (quick: prefix)', () => {
  let tmpDir: string
  let repoDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-quick-'))
    repoDir = path.join(tmpDir, 'repo')
    outputDir = path.join(repoDir, '.autodev', 'phase-output')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 15_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('quick: prefix → seed→P4→P5→P6; P1/P2/P3 NOT steered; commit made; lock released', async () => {
    const { pi, fire } = makeMockPi()
    const gitOps = makeNullGitOps()
    const transparency = makeNullTransparency()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir, { gitOps, transparency })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('quick: add greet(name) function to src/utils.ts'), ctx)

    await waitForLockRelease(repoDir, 20_000)

    // ── Assert: P1/P2/P3 discovery NOT steered ───────────────────────────────
    expect(stub.steeredPrompts.some(p => p.includes('Discovery Agent (P1)'))).toBe(false)
    expect(stub.steeredPrompts.some(p => p.includes('Elaboration Agent (P2)'))).toBe(false)
    expect(stub.steeredPrompts.some(p => p.includes('Planning Agent (P3)'))).toBe(false)

    // ── Assert: seed steer WAS fired (contains 'quick' or 'seed') ────────────
    expect(stub.steeredPrompts.some(p =>
      p.toLowerCase().includes('quick') || p.toLowerCase().includes('seed')
    )).toBe(true)

    // ── Assert: P4/P5/P6 steered ─────────────────────────────────────────────
    expect(stub.steeredPrompts.some(p => p.includes('Build Agent (P4)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Verifier Agent (P5)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Release Agent (P6)'))).toBe(true)

    // ── Assert: commit made ───────────────────────────────────────────────────
    expect(gitOps.scopedCommit).toHaveBeenCalled()

    // ── Assert: lock released ─────────────────────────────────────────────────
    const lockPath = path.join(repoDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // ── Assert: ALL DONE (quick gear) logged ─────────────────────────────────
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (quick gear)'))

    // ── Assert: p4/p5/p6 output files exist ──────────────────────────────────
    expect(await phaseFileExists(outputDir, 'p4-build.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p5-verify.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p6-release.json')).toBe(true)
  }, 40_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 3: Debug track — D1→D5, P1-P6 NOT entered
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 3: Debug track (debug: prefix)', () => {
  let tmpDir: string
  let repoDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-debug-'))
    repoDir = path.join(tmpDir, 'repo')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 20_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('debug: → D1→D5 happy path; P1-P6 NOT entered; commit made; lock released', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const gitOps = makeNullGitOps()
    const ctx = makeExtCtx()

    const reproArtifact = path.join(repoDir, 'tests', 'debug', 'repro-auth.test.ts')
    const allSteeredPrompts: string[] = []

    // boundedExec: first 3 calls RED (D1), next 3 GREEN (D4)
    let beCallCount = 0
    const boundedExec: BoundedExec = {
      run: vi.fn(async () => {
        beCallCount++
        const isGreen = beCallCount > 3
        return { passed: isGreen, exitCode: isGreen ? 0 : 1, output: isGreen ? 'PASS' : 'AssertionError: fail', timedOut: false, blocked: false }
      }),
    }

    // changedFiles: fix file only (not repro) → anti-cheat passes
    ;(gitOps.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/auth/validate.ts'])

    const ctrl = makeCtrl(pi, repoDir, { transparency, gitOps, boundedExec, steerTimeoutMs: 8_000 })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Debug stub: writes D1/D2/D3 output files on each steer
    let debugSteerCount = 0
    ;(pi.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string) => {
      debugSteerCount++
      allSteeredPrompts.push(prompt)

      const m = prompt.match(/Write your result as valid JSON to:\s*(\S+)/)
      const outFile = m?.[1]?.trim()

      if (outFile) {
        await fs.mkdir(path.dirname(outFile), { recursive: true })

        if (debugSteerCount === 1) {
          // D1: write d1-reproduce.json + create repro artifact
          const d1: D1Output = {
            reproSummary: 'Repro that fails on auth token validation — regex rejects valid special chars',
            reproCommand: `npx vitest run ${reproArtifact}`,
            reproArtifact,
          }
          await fs.mkdir(path.dirname(reproArtifact), { recursive: true })
          await fs.writeFile(reproArtifact, '// repro\nimport { expect, it } from "vitest"\nit("fails", () => { expect(false).toBe(true) })')
          await fs.writeFile(outFile, JSON.stringify(d1))
        } else if (debugSteerCount === 2) {
          // D2: write d2-root-cause.json
          const d2: D2Output = {
            hypotheses: [
              { claim: 'Regex rejects valid special chars', evidenceFor: 'chars rejected', evidenceAgainst: 'basic tokens pass' },
              { claim: 'TTL missing', evidenceFor: 'no expiry logic', evidenceAgainst: 'fresh tokens pass' },
            ],
            rootCause: 'Regex pattern rejects valid special characters in auth tokens',
            rootCauseLocation: 'src/auth/validate.ts:23',
          }
          await fs.writeFile(outFile, JSON.stringify(d2))
        } else if (debugSteerCount === 3) {
          // D3: write d3-fix.json
          const d3: D3Output = {
            fixSummary: 'Updated regex to allow special characters in token validation',
            filesChanged: ['src/auth/validate.ts'],
          }
          await fs.writeFile(outFile, JSON.stringify(d3))
        }
      }

      await new Promise(r => setImmediate(r))
      fire('turn_end', makeTurnEndEvent(), ctx)
      fire('agent_end', makeAgentEndEvent(`debug stub steer ${debugSteerCount}`), ctx)
    })

    void fire('input', makeInputEvent('debug: auth module tests fail on token validation'), ctx)

    await waitForLockRelease(repoDir, 30_000)

    // ── Assert: build pipeline P1-P6 NOT entered ──────────────────────────────
    expect(allSteeredPrompts.some(p =>
      p.includes('Discovery Agent (P1)') || p.includes('P1 DISCOVER')
    )).toBe(false)

    // ── Assert: lock released ─────────────────────────────────────────────────
    const lockPath = path.join(repoDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // ── Assert: D5 scopedCommit called with fix + repro ───────────────────────
    expect(gitOps.scopedCommit).toHaveBeenCalledWith(
      expect.stringContaining('Regex pattern rejects valid special characters'),
      expect.arrayContaining(['src/auth/validate.ts', reproArtifact])
    )

    // ── Assert: ALL DONE (debug track) logged ─────────────────────────────────
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (debug track)'))

    // ── Assert: boundedExec called 6× (3 red D1, 3 green D4) ─────────────────
    expect(beCallCount).toBe(6)
  }, 50_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 4: Self-steer isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 4: Self-steer isolation', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-selfsteer-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('input source=extension is ignored — no run starts, no steer fired', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctx = makeExtCtx()

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency,
      steerTimeoutMs: 100, // very short
    })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Fire an extension self-steer (pi echoes sendUserMessage back with source=extension)
    await fire('input', makeInputEvent(
      '## Role: Discovery Agent (P1) You are the P1 DISCOVER phase — analyse the idea.',
      'extension'
    ), ctx)
    await new Promise(r => setImmediate(r))

    // Must be filtered
    expect(transparency.log).toHaveBeenCalledWith('input ignored (self-steer, source=extension)')
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith('autodev', 'RUNNING')
    expect(pi.sendUserMessage).not.toHaveBeenCalled()

    // A second extension input also ignored
    await fire('input', makeInputEvent('## Role: Build Agent (P4) Implement.', 'extension'), ctx)
    await new Promise(r => setImmediate(r))
    expect(pi.sendUserMessage).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 5: Middle gear — P1→P3→P4→P5→P6, P2 skipped
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 5: Middle gear (mid: prefix)', () => {
  let tmpDir: string
  let repoDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-mid-'))
    repoDir = path.join(tmpDir, 'repo')
    outputDir = path.join(repoDir, '.autodev', 'phase-output')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 15_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('mid: → P1→P3→P4→P5→P6; P2 NOT steered; commit made; lock released', async () => {
    const { pi, fire } = makeMockPi()
    const gitOps = makeNullGitOps()
    const transparency = makeNullTransparency()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir, { gitOps, transparency })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('mid: add greet(name) function to src/utils.ts'), ctx)

    await waitForLockRelease(repoDir, 20_000)

    // ── Assert: P2 NOT steered ────────────────────────────────────────────────
    expect(stub.steeredPrompts.some(p => p.includes('Elaboration Agent (P2)'))).toBe(false)

    // ── Assert: P1, P3, P4, P5, P6 WERE steered ──────────────────────────────
    expect(stub.steeredPrompts.some(p => p.includes('Discovery Agent (P1)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Planning Agent (P3)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Build Agent (P4)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Verifier Agent (P5)'))).toBe(true)
    expect(stub.steeredPrompts.some(p => p.includes('Release Agent (P6)'))).toBe(true)

    // ── Assert: commit made ───────────────────────────────────────────────────
    expect(gitOps.scopedCommit).toHaveBeenCalled()

    // ── Assert: lock released ─────────────────────────────────────────────────
    const lockPath = path.join(repoDir, '.autodev', 'running.lock')
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false)

    // ── Assert: ALL DONE (middle gear) logged ─────────────────────────────────
    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ALL DONE (middle gear)'))

    // ── Assert: P1/P3/P4/P5/P6 files exist; P2 file NOT written by host ───────
    expect(await phaseFileExists(outputDir, 'p1-spec.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p3-plan.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p4-build.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p5-verify.json')).toBe(true)
    expect(await phaseFileExists(outputDir, 'p6-release.json')).toBe(true)
    // p2-domain.json is NOT written (middle gear synthesises P2 internally)
    expect(await phaseFileExists(outputDir, 'p2-domain.json')).toBe(false)
  }, 40_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 6: Phase output chaining
// Proves P1 spec feeds P3, P3 goal feeds P4, P4 artifacts feed P5
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 6: Phase output chaining', () => {
  let tmpDir: string
  let repoDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-chain-'))
    repoDir = path.join(tmpDir, 'repo')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 15_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('P3 steer prompt contains P1 spec content (P1→P3 chaining)', async () => {
    const { pi, fire } = makeMockPi()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir)
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('Add a greet(name) function to src/utils.ts that returns Hello name'), ctx)
    await waitForLockRelease(repoDir, 20_000)

    const p3Prompt = stub.steeredPrompts.find(p => p.includes('Planning Agent (P3)'))
    expect(p3Prompt).toBeDefined()
    // P3 instruction injects p1.spec — check first 40 chars
    expect(p3Prompt).toContain(CANNED_P1.spec.slice(0, 40))
  }, 40_000)

  it('P4 steer prompt contains P3 sprint goal (P3→P4 chaining)', async () => {
    const { pi, fire } = makeMockPi()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir)
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('Add a greet(name) function to src/utils.ts that returns Hello name'), ctx)
    await waitForLockRelease(repoDir, 20_000)

    const p4Prompt = stub.steeredPrompts.find(p => p.includes('Build Agent (P4)'))
    expect(p4Prompt).toBeDefined()
    // P4 instruction injects p3.sprintContract.goal
    expect(p4Prompt).toContain(CANNED_P3.sprintContract.goal.slice(0, 30))
  }, 40_000)

  it('P5 steer prompt contains P4 artifact path (P4→P5 chaining)', async () => {
    const { pi, fire } = makeMockPi()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir)
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    const stub = new StubHost()
    stub.install(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }, fire, ctx)

    void fire('input', makeInputEvent('Add a greet(name) function to src/utils.ts that returns Hello name'), ctx)
    await waitForLockRelease(repoDir, 20_000)

    const p5Prompt = stub.steeredPrompts.find(p => p.includes('Verifier Agent (P5)'))
    expect(p5Prompt).toBeDefined()
    // P5 instruction injects p4.artifacts
    expect(p5Prompt).toContain(CANNED_P4.artifacts[0])
  }, 40_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 7: Concurrent input rejected
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Scenario 7: Concurrent input rejected (lifecycle lock)', () => {
  let tmpDir: string
  let repoDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-lock-'))
    repoDir = path.join(tmpDir, 'repo')
    await initGitRepo(repoDir)
  })

  afterEach(async () => {
    await waitForLockRelease(repoDir, 10_000)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('second interactive input while run active → lock denied, warning shown', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctx = makeExtCtx()

    const ctrl = makeCtrl(pi, repoDir, {
      transparency,
      steerTimeoutMs: 200, // very short so the steer times out quickly → run fails → lock released
    })
    ctrl.wire()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // First run: no stub → steer times out → escalates → releases lock
    void fire('input', makeInputEvent('Add a greet(name) function'), ctx)

    // Give lifecycle a tick to acquire the lock synchronously
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 20))

    // Fire second input while first holds the lock
    void fire('input', makeInputEvent('Another idea that should be rejected'), ctx)
    await new Promise(r => setImmediate(r))

    // Second input must be rejected with warning
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Cannot start'),
      'warning'
    )
  }, 20_000)
})
