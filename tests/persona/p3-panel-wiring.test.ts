import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { P3Plan } from '../../src/phases/p3-plan.js'
import type { PersonaPanel } from '../../src/persona/persona-panel.js'
import type { HostAgent } from '../../src/host/host-agent.js'
import type { P3Context, PersonaDebateEntry } from '../../src/phases/phase-output.js'
import { tierSizing } from '../../src/engine/complexity.js'

const P1 = {
  phase: 'P1' as const,
  spec: 'Build a rate limiter with token-bucket and sliding-window modes.',
  stackAdr: 'TypeScript, vitest.',
  webResearch: [{ url: 'u', title: 'Rate limiting patterns', summary: 'token bucket vs sliding window' }],
  complexity: { files: 3, novelty: 'med' as const, blastRadius: 2, irreversibility: 'low' as const, rationale: 'mid' },
}
const P2 = { phase: 'P2' as const, domainModel: 'Bucket, Window, Limiter entities.', personaDebate: [] }

function ctxFor(panelPersonas: number): P3Context {
  return { phase: 'P3', p1: P1, p2: P2, sizing: { ...tierSizing('M'), panelPersonas } } as P3Context
}

const VALID_P3 = {
  phase: 'P3',
  fileDAG: [{ file: 'src/limiter.ts', lane: 0, deps: [] }],
  panelObjCount: 0,
  sprintContract: { goal: 'ship a correct rate limiter', successCriteria: ['both modes work'], outOfScope: ['distributed'] },
  examplesTable: [{ scenario: 'burst', input: '10 reqs', expectedOutput: 'throttled' }],
}

/** Host writes a valid plan on each steer; records prompts for assertions. */
function mockHost(): HostAgent & { prompts: string[] } {
  const prompts: string[] = []
  const host = {
    prompts,
    steer: vi.fn(async (prompt: string, opts: { expectFile?: string }) => {
      prompts.push(prompt)
      await fs.writeFile(opts.expectFile!, JSON.stringify(VALID_P3))
      return { rawText: 'P3 output written', toolResults: [], seq: 1 }
    }),
  }
  return host as unknown as HostAgent & { prompts: string[] }
}

/** Panel whose dispatch returns a scripted sequence of debates (one per round). */
function scriptedPanel(rounds: PersonaDebateEntry[][]): PersonaPanel {
  let i = 0
  return {
    select: vi.fn(async (_idea: string, cands: string[], max: number) => cands.slice(0, max)),
    dispatch: vi.fn(async () => rounds[Math.min(i++, rounds.length - 1)]),
  } as unknown as PersonaPanel
}
const obj = (persona: string, ...objections: string[]): PersonaDebateEntry => ({ persona, stance: '', objections })

describe('P3 panel wiring', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-panel-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('accepts in round 1 when the panel raises no objections, writing panelObjCount=0', async () => {
    const panel = scriptedPanel([[obj('user'), obj('developer')]]) // no objections
    const res = await new P3Plan(mockHost(), dir, undefined, panel).execute(ctxFor(2))
    expect(res.ok).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'p3-plan.json'), 'utf-8'))
    expect(onDisk.panelObjCount).toBe(0)
  })

  it('panelObjCount is the authoritative sum of panel objections (R4)', async () => {
    const panel = scriptedPanel([[obj('user', 'a', 'b'), obj('security', 'c')], []])
    const host = mockHost()
    await new P3Plan(host, dir, undefined, panel).execute(ctxFor(2))
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'p3-plan.json'), 'utf-8'))
    // round 1 had 3 objections → re-plan; round 2 (empty) → converges with count 0
    expect(onDisk.panelObjCount).toBe(0)
  })

  it('feeds real objection text into the re-plan round (R7)', async () => {
    const panel = scriptedPanel([[obj('security', 'ReDoS in the window regex')], []])
    const host = mockHost()
    await new P3Plan(host, dir, undefined, panel).execute(ctxFor(2))
    // second steer prompt must contain the actual objection text, not just a count
    expect(host.prompts[1]).toContain('ReDoS in the window regex')
    expect(host.prompts[1]).toContain('security')
  })

  it('caps at 3 rounds with persistent objections and returns an operator brief', async () => {
    const panel = scriptedPanel([[obj('user', 'x')]]) // always 1 objection
    const res = await new P3Plan(mockHost(), dir, undefined, panel).execute(ctxFor(2))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/re-plan cap/i)
      expect(res.operatorBrief?.roundsAttempted).toBe(3)
    }
  })

  it('selects panelCount = min(panelPersonas*2, 10) candidates', async () => {
    const panel = scriptedPanel([[]])
    await new P3Plan(mockHost(), dir, undefined, panel).execute(ctxFor(2)) // 2*2=4
    expect(panel.select).toHaveBeenCalledWith(P1.spec, expect.any(Array), 4)
  })

  it('XS (panelPersonas=0) skips the panel and uses the host count', async () => {
    const panel = scriptedPanel([[obj('user', 'x')]])
    const res = await new P3Plan(mockHost(), dir, undefined, panel).execute(ctxFor(0))
    expect(panel.dispatch).not.toHaveBeenCalled()
    expect(res.ok).toBe(true) // host wrote panelObjCount=0
  })
})
