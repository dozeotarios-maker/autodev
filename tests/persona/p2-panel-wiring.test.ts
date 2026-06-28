import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { P2Elaborate } from '../../src/phases/p2-elaborate.js'
import type { PersonaPanel } from '../../src/persona/persona-panel.js'
import type { HostAgent } from '../../src/host/host-agent.js'
import type { P2Context } from '../../src/phases/phase-output.js'
import { tierSizing } from '../../src/engine/complexity.js'

const P1 = {
  phase: 'P1' as const,
  spec: 'Build a slugify(input) utility with predictable output and tests.',
  stackAdr: 'Zero-dep ES module, node:test.',
  webResearch: [{ url: 'u', title: 'Slugify best practices', summary: 'lowercase ASCII, hyphen separator' }],
  complexity: { files: 1, novelty: 'low' as const, blastRadius: 1, irreversibility: 'low' as const, rationale: 'tiny' },
}

function ctxFor(panelPersonas: number): P2Context {
  return { phase: 'P2', p1: P1, sizing: { ...tierSizing('M'), panelPersonas } } as P2Context
}

/** Mock host that, on steer, writes the expectFile with a valid P2 shell (empty debate). */
function mockHost(): HostAgent {
  return {
    steer: vi.fn(async (_prompt: string, opts: { expectFile?: string }) => {
      await fs.writeFile(opts.expectFile!, JSON.stringify({ phase: 'P2', domainModel: 'D'.repeat(40), personaDebate: [] }))
      return { rawText: 'P2 output written', toolResults: [], seq: 1 }
    }),
  } as unknown as HostAgent
}

function mockPanel(): PersonaPanel {
  return {
    select: vi.fn(async (_idea: string, cands: string[], max: number) => cands.slice(0, max)),
    dispatch: vi.fn(async (personas: string[]) =>
      personas.map((p) => ({ persona: p, stance: `${p} stance`, objections: [`${p} objection`] }))),
  } as unknown as PersonaPanel
}

describe('P2 panel wiring', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2-panel-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('runs the panel and writes its verbatim objections (R4 authoritative)', async () => {
    const panel = mockPanel()
    const p2 = new P2Elaborate(mockHost(), dir, undefined, panel)
    const res = await p2.execute(ctxFor(2))

    expect(res.ok).toBe(true)
    expect(panel.select).toHaveBeenCalledWith(P1.spec, expect.any(Array), 2)
    expect(panel.dispatch).toHaveBeenCalled()
    if (res.ok && res.output) {
      expect(res.output.personaDebate.map((d) => d.persona)).toEqual(['user', 'developer'])
      expect(res.output.personaDebate[0].objections).toEqual(['user objection'])
    }
    // the file on disk carries the panel objections, not the host's empty array
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'p2-domain.json'), 'utf-8'))
    expect(onDisk.personaDebate).toHaveLength(2)
  })

  it('passes P1 web research into the panel context (R1 grounding)', async () => {
    const panel = mockPanel()
    await new P2Elaborate(mockHost(), dir, undefined, panel).execute(ctxFor(2))
    const ctxArg = (panel.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(ctxArg.research).toContain('Slugify best practices')
    expect(ctxArg.domainModel).toContain('D')
  })

  it('XS (panelPersonas=0) skips the panel entirely', async () => {
    const panel = mockPanel()
    const p2 = new P2Elaborate(mockHost(), dir, undefined, panel)
    const res = await p2.execute(ctxFor(0))
    expect(panel.dispatch).not.toHaveBeenCalled()
    // legacy PhaseExecutor path: host wrote empty debate, XS gate relaxes
    expect(res.ok).toBe(true)
  })

  it('with no panel injected, behaves exactly as the legacy path (host-synthesis)', async () => {
    // host writes a non-empty debate (legacy host-synthesis)
    const host = {
      steer: vi.fn(async (_p: string, opts: { expectFile?: string }) => {
        await fs.writeFile(opts.expectFile!, JSON.stringify({ phase: 'P2', domainModel: 'D'.repeat(40), personaDebate: [{ persona: 'user', stance: 's', objections: ['o'] }] }))
        return { rawText: 'ok', toolResults: [], seq: 1 }
      }),
    } as unknown as HostAgent
    const res = await new P2Elaborate(host, dir, undefined /* no panel */).execute(ctxFor(2))
    expect(res.ok).toBe(true)
  })
})
