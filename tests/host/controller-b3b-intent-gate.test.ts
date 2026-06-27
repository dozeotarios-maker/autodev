// B3b: Intent gate — resolvedIsNew field + P1Context.intent + _intentGate wiring
//
// Test strategy: TDD order per plan.
//   Task 1: resolvedIsNew set/reset from resolver
//   Task 2: P1Context.intent optional field + buildP1Instruction uses it
//   Task 3: _intentGate (hasUI+isNew+no-forced-tier; degrade on cancel; skip conditions)
//   Task 4: /autodev-status shows intentCaptured
//
// Key invariant: existing tests' ctx has NO hasUI → gate skips, 900 green.
// The two existing isNew tests (controller-project-resolver.test.ts:240,:270) use
// makeExtCtx() with NO hasUI → gate never fires in them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Controller } from '../../src/host/controller.js'
import type { ControllerOptions } from '../../src/host/controller.js'
import { buildP1Instruction } from '../../src/phases/p1-discover.js'
import type { P1Context } from '../../src/phases/phase-output.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'
import { ProjectRegistry } from '../../src/project/registry.js'

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

/** Standard ctx — NO hasUI, NO ui.input. Same as existing tests. */
function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
      setImmediate(onComplete)
    }),
  } as unknown as ExtensionContext
}

/** UI-capable ctx with input mock for B3b intent gate tests. */
function makeUiCtxWithInput(
  inputImpl: (...args: unknown[]) => Promise<string | undefined>
): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      input: vi.fn(inputImpl),
    },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
      setImmediate(onComplete)
    }),
  } as unknown as ExtensionContext
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

function makeController(
  pi: ExtensionAPI,
  overrides: Partial<ControllerOptions> = {}
): Controller {
  return new Controller(pi, {
    repoRoot: '/tmp/test-repo',
    verifier: makeNullVerifier(),
    gitOps: makeNullGitOps(),
    judge: makeNullJudge(),
    transparency: makeNullTransparency(),
    dialogueTimeoutMs: 100,
    ...overrides,
  })
}

// B1 teardown-settle helper (same pattern as B3a tests)
async function waitForLockRelease(tmpDir: string, timeoutMs = 8_000): Promise<void> {
  const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    if (locked) break
    await new Promise((r) => setTimeout(r, 10))
  }

  while (Date.now() < deadline) {
    const locked = await fs.access(lockPath).then(() => true).catch(() => false)
    if (!locked) break
    await new Promise((r) => setTimeout(r, 15))
  }

  await new Promise((r) => setTimeout(r, 25))
}

// ════════════════════════════════════════════════════════════════════════════════
// Task 1 — resolvedIsNew field
// ════════════════════════════════════════════════════════════════════════════════

describe('B3b Task1: resolvedIsNew field — set/reset from resolver', () => {
  let tmpDir: string
  let registryDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-isNew-'))
    registryDir = path.join(tmpDir, 'registry')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('no registry injected → resolvedIsNew stays false (gate never fires)', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })

    // Access private field via cast
    const c = ctrl as unknown as { resolvedIsNew: boolean }
    expect(c.resolvedIsNew).toBe(false)

    // Run _resolveRepoRoot without registry (no-op)
    const resolveMethod = (ctrl as unknown as {
      _resolveRepoRoot(idea: string): Promise<void>
    })._resolveRepoRoot
    await resolveMethod.call(ctrl, 'build a test app')
    expect(c.resolvedIsNew).toBe(false)
  })

  it('existing project → resolvedIsNew=false', async () => {
    const registry = new ProjectRegistry(registryDir)
    // Register a project under tmpDir
    const projectDir = path.join(tmpDir, 'my-project')
    await fs.mkdir(projectDir, { recursive: true })
    // Create a package.json so step 2 of resolver fires (existing repo detection)
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-project' }))

    // chdir to tmpDir first to ensure cwd is valid before saving origCwd
    process.chdir(tmpDir)
    const origCwd = process.cwd()
    process.chdir(projectDir)

    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })

    const resolveMethod = (ctrl as unknown as {
      _resolveRepoRoot(idea: string): Promise<void>
    })._resolveRepoRoot
    await resolveMethod.call(ctrl, 'add a feature to existing project')

    const c = ctrl as unknown as { resolvedIsNew: boolean }
    expect(c.resolvedIsNew).toBe(false)

    process.chdir(origCwd)
  })

  it('new project (no registry entries, junk cwd) → resolvedIsNew=true', async () => {
    // ESM does not allow spying on os.homedir. Instead, test via Controller's registry
    // integration: register no projects, use a junk cwd that has neither .git nor package.json
    // → resolver step 4 fires (new project), resolvedIsNew=true.
    // We chdir into junkDir then restore — no homedir mock needed since step 4 resolves
    // into os.homedir()/autodev/<slug> which we verify by checking resolvedIsNew rather
    // than inspecting the dir path.
    const registry = new ProjectRegistry(registryDir)
    const junkDir = path.join(tmpDir, 'junk-cwd-b3b')
    await fs.mkdir(junkDir, { recursive: true })
    // No .git, no package.json, no active project → step 4 fires (new project)

    process.chdir(tmpDir)
    const origCwd = process.cwd()
    process.chdir(junkDir)

    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, registry })

    const resolveMethod = (ctrl as unknown as {
      _resolveRepoRoot(idea: string): Promise<void>
    })._resolveRepoRoot

    try {
      await resolveMethod.call(ctrl, 'Build a brand new todo app from scratch')
      const c = ctrl as unknown as { resolvedIsNew: boolean }
      expect(c.resolvedIsNew).toBe(true)
    } finally {
      process.chdir(origCwd)
    }
  })

  it('resolvedIsNew resets to false at start of each _resolveRepoRoot call (no stale carry)', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })

    const c = ctrl as unknown as { resolvedIsNew: boolean }
    // Manually set to true
    c.resolvedIsNew = true

    // Call _resolveRepoRoot with no registry → resets to false
    const resolveMethod = (ctrl as unknown as {
      _resolveRepoRoot(idea: string): Promise<void>
    })._resolveRepoRoot
    await resolveMethod.call(ctrl, 'some idea')
    expect(c.resolvedIsNew).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 2 — P1Context.intent optional field + buildP1Instruction uses it
// ════════════════════════════════════════════════════════════════════════════════

describe('B3b Task2: buildP1Instruction — intent present → mentions values', () => {
  it('intent absent → instruction unchanged (no intent section)', () => {
    const ctx: P1Context = { phase: 'P1', idea: 'build a REST API' }
    const instruction = buildP1Instruction(ctx, '/tmp/p1-spec.json') as string
    expect(instruction).not.toContain('User intent')
    expect(instruction).not.toContain('use case:')
    expect(instruction).toContain('P1 DISCOVER')
    expect(instruction).toContain('build a REST API')
  })

  it('intent present → instruction mentions use case, scale, audience', () => {
    const ctx: P1Context = {
      phase: 'P1',
      idea: 'build a todo app',
      intent: { useCase: 'a todo app', scale: 'small', audience: 'just me' },
    }
    const instruction = buildP1Instruction(ctx, '/tmp/p1-spec.json') as string
    expect(instruction).toContain('User intent')
    expect(instruction).toContain('a todo app')
    expect(instruction).toContain('small')
    expect(instruction).toContain('just me')
  })

  it('partial intent (only useCase) → only useCase mentioned, others show (not provided)', () => {
    const ctx: P1Context = {
      phase: 'P1',
      idea: 'build an API',
      intent: { useCase: 'REST API for tasks' },
    }
    const instruction = buildP1Instruction(ctx, '/tmp/p1-spec.json') as string
    expect(instruction).toContain('REST API for tasks')
    expect(instruction).toContain('(not provided)')
  })

  it('intent absent with memoryStore → async path still has no intent section', async () => {
    const ctx: P1Context = {
      phase: 'P1',
      idea: 'build a service',
      memoryStore: {
        recall: vi.fn().mockResolvedValue([]),
        store: vi.fn().mockResolvedValue(undefined),
        healthCheck: vi.fn().mockResolvedValue({ ok: true }),
        detectContradictions: vi.fn().mockResolvedValue([]),
      },
      screenContent: vi.fn().mockResolvedValue({ safe: true, threats: [] }),
    }
    const instruction = await buildP1Instruction(ctx, '/tmp/p1-spec.json')
    expect(instruction).not.toContain('User intent')
  })

  it('intent present with memoryStore → async path includes intent section', async () => {
    const ctx: P1Context = {
      phase: 'P1',
      idea: 'build a service',
      intent: { useCase: 'async app', scale: 'large', audience: 'enterprise' },
      memoryStore: {
        recall: vi.fn().mockResolvedValue([]),
        store: vi.fn().mockResolvedValue(undefined),
        healthCheck: vi.fn().mockResolvedValue({ ok: true }),
        detectContradictions: vi.fn().mockResolvedValue([]),
      },
      screenContent: vi.fn().mockResolvedValue({ safe: true, threats: [] }),
    }
    const instruction = await buildP1Instruction(ctx, '/tmp/p1-spec.json')
    expect(instruction).toContain('User intent')
    expect(instruction).toContain('async app')
    expect(instruction).toContain('large')
    expect(instruction).toContain('enterprise')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 3 — _intentGate unit tests (skip conditions + ask flow + degrade)
// ════════════════════════════════════════════════════════════════════════════════

describe('B3b Task3: _intentGate — skip when hasUI=false', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-igate-noui-'))
  })

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30))
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('hasUI=false → returns undefined, input NOT called', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })

    // Set resolvedIsNew=true so we only isolate the hasUI guard
    const c = ctrl as unknown as { resolvedIsNew: boolean }
    c.resolvedIsNew = true

    const inputMock = vi.fn()
    const ctx = {
      // NO hasUI property
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)
    expect(result).toBeUndefined()
    expect(inputMock).not.toHaveBeenCalled()
  })
})

describe('B3b Task3: _intentGate — skip when resolvedIsNew=false', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-igate-existing-'))
  })

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30))
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('resolvedIsNew=false → returns undefined, input NOT called', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })

    // resolvedIsNew defaults to false
    const inputMock = vi.fn()
    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)
    expect(result).toBeUndefined()
    expect(inputMock).not.toHaveBeenCalled()
  })
})

describe('B3b Task3: _intentGate — skip when forcedTier is set', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-igate-forced-'))
  })

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30))
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('forcedTier set (e.g. quick:) → returns undefined, input NOT called', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string
    }
    c.resolvedIsNew = true
    c.currentForcedTier = 'XS' // quick: prefix

    const inputMock = vi.fn()
    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)
    expect(result).toBeUndefined()
    expect(inputMock).not.toHaveBeenCalled()
  })
})

describe('B3b Task3: _intentGate — full flow (hasUI+isNew+no-override)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-igate-full-'))
  })

  afterEach(async () => {
    // Settle: allow fire-and-forget journal.write() promises to complete before
    // tmpDir is deleted, to avoid spurious ENOENT errors from parallel async I/O.
    await new Promise((r) => setTimeout(r, 30))
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('all 3 conditions met → asks 3 questions, returns full intent object', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn()
      .mockResolvedValueOnce('a todo app')
      .mockResolvedValueOnce('small')
      .mockResolvedValueOnce('just me')

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ useCase: 'a todo app', scale: 'small', audience: 'just me' })
  })

  it('first question cancelled (undefined) → returns undefined (nothing gathered)', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn().mockResolvedValueOnce(undefined)

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('second question (scale) cancelled → returns partial intent with only useCase', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn()
      .mockResolvedValueOnce('a todo app')
      .mockResolvedValueOnce(undefined) // scale cancelled

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(2)
    // Partial: useCase captured, scale/audience not
    expect(result).toEqual({ useCase: 'a todo app' })
  })

  it('third question (audience) cancelled → returns partial intent with useCase+scale', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn()
      .mockResolvedValueOnce('a todo app')
      .mockResolvedValueOnce('small')
      .mockResolvedValueOnce(undefined) // audience cancelled

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ useCase: 'a todo app', scale: 'small' })
  })

  it('Q1 empty string → gate returns undefined (same as cancel), input called once', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn().mockResolvedValueOnce('')  // empty string, not undefined

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('Q2 empty string after valid Q1 → partial intent with useCase only, no scale key', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn()
      .mockResolvedValueOnce('a todo app')
      .mockResolvedValueOnce('')  // empty scale → stop, don't add scale key

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ useCase: 'a todo app' })
    expect(result).not.toHaveProperty('scale')
  })

  it('Q1 whitespace-only → treated as empty (falsy after trim) → gate returns undefined', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 100 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn().mockResolvedValueOnce('   ')  // whitespace only

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    const result = await gate.call(ctrl, ctx)

    expect(inputMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('each input call uses the configured dialogueTimeoutMs', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir, dialogueTimeoutMs: 42_000 })

    const c = ctrl as unknown as {
      resolvedIsNew: boolean
      currentForcedTier: string | undefined
    }
    c.resolvedIsNew = true
    c.currentForcedTier = undefined

    const inputMock = vi.fn()
      .mockResolvedValueOnce('a todo app')
      .mockResolvedValueOnce('small')
      .mockResolvedValueOnce('just me')

    const ctx = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(),
    } as unknown as ExtensionContext

    const gate = (ctrl as unknown as {
      _intentGate(ctx: ExtensionContext): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined>
    })._intentGate
    await gate.call(ctrl, ctx)

    // All 3 calls should use { timeout: 42_000 }
    for (const call of inputMock.mock.calls) {
      expect(call[2]).toEqual({ timeout: 42_000 })
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 3 (integration): _intentGate threads intent into P1 via _runPhases
// ════════════════════════════════════════════════════════════════════════════════

describe('B3b Task3 (integration): intent gate threads into P1 on new project run', () => {
  let tmpDir: string
  let registryDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-int-'))
    registryDir = path.join(tmpDir, 'registry')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('existing tests: ctx without hasUI → gate skips, _runPhases proceeds normally (input NOT called)', async () => {
    // This mirrors the two isNew=true resolver tests — they use makeExtCtx() without hasUI
    // The gate must be skipped, ensuring 900-green stays intact.
    const registry = new ProjectRegistry(registryDir)
    const junkDir = path.join(tmpDir, 'junk-no-ui')
    await fs.mkdir(junkDir, { recursive: true })

    // chdir to tmpDir first (guaranteed to exist) before chdir to junkDir,
    // in case a prior test left cwd in a deleted directory (ENOENT from process.cwd())
    process.chdir(tmpDir)
    const origCwd = process.cwd()
    process.chdir(junkDir)

    const fakeHome = path.join(tmpDir, 'fake-home-nui')
    await fs.mkdir(fakeHome, { recursive: true })

    const { pi, fire } = makeMockPi()
    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 100,
      registry,
    })
    ctrl.wire()

    // ctx WITHOUT hasUI — exactly like existing tests
    const inputMock = vi.fn()
    const ctx: ExtensionContext = {
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
        setImmediate(onComplete)
      }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a brand new project without UI'), ctx)

    await waitForLockRelease(tmpDir, 8_000)

    // Gate never fired
    expect(inputMock).not.toHaveBeenCalled()
    process.chdir(origCwd)
  }, 15_000)

  it('end-to-end gate→P1 wiring: intent values appear in P1 steer instruction', async () => {
    // This test MUST FAIL if `intent: this.currentIntent` is removed from _runPhases.
    // It drives a full new-project run with hasUI=true + ui.input returning 3 answers,
    // then asserts the P1 sendUserMessage call contains the intent use-case string.
    const registry = new ProjectRegistry(registryDir)
    const junkDir = path.join(tmpDir, 'junk-wiring')
    await fs.mkdir(junkDir, { recursive: true })

    process.chdir(tmpDir)
    const origCwd = process.cwd()
    process.chdir(junkDir)

    const outputDir = path.join(tmpDir, '.autodev', 'phase-output')

    const { pi, fire } = makeMockPi()

    // Capture all sendUserMessage calls to inspect the P1 instruction
    const steerCalls: string[] = []
    ;(pi as unknown as Record<string, unknown>).sendUserMessage = vi.fn(async (msg: string) => {
      steerCalls.push(msg)
      await fs.mkdir(outputDir, { recursive: true })
      // P1 output on first steer
      if (steerCalls.length === 1) {
        await fs.writeFile(path.join(outputDir, 'p1-spec.json'), JSON.stringify({
          phase: 'P1',
          spec: 'A todo app for personal task management with reminders',
          stackAdr: 'Node.js + Express + SQLite',
          webResearch: [],
        }))
      }
    })

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: makeNullVerifier(),
      gitOps: makeNullGitOps(),
      judge: makeNullJudge(),
      transparency: makeNullTransparency(),
      dialogueTimeoutMs: 200,
      steerTimeoutMs: 400,
      registry,
    })
    ctrl.wire()

    // ctx WITH hasUI=true + ui.input returning 3 intent answers
    const inputMock = vi.fn()
      .mockResolvedValueOnce('wiring-test-use-case')
      .mockResolvedValueOnce('solo')
      .mockResolvedValueOnce('just me')

    const ctx: ExtensionContext = {
      hasUI: true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), input: inputMock },
      compact: vi.fn(({ onComplete }: { onComplete: () => void }) => {
        setImmediate(onComplete)
      }),
    } as unknown as ExtensionContext

    await fire('session_start', makeSessionStartEvent(), ctx)
    void fire('input', makeInputEvent('Build a brand new wiring test project'), ctx)

    // Wait for P1 steer to fire
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 6_000
      const check = () => {
        if (steerCalls.length >= 1 || Date.now() > deadline) resolve()
        else setTimeout(check, 20)
      }
      check()
    })

    // Assert intent was wired into P1 instruction
    expect(steerCalls.length).toBeGreaterThanOrEqual(1)
    expect(steerCalls[0]).toContain('wiring-test-use-case')

    await waitForLockRelease(tmpDir, 8_000)
    process.chdir(origCwd)
  }, 20_000)
})

// ════════════════════════════════════════════════════════════════════════════════
// Task 4 — /autodev-status includes intentCaptured
// ════════════════════════════════════════════════════════════════════════════════

describe('B3b Task4: /autodev-status includes intentCaptured', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'b3b-status-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('status JSON includes intentCaptured=false by default', async () => {
    const { pi, handlers } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.registerCommands()

    const notifyMock = vi.fn()
    const ctx = {
      ui: { setStatus: vi.fn(), notify: notifyMock },
    } as unknown as ExtensionContext & { ui: { notify: typeof notifyMock } }

    // Fire the /autodev-status command
    const allCalls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { handler: (args: string, ctx: unknown) => Promise<void> }]>
    const statusEntry = allCalls.find((c) => c[0] === '/autodev-status')
    const cmdHandler = statusEntry?.[1]?.handler
    expect(cmdHandler).toBeDefined()
    await cmdHandler!('', ctx)

    const notifyArg = notifyMock.mock.calls[0]?.[0]
    const status = JSON.parse(notifyArg)
    expect(status).toHaveProperty('intentCaptured', false)
  })

  it('status JSON includes intentCaptured=true after intent is set', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.registerCommands()

    // Set currentIntent directly
    const c = ctrl as unknown as { currentIntent: { useCase: string } }
    c.currentIntent = { useCase: 'a todo app' }

    const notifyMock = vi.fn()
    const ctx = {
      ui: { setStatus: vi.fn(), notify: notifyMock },
    } as unknown as ExtensionContext & { ui: { notify: typeof notifyMock } }

    const allCalls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { handler: (args: string, ctx: unknown) => Promise<void> }]>
    const statusEntry = allCalls.find((c) => c[0] === '/autodev-status')
    const cmdHandler = statusEntry?.[1]?.handler
    await cmdHandler!('', ctx)

    const notifyArg = notifyMock.mock.calls[0]?.[0]
    const status = JSON.parse(notifyArg)
    expect(status).toHaveProperty('intentCaptured', true)
  })

  it('status JSON does not break existing fields', async () => {
    const { pi } = makeMockPi()
    const ctrl = makeController(pi, { repoRoot: tmpDir })
    ctrl.registerCommands()

    const notifyMock = vi.fn()
    const ctx = {
      ui: { setStatus: vi.fn(), notify: notifyMock },
    } as unknown as ExtensionContext & { ui: { notify: typeof notifyMock } }

    const allCalls = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { handler: (args: string, ctx: unknown) => Promise<void> }]>
    const statusEntry = allCalls.find((c) => c[0] === '/autodev-status')
    const cmdHandler = statusEntry?.[1]?.handler
    await cmdHandler!('', ctx)

    const notifyArg = notifyMock.mock.calls[0]?.[0]
    const status = JSON.parse(notifyArg)
    // Existing fields still present
    expect(status).toHaveProperty('phase')
    expect(status).toHaveProperty('laneStatus')
    expect(status).toHaveProperty('gear')
    expect(status).toHaveProperty('phaseByPhase')
    expect(status).toHaveProperty('repoRoot')
  })
})
