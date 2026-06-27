// Architectural coverage for the project-resolver chdir + full backend re-root.
//
// Before this fix _resolveRepoRoot re-rooted only repoRoot/outputDir/journal/
// actionMonitor/pauseFilePath/subagentDriver. The host's bash/npm/git stayed on
// the original process.cwd(), and construction-captured backends (GitOps,
// CodebaseMemory, Transparency) kept targeting the old cwd. This suite asserts:
//   1. registry path: process.chdir(r.dir) happens, and GitOps/CodebaseMemory/
//      Transparency are all re-rooted to r.dir (observed via setRepoRoot spies
//      that snapshot process.cwd() at call time → proves chdir ran first).
//   2. cwd is restored when the run terminates (halt/escalate path here).
//   3. NO-registry path does NOT chdir — existing behavior preserved.

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
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'
import { ProjectRegistry } from '../../src/project/registry.js'

// ── Mock factories ─────────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown

function makeMockPi(): {
  pi: ExtensionAPI
  fire(event: string, e: unknown, ctx?: unknown): unknown
} {
  const handlers: Record<string, EventHandler> = {}
  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => { handlers[event] = handler }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI
  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) => handlers[event]?.(e, ctx)
  return { pi, fire }
}

function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
  } as unknown as ExtensionContext
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

function makeController(pi: ExtensionAPI, opts: Partial<ControllerOptions> & { repoRoot: string }): Controller {
  return new Controller(pi, {
    verifier: makeNullVerifier(),
    gitOps: makeNullGitOps(),
    judge: makeNullJudge(),
    transparency: makeNullTransparency(),
    // Short steer timeout: P1 fails fast → _escalate → _restoreCwd, so the run
    // terminates quickly and we can assert cwd restoration without a real host.
    steerTimeoutMs: 80,
    ...opts,
  })
}

function makeInputEvent(text: string): InputEvent {
  return { type: 'input', text, source: 'interactive' } as InputEvent
}
function makeSessionStartEvent(): SessionStartEvent {
  return { type: 'session_start' } as unknown as SessionStartEvent
}

// Captured once at module load — a stable dir that is never deleted by a test's
// afterEach. Used as the safe chdir target so cleanup never leaves the process
// sitting in a just-removed temp dir (which makes a later process.cwd() throw).
const SAFE_CWD = process.cwd()

/** Poll until process.cwd() equals target (i.e. _restoreCwd has run) or timeout. */
async function waitForCwd(target: string, tries = 60, gapMs = 25): Promise<void> {
  for (let i = 0; i < tries; i++) {
    let cur: string | undefined
    try { cur = process.cwd() } catch { cur = undefined }
    if (cur === target) return
    await new Promise(r => setTimeout(r, gapMs))
  }
}

/**
 * Cleanup helper that defeats the fire-and-forget _runPhases/_restoreCwd race:
 * the controller's lingering restore can chdir AFTER the test body returns. We
 * grace-wait, then repeatedly force cwd back to SAFE_CWD until it stays put
 * across two consecutive reads, so removing the temp tree never strands the
 * process in a just-deleted dir (which would make the next process.cwd() throw).
 */
async function settleCwdToSafe(): Promise<void> {
  await new Promise(r => setTimeout(r, 200)) // let any lingering _restoreCwd fire
  for (let i = 0; i < 40; i++) {
    process.chdir(SAFE_CWD)
    await new Promise(r => setTimeout(r, 25))
    let cur: string | undefined
    try { cur = process.cwd() } catch { cur = undefined }
    if (cur === SAFE_CWD) return
  }
  process.chdir(SAFE_CWD)
}

/** A re-root spy: records the dir passed AND the live process.cwd() at call time. */
interface RerootSpy {
  calls: Array<{ dir: string; cwdAtCall: string }>
  setRepoRoot(dir: string): void
}
function makeRerootSpy(): RerootSpy {
  const calls: Array<{ dir: string; cwdAtCall: string }> = []
  return { calls, setRepoRoot(dir: string) { calls.push({ dir, cwdAtCall: process.cwd() }) } }
}

/**
 * Transparency double whose `log` resolves a "terminated" promise when the run
 * reaches a terminal line (ESCALATE / ALL DONE). The async _runPhases() is
 * fire-and-forget (void), so a test MUST await this before returning — otherwise
 * the lingering run's _restoreCwd fires after the test ends and clobbers the cwd
 * of the next test (global process.cwd() is shared within a file).
 */
function makeAwaitableTransparency(): Transparency & { terminated: Promise<void> } {
  let resolveTerminated!: () => void
  const terminated = new Promise<void>((res) => { resolveTerminated = res })
  const log = vi.fn((line: string) => {
    if (/ESCALATE|ALL DONE/.test(line)) resolveTerminated()
    return Promise.resolve()
  })
  return {
    log,
    appendEntry: vi.fn().mockResolvedValue(undefined),
    setHudStatus: vi.fn(),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    terminated,
  }
}

// ── Test 1: registry path chdir's + re-roots all backends ──────────────────────

describe('Controller _resolveRepoRoot: chdir + full backend re-root (registry path)', () => {
  let tmpDir: string
  let resolvedDir: string
  let registryDir: string
  let origCwd: string

  beforeEach(async () => {
    origCwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chdir-reroot-'))
    resolvedDir = await fs.realpath(await fs.mkdtemp(path.join(tmpDir, 'resolved-')))
    registryDir = path.join(tmpDir, 'registry')
  })

  afterEach(async () => {
    // settleCwdToSafe grace-waits for any lingering _restoreCwd, then pins cwd to
    // SAFE_CWD, so removing tmpDir below can't strand the process in a removed dir.
    await settleCwdToSafe()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('chdir into resolved dir and re-roots GitOps + CodebaseMemory + Transparency', async () => {
    const registry = new ProjectRegistry(registryDir)
    await registry.register('reroot-project', resolvedDir)
    process.chdir(resolvedDir) // step-1 findByDir hits resolvedDir

    // Re-rootable backends: GitOps + Transparency carry setRepoRoot spies; CodebaseMemory too.
    const gitSpy = makeRerootSpy()
    const gitOps = Object.assign(makeNullGitOps(), { setRepoRoot: gitSpy.setRepoRoot.bind(gitSpy) })
    const transpSpy = makeRerootSpy()
    const transparency = Object.assign(makeAwaitableTransparency(), { setRepoRoot: transpSpy.setRepoRoot.bind(transpSpy) })
    const cbSpy = makeRerootSpy()
    const setRepoRootOrder: string[] = []
    const ensureIndexed = vi.fn().mockResolvedValue(undefined)
    const codebaseMemory = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
      ensureIndexed,
      setRepoRoot: (dir: string) => { setRepoRootOrder.push('setRepoRoot'); cbSpy.setRepoRoot(dir) },
    }

    let cwdDuringRun: string | undefined
    // Capture cwd at the moment ensureIndexed runs (inside _resolveRepoRoot, after chdir).
    ensureIndexed.mockImplementation(async () => { setRepoRootOrder.push('ensureIndexed'); cwdDuringRun = process.cwd() })

    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry, gitOps, transparency, codebaseMemory })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Add a re-root feature to the resolved project'), ctx)

    // Wait until ensureIndexed (and thus the chdir + re-root) has run.
    for (let i = 0; i < 40 && cwdDuringRun === undefined; i++) {
      await new Promise(r => setTimeout(r, 25))
    }

    // 1. chdir happened: cwd during the run == resolvedDir
    expect(cwdDuringRun).toBe(resolvedDir)

    // 2. All three construction-captured backends were re-rooted to resolvedDir,
    //    and each saw process.cwd() === resolvedDir at call time (chdir ran first).
    expect(gitSpy.calls.length).toBeGreaterThan(0)
    expect(gitSpy.calls[0]?.dir).toBe(resolvedDir)
    expect(gitSpy.calls[0]?.cwdAtCall).toBe(resolvedDir)

    expect(transpSpy.calls.length).toBeGreaterThan(0)
    expect(transpSpy.calls[0]?.dir).toBe(resolvedDir)
    expect(transpSpy.calls[0]?.cwdAtCall).toBe(resolvedDir)

    expect(cbSpy.calls.length).toBeGreaterThan(0)
    expect(cbSpy.calls[0]?.dir).toBe(resolvedDir)

    // 3. codebaseMemory.setRepoRoot was called BEFORE ensureIndexed (reset cache first).
    expect(ensureIndexed).toHaveBeenCalled()
    expect(setRepoRootOrder).toEqual(['setRepoRoot', 'ensureIndexed'])

    // Await run termination so the lingering async _runPhases/_restoreCwd does not
    // outlive this test and clobber the cwd of the next test. terminated resolves
    // on the ESCALATE log; _restoreCwd runs just after, so also wait for cwd to
    // settle back to where this test started (resolvedDir).
    await transparency.terminated
    await waitForCwd(resolvedDir)
  }, 10_000)

  it('restores process.cwd() after the run terminates (halt path)', async () => {
    const registry = new ProjectRegistry(registryDir)
    await registry.register('restore-project', resolvedDir)
    process.chdir(resolvedDir)
    const cwdBeforeInput = process.cwd() // == resolvedDir

    const transparency = makeAwaitableTransparency()
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry, transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a thing that fails fast in P1 for restore test'), ctx)

    // Wait for the terminal ESCALATE log, then for _restoreCwd to run (it fires
    // after lifecycle.release(), slightly after the ESCALATE log). Poll briefly.
    await transparency.terminated
    let restored = false
    for (let i = 0; i < 40; i++) {
      if (process.cwd() === cwdBeforeInput) { restored = true; break }
      await new Promise(r => setTimeout(r, 25))
    }
    expect(restored).toBe(true)
    expect(process.cwd()).toBe(resolvedDir)
  }, 10_000)
})

// ── Test 2: no-registry path does NOT chdir ────────────────────────────────────

describe('Controller _resolveRepoRoot: no-registry path does NOT chdir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-reg-chdir-'))
  })

  afterEach(async () => {
    await settleCwdToSafe()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('cwd is unchanged across an idea input when no registry is injected', async () => {
    // Run from a stable, non-temp cwd (origCwd) so the assertion is unambiguous.
    const cwdBefore = process.cwd()

    const transparency = makeAwaitableTransparency()
    const { pi, fire } = makeMockPi()
    // No registry → _resolveRepoRoot is a no-op, must NOT chdir.
    const ctrl = makeController(pi, { repoRoot: tmpDir, transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a simple REST API server no registry'), ctx)

    // Give the run time to start + fail fast. cwd must never move.
    for (let i = 0; i < 20; i++) {
      expect(process.cwd()).toBe(cwdBefore)
      await new Promise(r => setTimeout(r, 25))
    }
    // Await termination so the run settles before afterEach cleanup.
    await transparency.terminated
    expect(process.cwd()).toBe(cwdBefore)
  }, 10_000)
})
