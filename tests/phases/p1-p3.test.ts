// S2-M3a: Phase executor tests — P1 DISCOVER, P2 ELABORATE, P3 PLAN
//
// Strategy: mock HostAgent; test fires synthetic agent_end AND writes the phase file;
// assert steer prompt contains role directives + PhaseContext + target file path;
// assert schema validation, gate, and re-plan loop cap.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { P1Discover, buildP1Instruction } from '../../src/phases/p1-discover.js'
import { P2Elaborate, buildP2Instruction } from '../../src/phases/p2-elaborate.js'
import { P3Plan } from '../../src/phases/p3-plan.js'
import type { HostAgent } from '../../src/host/host-agent.js'
import type { P1Context, P2Context, P3Context } from '../../src/phases/phase-output.js'

// ── Mock HostAgent factory ────────────────────────────────────────────────────

function makeMockHostAgent(
  fileWriteCallback?: (expectFile: string) => Promise<void>
): { agent: HostAgent; steerCalls: Array<{ prompt: string; expectFile?: string }> } {
  const steerCalls: Array<{ prompt: string; expectFile?: string }> = []

  const agent = {
    steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
      steerCalls.push({ prompt, expectFile: opts.expectFile })
      if (opts.expectFile && fileWriteCallback) {
        await fileWriteCallback(opts.expectFile)
      }
      return { rawText: 'mock response', toolResults: [], seq: steerCalls.length }
    }),
    _onAgentEnd: vi.fn(),
    _onTurnEnd: vi.fn(),
  } as unknown as HostAgent

  return { agent, steerCalls }
}

// ── P1 DISCOVER ───────────────────────────────────────────────────────────────

describe('S2-M3a: P1Discover', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p1-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('steer prompt contains role directives + idea + target file path', async () => {
    const ctx: P1Context = { phase: 'P1', idea: 'Build a todo REST API' }

    const { agent, steerCalls } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P1',
        spec: 'A RESTful API for managing todo items with CRUD operations',
        stackAdr: 'Node.js + Express + PostgreSQL stack chosen for its ecosystem',
        webResearch: [{ url: 'https://example.com', title: 'REST API best practices', summary: 'Best practices' }],
      }))
    })

    const p1 = new P1Discover(agent, tmpDir)
    const result = await p1.execute(ctx)

    expect(result.ok).toBe(true)
    expect(result.output?.phase).toBe('P1')
    expect(result.output?.spec).toBeTruthy()

    // Assert steer prompt content
    const { prompt, expectFile } = steerCalls[0]
    expect(prompt).toContain('P1 DISCOVER')
    expect(prompt).toContain('Build a todo REST API')
    expect(prompt).toContain('p1-spec.json')
    expect(expectFile).toContain('p1-spec.json')
  })

  it('buildP1Instruction contains the idea and output file path', () => {
    const ctx: P1Context = { phase: 'P1', idea: 'My test idea' }
    const instruction = buildP1Instruction(ctx, '/tmp/p1-spec.json')

    expect(instruction).toContain('My test idea')
    expect(instruction).toContain('/tmp/p1-spec.json')
    expect(instruction).toContain('P1 DISCOVER')
    expect(instruction).toContain('webResearch')
  })

  it('reads and schema-validates the phase file', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P1',
        spec: 'Valid spec with enough content to pass gate',
        stackAdr: 'Valid ADR with enough content',
        webResearch: [],
      }))
    })

    const p1 = new P1Discover(agent, tmpDir)
    const result = await p1.execute({ phase: 'P1', idea: 'test' })

    expect(result.ok).toBe(true)
    expect(result.output?.phase).toBe('P1')
  })

  it('fails when output file is missing after steer', async () => {
    // Agent does NOT write the file — steer() will throw after retries
    const agent = {
      steer: vi.fn().mockRejectedValue(new Error('Steer validation failed (attempt 3/3): expectFile missing')),
    } as unknown as HostAgent

    const p1 = new P1Discover(agent, tmpDir)
    const result = await p1.execute({ phase: 'P1', idea: 'test' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('steer failed')
  })

  it('gate fails when spec is too short', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P1',
        spec: 'short',
        stackAdr: 'short stack',
        webResearch: [],
      }))
    })

    const p1 = new P1Discover(agent, tmpDir)
    const result = await p1.execute({ phase: 'P1', idea: 'test' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('gate')
  })

  it('returns typed PhaseOutput with P1 discriminant', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P1',
        spec: 'A comprehensive spec for a weather app with forecast features',
        stackAdr: 'Python FastAPI with Redis caching for performance',
        webResearch: [{ url: 'https://weather.gov', title: 'Weather API', summary: 'Official weather data' }],
      }))
    })

    const p1 = new P1Discover(agent, tmpDir)
    const result = await p1.execute({ phase: 'P1', idea: 'weather app' })

    expect(result.ok).toBe(true)
    if (result.ok && result.output) {
      // TypeScript discriminant check
      const output = result.output
      expect(output.phase).toBe('P1')
      expect(Array.isArray(output.webResearch)).toBe(true)
    }
  })
})

// ── P2 ELABORATE ─────────────────────────────────────────────────────────────

describe('S2-M3a: P2Elaborate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeP2Context = (): P2Context => ({
    phase: 'P2',
    p1: {
      phase: 'P1',
      spec: 'A REST API for managing todo items with full CRUD support',
      stackAdr: 'Node.js + Express chosen for its ecosystem and community support',
      webResearch: [],
    },
  })

  it('steer prompt contains role directives + P1 spec + target file path', async () => {
    const { agent, steerCalls } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P2',
        domainModel: 'Todo entity with id, title, done, createdAt. User entity with auth.',
        personaDebate: [
          { persona: 'user', stance: 'positive', objections: ['need auth'] },
        ],
      }))
    })

    const p2 = new P2Elaborate(agent, tmpDir)
    const result = await p2.execute(makeP2Context())

    expect(result.ok).toBe(true)
    const { prompt, expectFile } = steerCalls[0]
    expect(prompt).toContain('P2 ELABORATE')
    expect(prompt).toContain('subagent')
    expect(prompt).toContain('p2-domain.json')
    expect(expectFile).toContain('p2-domain.json')
  })

  it('buildP2Instruction contains persona panel instruction', () => {
    const ctx = makeP2Context()
    const instruction = buildP2Instruction(ctx, '/tmp/p2-domain.json')
    expect(instruction).toContain('subagent')
    expect(instruction).toContain('user')
    expect(instruction).toContain('security')
    expect(instruction).toContain('/tmp/p2-domain.json')
  })

  it('P2 panel runs as parallel subagents (instruction contains subagent tool call)', async () => {
    const { agent, steerCalls } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P2',
        domainModel: 'Todo, User, Tag entities with relationships',
        personaDebate: [
          { persona: 'developer', stance: 'positive', objections: [] },
          { persona: 'security', stance: 'concern', objections: ['need rate limiting'] },
        ],
      }))
    })

    const p2 = new P2Elaborate(agent, tmpDir)
    await p2.execute(makeP2Context())

    // The instruction should instruct the host to use the subagent tool
    expect(steerCalls[0].prompt).toContain('subagent')
    expect(steerCalls[0].prompt).toContain('concurrency')
  })

  it('gate fails when domainModel is empty', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P2',
        domainModel: 'short',
        personaDebate: [],
      }))
    })

    const p2 = new P2Elaborate(agent, tmpDir)
    const result = await p2.execute(makeP2Context())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('gate')
  })

  it('returns typed P2Output with personaDebate array', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P2',
        domainModel: 'Todo entity with title, completed, priority. User with roles.',
        personaDebate: [
          { persona: 'user', stance: 'good', objections: ['want mobile app'] },
          { persona: 'ops', stance: 'neutral', objections: ['need monitoring'] },
        ],
      }))
    })

    const p2 = new P2Elaborate(agent, tmpDir)
    const result = await p2.execute(makeP2Context())

    expect(result.ok).toBe(true)
    expect(result.output?.phase).toBe('P2')
    expect(result.output?.personaDebate.length).toBe(2)
  })
})

// ── P3 PLAN ──────────────────────────────────────────────────────────────────

describe('S2-M3a: P3Plan', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeP3Context = (): P3Context => ({
    phase: 'P3',
    p1: {
      phase: 'P1',
      spec: 'A REST API for managing todo items with full CRUD support and auth',
      stackAdr: 'Node.js + Express with PostgreSQL and JWT authentication',
      webResearch: [],
    },
    p2: {
      phase: 'P2',
      domainModel: 'Todo entity with title, completed, userId. User with email, password hash.',
      personaDebate: [
        { persona: 'developer', stance: 'positive', objections: [] },
      ],
    },
  })

  const makeP3Output = (panelObjCount = 0) => ({
    phase: 'P3',
    fileDAG: [
      { file: 'src/routes/todos.ts', lane: 0, deps: [] },
      { file: 'src/models/todo.ts', lane: 0, deps: [] },
    ],
    panelObjCount,
    sprintContract: {
      goal: 'Build a fully functional todo REST API with authentication and CRUD operations',
      successCriteria: ['All endpoints return correct status codes', 'JWT auth works'],
      outOfScope: ['Frontend', 'Mobile app'],
    },
    examplesTable: [
      { scenario: 'Create todo', input: 'POST /todos {title}', expectedOutput: '201 {id, title, completed: false}' },
    ],
  })

  it('steer prompt contains role directives + P1 spec + P2 domain + target file path', async () => {
    const { agent, steerCalls } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify(makeP3Output(0)))
    })

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(true)
    const { prompt } = steerCalls[0]
    expect(prompt).toContain('P3 PLAN')
    expect(prompt).toContain('subagent')
    expect(prompt).toContain('p3-plan.json')
  })

  it('accepts plan when panel has zero objections (first round)', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify(makeP3Output(0)))
    })

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.panelObjCount).toBe(0)
    }
  })

  it('re-plans when panel has objections (caps at 3 rounds)', async () => {
    let callCount = 0
    const agent = {
      steer: vi.fn(async (_prompt: string, opts: { expectFile?: string } = {}) => {
        callCount++
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          // Always write panelObjCount > 0 to force re-plan
          await fs.writeFile(opts.expectFile, JSON.stringify(makeP3Output(3)))
        }
        return { rawText: 'P3 output written', toolResults: [], seq: callCount }
      }),
    } as unknown as HostAgent

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    // Should fail after 3 rounds with operator brief
    expect(result.ok).toBe(false)
    expect(callCount).toBe(3) // exactly 3 attempts
    expect('operatorBrief' in result).toBe(true)
    if (!result.ok && 'operatorBrief' in result) {
      expect(result.operatorBrief?.roundsAttempted).toBe(3)
    }
  }, 10_000)

  it('P3 re-plan includes revision context in second steer', async () => {
    const steerPrompts: string[] = []
    let callCount = 0

    const agent = {
      steer: vi.fn(async (prompt: string, opts: { expectFile?: string } = {}) => {
        steerPrompts.push(prompt)
        callCount++
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          // First call: 2 objections; second call: 0 (accepts)
          const objCount = callCount === 1 ? 2 : 0
          await fs.writeFile(opts.expectFile, JSON.stringify(makeP3Output(objCount)))
        }
        return { rawText: 'done', toolResults: [], seq: callCount }
      }),
    } as unknown as HostAgent

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(true)
    expect(callCount).toBe(2)
    // Second steer should contain revision context
    expect(steerPrompts[1]).toContain('Revision context')
  }, 10_000)

  it('P3 emits sprint contract + file-DAG + examples table', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify(makeP3Output(0)))
    })

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.sprintContract.goal).toBeTruthy()
      expect(result.output.sprintContract.successCriteria.length).toBeGreaterThan(0)
      expect(result.output.fileDAG.length).toBeGreaterThan(0)
      expect(result.output.examplesTable.length).toBeGreaterThan(0)
    }
  })

  it('gate fails when sprint contract goal is empty', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P3',
        fileDAG: [{ file: 'src/index.ts', lane: 0, deps: [] }],
        panelObjCount: 0,
        sprintContract: { goal: 'short', successCriteria: ['ok'], outOfScope: [] },
        examplesTable: [{ scenario: 'test', input: 'x', expectedOutput: 'y' }],
      }))
    })

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('goal')
    }
  })

  it('gate fails when file-DAG is empty', async () => {
    const { agent } = makeMockHostAgent(async (expectFile) => {
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify({
        phase: 'P3',
        fileDAG: [],
        panelObjCount: 0,
        sprintContract: {
          goal: 'Build a fully featured REST API for todo management',
          successCriteria: ['All endpoints work'],
          outOfScope: [],
        },
        examplesTable: [{ scenario: 'test', input: 'x', expectedOutput: 'y' }],
      }))
    })

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('file-DAG')
    }
  })

  it('operator brief includes roundsAttempted and lastOutput after cap', async () => {
    const lastOutput = makeP3Output(5)
    let callCount = 0
    const agent = {
      steer: vi.fn(async (_prompt: string, opts: { expectFile?: string } = {}) => {
        callCount++
        if (opts.expectFile) {
          await fs.mkdir(path.dirname(opts.expectFile), { recursive: true })
          await fs.writeFile(opts.expectFile, JSON.stringify(lastOutput))
        }
        return { rawText: 'done', toolResults: [], seq: callCount }
      }),
    } as unknown as HostAgent

    const p3 = new P3Plan(agent, tmpDir)
    const result = await p3.execute(makeP3Context())

    expect(result.ok).toBe(false)
    if (!result.ok && 'operatorBrief' in result && result.operatorBrief) {
      expect(result.operatorBrief.roundsAttempted).toBe(3)
      expect(result.operatorBrief.lastOutput).toBeDefined()
      expect(result.operatorBrief.persistentObjections).toBeTruthy()
    }
  }, 10_000)
})
