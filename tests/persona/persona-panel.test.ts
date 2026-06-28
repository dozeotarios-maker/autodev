import { describe, it, expect } from 'vitest'
import { PersonaPanel, parseObjectionJson } from '../../src/persona/persona-panel.js'
import type { PersonaSessionRunner, PersonaRunResult, PersonaContext, PersonaDebateEntry } from '../../src/persona/types.js'
import { DEFAULT_PERSONA_CONFIG, type PersonaConfig } from '../../src/persona/persona-config.js'

const CTX: PersonaContext = { phase: 'P2', idea: 'add a slugify function' }
const cfg = (over: Partial<PersonaConfig> = {}): PersonaConfig => ({ ...DEFAULT_PERSONA_CONFIG, ...over })
const okReply = (objs: string[]): PersonaRunResult => ({ ok: true, text: JSON.stringify({ stance: 's', objections: objs }) })

interface MockRunner extends PersonaSessionRunner { calls: number }
function mockRunner(impl: (sys: string, task: string) => Promise<PersonaRunResult>): MockRunner {
  const r: MockRunner = {
    calls: 0,
    async run(sys, task) { r.calls++; return impl(sys, task) },
  }
  return r
}
const failHost = async (): Promise<PersonaDebateEntry[]> => { throw new Error('hostSynthesize must not be called') }

describe('PersonaPanel.dispatch', () => {
  it('runs each persona once and parses objections, order preserved, no fallback', async () => {
    const runner = mockRunner(async (_s, task) => okReply([`obj for ${task.includes('slugify') ? 'x' : 'y'}`]))
    const panel = new PersonaPanel({ runner, config: cfg(), hostSynthesize: failHost })
    const out = await panel.dispatch(['user', 'developer', 'security'], CTX)
    expect(out.map((o) => o.persona)).toEqual(['user', 'developer', 'security'])
    expect(out.every((o) => o.objections.length === 1)).toBe(true)
    expect(runner.calls).toBe(3)
  })

  it('retries on rate_limit then succeeds', async () => {
    let n = 0
    const runner = mockRunner(async () => (++n < 2 ? { ok: false, text: '', failure: 'rate_limit' } : okReply(['ok'])))
    const panel = new PersonaPanel({ runner, config: cfg({ maxRetries: 2 }), hostSynthesize: failHost })
    const out = await panel.dispatch(['user'], CTX)
    expect(out[0].objections).toEqual(['ok'])
    expect(runner.calls).toBe(2) // one rate_limit + one success
  })

  it('falls back to host-synthesis for a persona that always fails', async () => {
    const runner = mockRunner(async () => ({ ok: false, text: '', failure: 'error' }))
    let hostNames: string[] = []
    const panel = new PersonaPanel({
      runner,
      config: cfg({ maxRetries: 0 }),
      hostSynthesize: async (names) => { hostNames = names; return names.map((p) => ({ persona: p, stance: 'host', objections: ['h'] })) },
    })
    const out = await panel.dispatch(['user', 'developer'], CTX)
    expect(hostNames).toEqual(['user', 'developer'])
    expect(out.every((o) => o.stance === 'host')).toBe(true)
  })

  it('config.enabled=false routes everything to host-synthesis, runner untouched', async () => {
    const runner = mockRunner(async () => okReply(['nope']))
    const panel = new PersonaPanel({
      runner,
      config: cfg({ enabled: false }),
      hostSynthesize: async (names) => names.map((p) => ({ persona: p, stance: 'h', objections: [] })),
    })
    const out = await panel.dispatch(['user'], CTX)
    expect(runner.calls).toBe(0)
    expect(out[0].stance).toBe('h')
  })

  it('fallbackToHost=false yields empty objections without calling host', async () => {
    const runner = mockRunner(async () => ({ ok: false, text: '', failure: 'error' }))
    const panel = new PersonaPanel({ runner, config: cfg({ maxRetries: 0, fallbackToHost: false }), hostSynthesize: failHost })
    const out = await panel.dispatch(['user'], CTX)
    expect(out[0].objections).toEqual([])
  })

  it('circuit breaker short-circuits remaining personas after 3 consecutive failures', async () => {
    const runner = mockRunner(async () => ({ ok: false, text: '', failure: 'error' }))
    let hostCount = 0
    const panel = new PersonaPanel({
      runner,
      config: cfg({ maxRetries: 0, concurrency: 1 }),
      hostSynthesize: async (names) => { hostCount = names.length; return names.map((p) => ({ persona: p, stance: '', objections: [] })) },
    })
    const out = await panel.dispatch(['user', 'developer', 'security', 'ops', 'performance'], CTX)
    expect(runner.calls).toBe(3) // 3 failures trip the breaker; the last 2 are short-circuited
    expect(hostCount).toBe(5) // all 5 fall back
    expect(out).toHaveLength(5)
  })

  it('respects the concurrency cap', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const runner = mockRunner(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return okReply(['x'])
    })
    const panel = new PersonaPanel({ runner, config: cfg({ concurrency: 2 }), hostSynthesize: failHost })
    await panel.dispatch(['user', 'developer', 'security', 'ops'], CTX)
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(runner.calls).toBe(4)
  })

  it('soft budget short-circuits to fallback once exceeded', async () => {
    let t = 0
    const runner = mockRunner(async () => okReply(['x']))
    const panel = new PersonaPanel({
      runner,
      config: cfg({ budgetMs: 10, concurrency: 1 }),
      hostSynthesize: async (names) => names.map((p) => ({ persona: p, stance: 'host', objections: [] })),
      now: () => (t += 100), // every clock read jumps 100ms — budget blown immediately
    })
    const out = await panel.dispatch(['user', 'developer'], CTX)
    // budget blown on the first persona check → both fall back, runner never called
    expect(runner.calls).toBe(0)
    expect(out.every((o) => o.stance === 'host')).toBe(true)
  })

  it('never throws even when the host-synthesis fallback itself throws (never-block contract)', async () => {
    const runner = mockRunner(async () => ({ ok: false, text: '', failure: 'error' }))
    const panel = new PersonaPanel({
      runner,
      config: cfg({ maxRetries: 0 }),
      hostSynthesize: async () => { throw new Error('host down') },
    })
    const out = await panel.dispatch(['user', 'developer'], CTX)
    expect(out).toHaveLength(2)
    expect(out.every((o) => o.objections.length === 0)).toBe(true)
  })
})

describe('parseObjectionJson', () => {
  it('parses a clean JSON object', () => {
    const e = parseObjectionJson('user', '{"stance":"meh","objections":["a","b"]}')
    expect(e).toEqual({ persona: 'user', stance: 'meh', objections: ['a', 'b'] })
  })
  it('strips a markdown fence and leading prose', () => {
    const e = parseObjectionJson('user', 'Here you go:\n```json\n{"stance":"s","objections":["x"]}\n```')
    expect(e.objections).toEqual(['x'])
  })
  it('returns empty (never throws) on malformed reply', () => {
    expect(parseObjectionJson('user', 'not json at all').objections).toEqual([])
    expect(parseObjectionJson('user', '{ broken').objections).toEqual([])
  })
  it('filters non-string objections', () => {
    expect(parseObjectionJson('user', '{"objections":["ok",3,null]}').objections).toEqual(['ok'])
  })
})
