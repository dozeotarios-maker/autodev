// Stage E: tests for principles constants + injection into all code-producing steers + P5 reviewer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  MINIMALISM_DIRECTIVE,
  CRAFTSMANSHIP_DIRECTIVE,
  MINIMALISM_REVIEW_LENS,
  CRAFTSMANSHIP_REVIEW_LENS,
} from '../src/principles.js'
import { Controller } from '../src/host/controller.js'
import type { ControllerOptions } from '../src/host/controller.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
  AgentEndEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import type { Transparency } from '../src/ports.js'
import { P3Plan } from '../src/phases/p3-plan.js'
import { P4Build } from '../src/phases/p4-build.js'
import { P5Verify } from '../src/phases/p5-verify.js'
import { D3Fix } from '../src/debug/d3-fix.js'
import { R2Transform } from '../src/refactor/r2-transform.js'
import type { HostAgent } from '../src/host/host-agent.js'
import type { Verifier, Judge } from '../src/ports.js'
import type { P3Context, P4Context, P5Context, P3Output, P4Output } from '../src/phases/phase-output.js'
import type { D1Output, D2Output } from '../src/debug/debug-output.js'
import type { R1Output } from '../src/refactor/refactor-output.js'
import { tierSizing } from '../src/engine/complexity.js'

// ── Task 1: constants are non-empty and contain key phrases ───────────────────

describe('principles constants', () => {
  it('MINIMALISM_DIRECTIVE is non-empty and contains key phrases', () => {
    expect(MINIMALISM_DIRECTIVE).toBeTruthy()
    expect(MINIMALISM_DIRECTIVE).toContain('SMALLEST')
    expect(MINIMALISM_DIRECTIVE).toContain('YAGNI')
  })

  it('CRAFTSMANSHIP_DIRECTIVE is non-empty and contains key phrases', () => {
    expect(CRAFTSMANSHIP_DIRECTIVE).toBeTruthy()
    expect(CRAFTSMANSHIP_DIRECTIVE).toContain('senior')
    expect(CRAFTSMANSHIP_DIRECTIVE).toContain('AI-slop')
    expect(CRAFTSMANSHIP_DIRECTIVE).toContain('MATCH')
  })

  it('MINIMALISM_REVIEW_LENS is non-empty and contains key phrase', () => {
    expect(MINIMALISM_REVIEW_LENS).toBeTruthy()
    expect(MINIMALISM_REVIEW_LENS).toContain('flag')
  })

  it('CRAFTSMANSHIP_REVIEW_LENS is non-empty and contains key phrase', () => {
    expect(CRAFTSMANSHIP_REVIEW_LENS).toBeTruthy()
    expect(CRAFTSMANSHIP_REVIEW_LENS).toContain('flag')
  })
})

// ── Shared mock factory ───────────────────────────────────────────────────────

function makeMockAgent(
  fileWriteCallback?: (expectFile: string) => Promise<void>
): { agent: HostAgent; steerCalls: Array<{ prompt: string }> } {
  const steerCalls: Array<{ prompt: string }> = []
  const agent = {
    steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
      steerCalls.push({ prompt })
      if (opts.expectFile && fileWriteCallback) {
        await fileWriteCallback(opts.expectFile)
      }
      return { rawText: 'mock', toolResults: [], seq: steerCalls.length }
    }),
    _onAgentEnd: vi.fn(),
    _onTurnEnd: vi.fn(),
  } as unknown as HostAgent
  return { agent, steerCalls }
}

// ── Task 2: directives injected into each code-producing steer ────────────────

describe('P3 instruction contains both directives', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-prin-')) })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('steer prompt contains YAGNI and senior', async () => {
    const p3Output = {
      phase: 'P3',
      fileDAG: [{ file: 'src/foo.ts', lane: 0, deps: [] }],
      panelObjCount: 0,
      sprintContract: { goal: 'Build a thing that works', successCriteria: ['passes tests'], outOfScope: [] },
      examplesTable: [{ scenario: 'basic', input: 'x', expectedOutput: 'y' }],
    }
    const { agent, steerCalls } = makeMockAgent(async (f) => {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify(p3Output))
    })
    const ctx: P3Context = {
      phase: 'P3',
      p1: { phase: 'P1', spec: 'spec', stackAdr: 'adr', webResearch: [] },
      p2: { phase: 'P2', domainModel: 'model', personaDebate: [] },
      sizing: tierSizing('XS'),
    }
    const p3 = new P3Plan(agent, tmpDir)
    await p3.execute(ctx)
    const prompt = steerCalls[0].prompt
    expect(prompt).toContain('YAGNI')
    expect(prompt).toContain('senior')
  })
})

describe('P4 instruction contains both directives', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-prin-')) })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('steer prompt contains YAGNI and senior', async () => {
    const p4Output = {
      phase: 'P4',
      laneResults: [{ laneId: 0, status: 'success', files: ['src/foo.ts'], output: 'done' }],
      artifacts: ['src/foo.ts'],
    }
    const { agent, steerCalls } = makeMockAgent(async (f) => {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify(p4Output))
    })
    const mockP3: P3Output = {
      phase: 'P3',
      fileDAG: [{ file: 'src/foo.ts', lane: 0, deps: [] }],
      panelObjCount: 0,
      sprintContract: { goal: 'Build a thing', successCriteria: ['passes'], outOfScope: [] },
      examplesTable: [{ scenario: 'basic', input: 'x', expectedOutput: 'y' }],
    }
    const ctx: P4Context = { phase: 'P4', p3: mockP3, sizing: tierSizing('XS') }
    const p4 = new P4Build(agent, tmpDir)
    await p4.execute(ctx)
    const prompt = steerCalls[0].prompt
    expect(prompt).toContain('YAGNI')
    expect(prompt).toContain('senior')
  })
})

describe('D3 instruction contains both directives', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd3-prin-')) })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('steer prompt contains YAGNI and senior', async () => {
    const d3Output = { fixSummary: 'fixed it', filesChanged: ['src/foo.ts'] }
    const { agent, steerCalls } = makeMockAgent(async (f) => {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify(d3Output))
    })
    const d1: D1Output = {
      reproSummary: 'repro summary',
      reproCommand: 'npx vitest run tests/repro.test.ts',
      reproArtifact: 'tests/repro.test.ts',
    }
    const d2: D2Output = {
      rootCause: 'null pointer in auth',
      rootCauseLocation: 'src/auth.ts:42',
      hypotheses: [
        { claim: 'off-by-one', evidenceFor: 'index wraps', evidenceAgainst: 'tests pass individually' },
        { claim: 'null token', evidenceFor: 'crash on undefined', evidenceAgainst: 'token logged present' },
      ],
    }
    const d3 = new D3Fix(agent, tmpDir)
    await d3.execute('bug report text', d1, d2)
    const prompt = steerCalls[0].prompt
    expect(prompt).toContain('YAGNI')
    expect(prompt).toContain('senior')
  })
})

describe('R2 instruction contains both directives', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-prin-')) })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('steer prompt contains YAGNI and senior', async () => {
    const r2Output = { transformSummary: 'extracted function', filesChanged: ['src/foo.ts'] }
    const { agent, steerCalls } = makeMockAgent(async (f) => {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify(r2Output))
    })
    const r1: R1Output = {
      characterizationSummary: 'pins auth behavior',
      characterizationCommand: 'npx vitest run tests/char.test.ts',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    }
    const r2 = new R2Transform(agent, tmpDir)
    await r2.execute('extract auth logic', r1)
    const prompt = steerCalls[0].prompt
    expect(prompt).toContain('YAGNI')
    expect(prompt).toContain('senior')
  })
})

// ── Quick-seed instruction contains both directives ───────────────────────────

function makeNullTransparency(): Transparency {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    setHudStatus: vi.fn(),
    recordMetric: vi.fn().mockResolvedValue(undefined),
  }
}

async function waitForLockRelease(tmpDir: string, timeoutMs = 6_000): Promise<void> {
  const lockPath = path.join(tmpDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fs.access(lockPath).then(() => true).catch(() => false)) break
    await new Promise((r) => setTimeout(r, 10))
  }
  while (Date.now() < deadline) {
    if (!(await fs.access(lockPath).then(() => true).catch(() => false))) break
    await new Promise((r) => setTimeout(r, 15))
  }
  await new Promise((r) => setTimeout(r, 25))
}

describe('quick-gear seed instruction contains both directives', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qs-prin-')) })
  afterEach(async () => {
    await waitForLockRelease(tmpDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('seed steer prompt contains YAGNI and senior (times out fast)', async () => {
    type EventHandler = (event: unknown, ctx: unknown) => unknown
    const handlers: Record<string, EventHandler> = {}
    const sendUserMessageCalls: string[] = []
    const pi = {
      on: vi.fn((event: string, handler: EventHandler) => { handlers[event] = handler }),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn((content: string) => { sendUserMessageCalls.push(content) }),
    } as unknown as ExtensionAPI
    const fire = (event: string, e: unknown, ctx: unknown) => handlers[event]?.(e, ctx)

    const ctx = {
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      compact: vi.fn(({ onComplete }: { onComplete: () => void; onError: (e: Error) => void }) => { setImmediate(onComplete) }),
    } as unknown as ExtensionContext

    const ctrl = new Controller(pi, {
      repoRoot: tmpDir,
      verifier: {
        runDeterministic: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: '' }),
        runMutation: vi.fn().mockResolvedValue({ score: 1.0, passed: true }),
        runHoldout: vi.fn().mockResolvedValue({ passed: true, output: '' }),
        runSecurityScan: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
      },
      gitOps: {
        scopedCommit: vi.fn().mockResolvedValue({ sha: 'abc' }),
        perPhasePush: vi.fn().mockResolvedValue(undefined),
        tierDGate: vi.fn().mockResolvedValue(true),
        scanSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
        changedFiles: vi.fn().mockResolvedValue([]),
      },
      judge: {
        isDone: vi.fn().mockResolvedValue(true),
        isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
      },
      transparency: makeNullTransparency(),
      steerTimeoutMs: 50, // times out immediately → escalates; seed steer prompt is captured
    } as ControllerOptions)
    ctrl.wire()

    await fire('session_start', { type: 'session_start' } as SessionStartEvent, ctx)
    void fire('input', { type: 'input', text: 'quick: add a slugify function', source: 'interactive' } as InputEvent, ctx)

    await waitForLockRelease(tmpDir)

    // Seed steer is the first sendUserMessage call in quick gear
    expect(sendUserMessageCalls.length).toBeGreaterThan(0)
    const seedPrompt = sendUserMessageCalls[0]
    expect(seedPrompt).toContain('YAGNI')
    expect(seedPrompt).toContain('senior')
  }, 15_000)
})

// ── Task 3: P5 reviewer instruction contains both review lenses ───────────────

describe('P5 reviewer instruction contains both lenses', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p5-prin-')) })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('reviewer task contains MINIMALISM CHECK and CRAFTSMANSHIP CHECK', async () => {
    const p5Output = {
      phase: 'P5',
      verifyReport: { deterministicPassed: true, holdoutPassed: true, mutationScore: 1.0, securityClean: true },
      reviewFindings: [],
    }
    const { agent, steerCalls } = makeMockAgent(async (f) => {
      await fs.mkdir(path.dirname(f), { recursive: true })
      await fs.writeFile(f, JSON.stringify(p5Output))
    })
    const verifier: Verifier = {
      runDeterministic: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: '' }),
      runMutation: vi.fn().mockResolvedValue({ score: 1.0, passed: true }),
      runHoldout: vi.fn().mockResolvedValue({ passed: true, output: '' }),
      runSecurityScan: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
    }
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const mockP3: P3Output = {
      phase: 'P3',
      fileDAG: [{ file: 'src/foo.ts', lane: 0, deps: [] }],
      panelObjCount: 0,
      sprintContract: { goal: 'Build a thing', successCriteria: ['passes'], outOfScope: [] },
      examplesTable: [{ scenario: 'basic', input: 'x', expectedOutput: 'y' }],
    }
    const mockP4: P4Output = {
      phase: 'P4',
      laneResults: [{ laneId: 0, status: 'success', files: ['src/foo.ts'], output: 'done' }],
      artifacts: ['src/foo.ts'],
    }
    const ctx: P5Context = {
      phase: 'P5',
      p3: mockP3,
      p4: mockP4,
      sizing: tierSizing('XS'),
      repoRoot: tmpDir,
    }
    const p5 = new P5Verify(agent, tmpDir, verifier, judge, tmpDir)
    await p5.execute(ctx)
    const prompt = steerCalls[0].prompt
    expect(prompt).toContain('MINIMALISM CHECK')
    expect(prompt).toContain('CRAFTSMANSHIP CHECK')
  })
})
