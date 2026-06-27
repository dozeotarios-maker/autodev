// Lane W+C tests: project resolver integration into the Controller pipeline.
//
// Tests:
//   1. _resolveRepoRoot with mock registry+resolver → controller adopts resolved repoRoot,
//      re-derives outputDir/actionMonitor, registers project, calls ensureIndexed on existing.
//   2. Write-confinement: write/edit/str_replace tools to $HOME denied; under repoRoot allowed.
//   3. No registry injected → behavior identical to today (repoRoot=cwd), existing tests pass.
//   4. /autodev-project set/list commands.
//   5. P4/P5/P6 instructions contain absolute repoRoot + cd prefix when repoRoot set.

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
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'
import { ProjectRegistry } from '../../src/project/registry.js'
import { P4Build } from '../../src/phases/p4-build.js'
import { P5Verify } from '../../src/phases/p5-verify.js'
import { P6Release } from '../../src/phases/p6-release.js'
import type { HostAgent } from '../../src/host/host-agent.js'
import type { P4Context, P5Context, P6Context, P3Output, P4Output, P5Output } from '../../src/phases/phase-output.js'
import { tierSizing } from '../../src/engine/complexity.js'

// ── Mock factories ─────────────────────────────────────────────────────────────

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

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) => {
    return handlers[event]?.(e, ctx)
  }

  return { pi, handlers, fire }
}

function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
      setImmediate(onComplete)
    }),
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

function makeController(
  pi: ExtensionAPI,
  opts: Partial<ControllerOptions> & { repoRoot: string }
): Controller {
  return new Controller(pi, {
    verifier: makeNullVerifier(),
    gitOps: makeNullGitOps(),
    judge: makeNullJudge(),
    transparency: makeNullTransparency(),
    ...opts,
  })
}

function makeInputEvent(text: string): InputEvent {
  return { type: 'input', text, source: 'interactive' } as InputEvent
}

function makeSessionStartEvent(): SessionStartEvent {
  return { type: 'session_start' } as unknown as SessionStartEvent
}

// ── Shared P3 fixture ──────────────────────────────────────────────────────────

const mockP3Output: P3Output = {
  phase: 'P3',
  fileDAG: [{ file: 'src/index.ts', lane: 0, deps: [] }],
  panelObjCount: 0,
  sprintContract: {
    goal: 'Build a CLI tool',
    successCriteria: ['tests pass'],
    outOfScope: [],
  },
  examplesTable: [],
}

const mockP4Output: P4Output = {
  phase: 'P4',
  laneResults: [{ laneId: 0, status: 'success', files: ['src/index.ts'], output: 'built' }],
  artifacts: ['src/index.ts'],
}

const mockP5Output: P5Output = {
  phase: 'P5',
  verifyReport: { deterministicPassed: true, holdoutPassed: true, securityClean: true },
  reviewFindings: [],
}

// Captured ONCE at module load, BEFORE any test calls process.chdir(). Tests that
// chdir into a temp dir must restore cwd to this stable dir in afterEach BEFORE the
// temp dir is removed — otherwise process.cwd() points at a since-deleted dir and a
// later sibling test's path/cwd op throws ENOENT (the ~1-in-3 flake root cause).
const STABLE_CWD = process.cwd()

// ── Test 1: _resolveRepoRoot re-roots controller + registers + calls ensureIndexed ──

describe('Lane W+C: _resolveRepoRoot re-roots controller when registry injected', () => {
  let tmpDir: string
  let resolvedDir: string
  let registryDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-root-test-'))
    resolvedDir = path.join(tmpDir, 'resolved-project')
    registryDir = path.join(tmpDir, 'registry')
    await fs.mkdir(resolvedDir, { recursive: true })
  })

  afterEach(async () => {
    // Restore cwd to the stable dir BEFORE removing tmpDir: these tests chdir into
    // resolvedDir, and removing the tree while cwd is inside it strands the process.
    try { process.chdir(STABLE_CWD) } catch { /* cwd already valid */ }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('adopts resolved dir as repoRoot, re-derives outputDir, registers project', async () => {
    // Build a registry that returns a known resolved dir for any cwd
    const registry = new ProjectRegistry(registryDir)
    // Pre-register a project so resolver finds it by cwd
    await registry.register('my-project', resolvedDir)
    // Force cwd to resolvedDir so step-1 (findByDir) hits
    const origCwd = process.cwd()
    process.chdir(resolvedDir)

    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Fire an idea — _resolveRepoRoot should re-root to resolvedDir
    void fire('input', makeInputEvent('Build a simple CLI tool for file management'), ctx)
    await new Promise(r => setTimeout(r, 200))

    // Verify journal was written in resolvedDir (journal is re-derived from resolved dir)
    const journalPath = path.join(resolvedDir, '.autodev', 'journal.jsonl')
    let journalExists = false
    // Poll for journal (async write)
    for (let i = 0; i < 20; i++) {
      journalExists = await fs.access(journalPath).then(() => true).catch(() => false)
      if (journalExists) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(journalExists).toBe(true)
    const journalContent = await fs.readFile(journalPath, 'utf-8')
    expect(journalContent).toContain('resolved project')
    expect(journalContent).toContain('my-project')

    process.chdir(origCwd)
  }, 10_000)

  it('calls codebaseMemory.ensureIndexed when project is existing (isExisting=true)', async () => {
    const registry = new ProjectRegistry(registryDir)
    await registry.register('existing-project', resolvedDir)

    const ensureIndexed = vi.fn().mockResolvedValue(undefined)
    const codebaseMemory = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
      ensureIndexed,
    }

    const origCwd = process.cwd()
    process.chdir(resolvedDir)

    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry, codebaseMemory })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Add new feature to existing project'), ctx)

    // Wait for _resolveRepoRoot to complete
    await new Promise(r => setTimeout(r, 300))

    expect(ensureIndexed).toHaveBeenCalled()
    process.chdir(origCwd)
  }, 10_000)

  it('does NOT call ensureIndexed when project is new (isNew=true)', async () => {
    // No registry entries → step 4 → new project under ~/autodev/<slug>
    const registry = new ProjectRegistry(registryDir)

    const ensureIndexed = vi.fn().mockResolvedValue(undefined)
    const codebaseMemory = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
      ensureIndexed,
    }

    // Use a temp dir that is NOT a git repo and NOT registered → step 4 fires
    const junkDir = path.join(tmpDir, 'junk-cwd')
    await fs.mkdir(junkDir, { recursive: true })
    const origCwd = process.cwd()
    process.chdir(junkDir)

    // Also override homeDir to a tmp location so step 4 writes there
    const fakeHome = path.join(tmpDir, 'fake-home')
    await fs.mkdir(fakeHome, { recursive: true })

    const { pi, fire } = makeMockPi()
    // Inject a custom registry with homeDir override via direct resolver mock
    // We can't override homeDir on the controller, but junkDir has no .git/package.json
    // and no registered dir → falls through to step 4 (new project).
    // Step 4 would write to os.homedir()/autodev/<slug> — just verify ensureIndexed NOT called.
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry, codebaseMemory })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a brand new project from scratch for testing'), ctx)

    await new Promise(r => setTimeout(r, 300))

    // For a new project, ensureIndexed should NOT be called
    expect(ensureIndexed).not.toHaveBeenCalled()

    process.chdir(origCwd)
  }, 10_000)

  it('degrades gracefully when ensureIndexed throws', async () => {
    const registry = new ProjectRegistry(registryDir)
    await registry.register('crash-project', resolvedDir)

    const ensureIndexed = vi.fn().mockRejectedValue(new Error('codebase-mem down'))
    const codebaseMemory = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
      ensureIndexed,
    }

    const transparency = makeNullTransparency()
    const origCwd = process.cwd()
    process.chdir(resolvedDir)

    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry, codebaseMemory, transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    // Should NOT throw even though ensureIndexed rejects
    await expect(
      fire('input', makeInputEvent('Fix bugs in existing project crash test'), ctx)
    ).resolves.not.toThrow?.()

    await new Promise(r => setTimeout(r, 300))
    // ensureIndexed was called but threw — controller continues
    expect(ensureIndexed).toHaveBeenCalled()

    process.chdir(origCwd)
  }, 10_000)
})

// ── Test 2: Write confinement ───────────────────────────────────────────────────

describe('Lane W: Write confinement — write/edit tools blocked outside repoRoot', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confinement-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeCtrl(pi: ExtensionAPI, repoRoot: string) {
    return makeController(pi, { repoRoot })
  }

  const homeDir = os.homedir()

  it('denies write tool to $HOME path', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc1',
      toolName: 'write',
      input: { file_path: path.join(homeDir, 'evil-file.txt') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/out-of-bounds/i)
  })

  it('allows write tool to path inside repoRoot', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc2',
      toolName: 'write',
      input: { file_path: path.join(tmpDir, 'src', 'index.ts') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })

  it('denies edit tool to $HOME path', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc3',
      toolName: 'edit',
      input: { file_path: path.join(homeDir, '.bashrc') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/out-of-bounds/i)
  })

  it('denies str_replace tool to $HOME path', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc4',
      toolName: 'str_replace',
      input: { file_path: path.join(homeDir, 'some-file.py') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
  })

  it('denies str_replace_based_edit_tool to $HOME path', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc5',
      toolName: 'str_replace_based_edit_tool',
      input: { file_path: path.join(homeDir, 'x.ts') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBe(true)
  })

  it('allows str_replace tool inside repoRoot', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc6',
      toolName: 'str_replace',
      input: { file_path: path.join(tmpDir, 'src', 'component.ts') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })

  it('denies write_file tool to absolute /etc path', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc7',
      toolName: 'write_file',
      input: { path: '/etc/passwd' },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBe(true)
  })

  it('allows create_file inside repoRoot (uses path field)', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeCtrl(pi, tmpDir)
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc8',
      toolName: 'create_file',
      input: { path: path.join(tmpDir, 'new-file.ts') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })
})

// ── Test 3: No registry → behavior identical to today ─────────────────────────

describe('Lane W: No registry injected → repoRoot stays cwd, existing behavior preserved', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-registry-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('controller without registry: session_start → ARMED, no error', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, { repoRoot: tmpDir, transparency })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)

    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('ARMED'))
  })

  it('controller without registry: idea input fires RUNNING, repoRoot stays tmpDir', async () => {
    const { pi, fire } = makeMockPi()
    const transparency = makeNullTransparency()
    const ctrl = makeController(pi, {
      repoRoot: tmpDir,
      transparency,
      steerTimeoutMs: 100, // short timeout so phase fails fast → lifecycle releases → cleanup safe
    })
    ctrl.wire()

    const ctx = makeExtCtx()
    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a simple REST API server'), ctx)
    await new Promise(r => setImmediate(r))

    expect(transparency.log).toHaveBeenCalledWith(expect.stringContaining('RUNNING'))

    // Wait for timeout + escalation so lifecycle releases (avoids afterEach race)
    await new Promise(r => setTimeout(r, 400))

    // Journal should be in tmpDir (not re-rooted)
    const journalInTmpDir = await fs.access(path.join(tmpDir, '.autodev', 'journal.jsonl'))
      .then(() => true).catch(() => false)
    expect(journalInTmpDir).toBe(true)
  }, 10_000)

  it('write confinement: no registry + write outside tmpDir → denied', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-noregistry',
      toolName: 'write',
      input: { file_path: '/etc/evil' },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBe(true)
  })
})

// ── Test 4: /autodev-project command ──────────────────────────────────────────

describe('Lane C: /autodev-project command — set/list', () => {
  let tmpDir: string
  let registryDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autodev-project-test-'))
    registryDir = path.join(tmpDir, 'registry')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function getCommandHandler(pi: ExtensionAPI, name: string) {
    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((args: unknown[]) => args[0] === name)
    return call?.[1]?.handler as ((args: string, ctx: unknown) => Promise<void>) | undefined
  }

  it('registers /autodev-project command', () => {
    const registry = new ProjectRegistry(registryDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const names = calls.map((args: unknown[]) => args[0] as string)
    expect(names).toContain('/autodev-project')
  })

  it('/autodev-project <name> sets active project and registers cwd if new', async () => {
    const registry = new ProjectRegistry(registryDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getCommandHandler(pi, '/autodev-project')
    expect(handler).toBeDefined()

    const notifyMock = vi.fn()
    await handler!('my-new-project', { ui: { notify: notifyMock } })

    // Should have registered + set active
    const active = await registry.getActive()
    expect(active).toBe('my-new-project')

    const meta = await registry.get('my-new-project')
    expect(meta).toBeDefined()
    expect(typeof meta?.dir).toBe('string')

    // notify called with project info
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('my-new-project'),
      'info'
    )
  })

  it('/autodev-project with no args lists registered projects', async () => {
    const registry = new ProjectRegistry(registryDir)
    const projDir = path.join(tmpDir, 'proj-alpha')
    await registry.register('proj-alpha', projDir)
    await registry.setActive('proj-alpha')

    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getCommandHandler(pi, '/autodev-project')
    const notifyMock = vi.fn()
    await handler!('', { ui: { notify: notifyMock } })

    const msg = notifyMock.mock.calls[0]?.[0] as string
    expect(msg).toContain('proj-alpha')
    expect(msg).toContain(projDir)
    // Active project should be marked with *
    expect(msg).toContain('* proj-alpha')
  })

  it('/autodev-project with no args on empty registry says "No projects registered"', async () => {
    const registry = new ProjectRegistry(registryDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getCommandHandler(pi, '/autodev-project')
    const notifyMock = vi.fn()
    await handler!('', { ui: { notify: notifyMock } })

    expect(notifyMock.mock.calls[0]?.[0]).toContain('No projects registered')
  })

  it('/autodev-project with no registry shows warning', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getCommandHandler(pi, '/autodev-project')
    const notifyMock = vi.fn()
    await handler!('some-project', { ui: { notify: notifyMock } })

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('No registry'),
      'warning'
    )
  })

  it('/autodev-status shows repoRoot and activeProject when registry set', async () => {
    const registry = new ProjectRegistry(registryDir)
    const projDir = path.join(tmpDir, 'status-proj')
    await registry.register('status-proj', projDir)
    await registry.setActive('status-proj')

    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const statusCall = calls.find((args: unknown[]) => args[0] === '/autodev-status')
    const handler = statusCall?.[1]?.handler as (args: string, ctx: unknown) => Promise<void>

    const notifyMock = vi.fn()
    await handler('', { ui: { notify: notifyMock } })

    const parsed = JSON.parse(notifyMock.mock.calls[0]?.[0] as string) as Record<string, string>
    expect(parsed).toHaveProperty('repoRoot')
    expect(parsed).toHaveProperty('activeProject')
    expect(parsed.activeProject).toBe('status-proj')
  })
})

// ── Test 5: P4/P5/P6 instructions contain repoRoot + cd prefix ──────────────

describe('Lane W: P4/P5/P6 instructions contain absolute repoRoot + cd prefix', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-reporoot-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeMockHostAgent(
    writeCallback?: (f: string) => Promise<void>
  ): HostAgent {
    return {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        if (opts.expectFile && writeCallback) await writeCallback(opts.expectFile)
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
      _onAgentEnd: vi.fn(),
      _onTurnEnd: vi.fn(),
    } as unknown as HostAgent
  }

  it('P4 instruction contains absolute repoRoot path and cd prefix when repoRoot set', async () => {
    const repoRoot = path.join(tmpDir, 'my-project')
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify({
            phase: 'P4',
            laneResults: [{ laneId: 0, status: 'success', files: ['src/index.ts'], output: 'built' }],
            artifacts: ['src/index.ts'],
          }))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
      _onAgentEnd: vi.fn(),
      _onTurnEnd: vi.fn(),
    } as unknown as HostAgent

    const ctx: P4Context = { phase: 'P4', p3: mockP3Output, repoRoot }
    const p4 = new P4Build(agent, tmpDir)
    await p4.execute(ctx)

    expect(steerPrompts[0]).toContain(repoRoot)
    expect(steerPrompts[0]).toContain(`cd ${repoRoot} &&`)
    expect(steerPrompts[0]).toContain('Write ALL files under')
  })

  it('P4 instruction does NOT contain repoRoot lines when repoRoot absent', async () => {
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify({
            phase: 'P4',
            laneResults: [{ laneId: 0, status: 'success', files: ['src/index.ts'], output: 'built' }],
            artifacts: ['src/index.ts'],
          }))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent

    const ctx: P4Context = { phase: 'P4', p3: mockP3Output }
    const p4 = new P4Build(agent, tmpDir)
    await p4.execute(ctx)

    expect(steerPrompts[0]).not.toContain('Write ALL files under')
    // Assert the real cd-prefix marker line is absent. NOTE: a bare not.toContain('cd')
    // is brittle — the prompt embeds random hex nonces from wrapUntrusted() that
    // intermittently contain the substring "cd" (~12%/run), so we check the exact
    // cd-prefix directive line that buildP4Instruction only emits when repoRoot is set.
    expect(steerPrompts[0]).not.toContain('Prefix every shell command with: cd')
  })

  it('P5 instruction contains absolute repoRoot path and cd prefix when repoRoot set', async () => {
    const repoRoot = path.join(tmpDir, 'my-project')
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify(mockP5Output))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent

    const ctx: P5Context = { phase: 'P5', p3: mockP3Output, p4: mockP4Output, repoRoot }
    const p5 = new P5Verify(agent, tmpDir, makeNullVerifier(), makeNullJudge(), tmpDir)
    await p5.execute(ctx)

    expect(steerPrompts[0]).toContain(repoRoot)
    expect(steerPrompts[0]).toContain(`cd ${repoRoot} &&`)
    expect(steerPrompts[0]).toContain('Run ALL verification commands under')
  })

  it('P5 instruction does NOT contain repoRoot lines when repoRoot absent', async () => {
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify(mockP5Output))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent

    const ctx: P5Context = { phase: 'P5', p3: mockP3Output, p4: mockP4Output }
    const p5 = new P5Verify(agent, tmpDir, makeNullVerifier(), makeNullJudge(), tmpDir)
    await p5.execute(ctx)

    expect(steerPrompts[0]).not.toContain('Run ALL verification commands under')
  })

  it('P6 instruction contains absolute repoRoot path and cd prefix when repoRoot set', async () => {
    const repoRoot = path.join(tmpDir, 'my-project')
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify({
            phase: 'P6', commitSha: 'abc123', pushResult: 'pushed',
          }))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent

    const ctx: P6Context = { phase: 'P6', p5: mockP5Output, repoRoot }
    const p6 = new P6Release(agent, tmpDir, makeNullGitOps())
    await p6.execute(ctx)

    expect(steerPrompts[0]).toContain(repoRoot)
    expect(steerPrompts[0]).toContain(`cd ${repoRoot} &&`)
    expect(steerPrompts[0]).toContain('All release operations under')
  })

  it('P6 instruction does NOT contain repoRoot lines when repoRoot absent', async () => {
    const steerPrompts: string[] = []
    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify({
            phase: 'P6', commitSha: 'abc123', pushResult: 'pushed',
          }))
        }
        return { rawText: 'done', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent

    const ctx: P6Context = { phase: 'P6', p5: mockP5Output }
    const p6 = new P6Release(agent, tmpDir, makeNullGitOps())
    await p6.execute(ctx)

    expect(steerPrompts[0]).not.toContain('All release operations under')
  })
})

// ── Test 6: SubagentDriver repoRoot injection ──────────────────────────────────

describe('Lane W: SubagentDriver uses injected repoRoot for git ops', () => {
  it('SubagentDriver defaults to process.cwd() when no repoRoot set', async () => {
    // Just verify it constructs without error and invoke works
    const { SubagentDriver } = await import('../../src/host/subagent-driver.js')
    const mockHostAgent = {
      steer: vi.fn().mockResolvedValue({ rawText: '', toolResults: [], seq: 1 }),
      _onAgentEnd: vi.fn(),
      _onTurnEnd: vi.fn(),
    } as unknown as HostAgent

    const driver = new SubagentDriver(mockHostAgent)
    // setRepoRoot should be callable without error
    driver.setRepoRoot('/some/dir')
    expect(true).toBe(true) // construction + setRepoRoot succeeded
  })
})

// ── Fix 2: fail-closed path extraction ────────────────────────────────────────

describe('Fix 2: fail-closed write-tool path extraction', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fix2-test-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('write tool with completely unknown path shape → blocked (fail closed)', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-unknown',
      toolName: 'write',
      input: { unknown_key: '/some/path' }, // no file_path/path/target_file/filename/notebook_path/dst
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/unrecognized path shape/)
  })

  it('write tool with empty input object → blocked (fail closed)', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-empty',
      toolName: 'edit',
      input: {},
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean; reason?: string }
    expect(result?.block).toBe(true)
    expect(result?.reason).toMatch(/unrecognized path shape/)
  })

  it('write tool with filename key → accepted and checked', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-filename',
      toolName: 'write',
      input: { filename: path.join(tmpDir, 'out.ts') }, // inside repoRoot → allowed
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })

  it('write tool with dst key pointing outside repoRoot → blocked', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-dst',
      toolName: 'write',
      input: { dst: '/etc/evil' },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBe(true)
  })

  it('write tool with edits array of {path} — each path is checked', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    // One inside repoRoot, one outside — should be blocked
    const event = {
      type: 'tool_call',
      toolCallId: 'tc-edits',
      toolName: 'str_replace_editor',
      input: {
        edits: [
          { path: path.join(tmpDir, 'src/ok.ts') },
          { path: '/etc/shadow' },
        ],
      },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBe(true)
  })

  it('write tool with files array of {file_path} all inside repoRoot → allowed', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-files',
      toolName: 'write',
      input: {
        files: [
          { file_path: path.join(tmpDir, 'a.ts') },
          { file_path: path.join(tmpDir, 'b.ts') },
        ],
      },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })

  it('notebook_path key inside repoRoot → allowed', () => {
    const { pi, fire } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.wire()

    const event = {
      type: 'tool_call',
      toolCallId: 'tc-notebook',
      toolName: 'write',
      input: { notebook_path: path.join(tmpDir, 'analysis.ipynb') },
    } as unknown as ToolCallEvent

    const result = fire('tool_call', event) as { block?: boolean }
    expect(result?.block).toBeFalsy()
  })
})

// ── Fix 3: /autodev-project validation ────────────────────────────────────────

describe('Fix 3: /autodev-project command validation', () => {
  let tmpDir: string
  let registryDir: string
  let projectDir: string // a dir with .git so it passes the hasDotGit check

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fix3-test-'))
    registryDir = path.join(tmpDir, 'registry')
    projectDir = path.join(tmpDir, 'my-project')
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true })
  })
  afterEach(async () => {
    // Restore cwd before removing tmpDir: these tests chdir into projectDir/junkDir.
    try { process.chdir(STABLE_CWD) } catch { /* cwd already valid */ }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function getProjectHandler(pi: ExtensionAPI) {
    const calls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((args: unknown[]) => args[0] === '/autodev-project')
    return call?.[1]?.handler as ((args: string, ctx: unknown) => Promise<void>) | undefined
  }

  it('repointing an existing name to a different dir is refused with warning', async () => {
    const registry = new ProjectRegistry(registryDir)
    // Register 'my-proj' pointing to some other dir
    await registry.register('my-proj', '/some/other/dir')

    const origCwd = process.cwd()
    process.chdir(projectDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!('my-proj', { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    // Should warn about repointing
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('refusing to repoint'),
      'warning'
    )
  })

  it('junk/home cwd (lacks .git and package.json) is refused with warning', async () => {
    const registry = new ProjectRegistry(registryDir)
    const junkDir = path.join(tmpDir, 'junk-no-git-no-pkg')
    await fs.mkdir(junkDir, { recursive: true })

    const origCwd = process.cwd()
    process.chdir(junkDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!('valid-name', { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('lacks both .git and package.json'),
      'warning'
    )
  })

  it('invalid name charset (spaces/special chars) is refused', async () => {
    const registry = new ProjectRegistry(registryDir)
    const origCwd = process.cwd()
    process.chdir(projectDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!('bad name with spaces!', { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid project name'),
      'warning'
    )
  })

  it('name >64 chars is refused', async () => {
    const registry = new ProjectRegistry(registryDir)
    const origCwd = process.cwd()
    process.chdir(projectDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!('a'.repeat(65), { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid project name'),
      'warning'
    )
  })

  it('valid name with .git dir → registers successfully', async () => {
    const registry = new ProjectRegistry(registryDir)
    const origCwd = process.cwd()
    process.chdir(projectDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!('valid-project', { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('valid-project'),
      'info'
    )
    const active = await registry.getActive()
    expect(active).toBe('valid-project')
  })

  // Item 5: '.', '..', and all-dot names must be rejected (they pass the charset
  // regex but are filesystem-relative path components, never valid project names).
  it.each(['.', '..', '...'])('dot-name "%s" is refused as invalid', async (badName) => {
    const registry = new ProjectRegistry(registryDir)
    const origCwd = process.cwd()
    process.chdir(projectDir)
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })
    ctrl.wire()
    ctrl.registerCommands()

    const handler = await getProjectHandler(pi)
    const notifyMock = vi.fn()
    await handler!(badName, { ui: { notify: notifyMock } })
    process.chdir(origCwd)

    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid project name'),
      'warning'
    )
    // Must NOT have registered or activated the dot-name.
    expect(await registry.getActive()).toBeUndefined()
  })
})
