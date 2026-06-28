import { describe, it, expect } from 'vitest'
import { selectRelevantPersonas, CORE_PERSONAS } from '../../src/persona/relevance-selector.js'
import { ALL_PERSONA_NAMES } from '../../src/persona/persona-registry.js'
import type { PersonaSessionRunner, PersonaRunResult } from '../../src/persona/types.js'

function runnerReturning(text: string, ok = true): PersonaSessionRunner {
  return { async run() { return { ok, text } as PersonaRunResult } }
}
const failingRunner: PersonaSessionRunner = { async run() { throw new Error('down') } }

describe('selectRelevantPersonas', () => {
  it('always includes the core, then LLM-picked extras', async () => {
    const runner = runnerReturning('["security","performance"]')
    const out = await selectRelevantPersonas({ runner }, 'a web login form', ALL_PERSONA_NAMES, 4)
    expect(out.slice(0, 2)).toEqual(CORE_PERSONAS)
    expect(out).toContain('security')
    expect(out).toContain('performance')
    expect(out).toHaveLength(4)
  })

  it('respects max (core only when no optional slots)', async () => {
    const runner = runnerReturning('["security"]')
    const out = await selectRelevantPersonas({ runner }, 'x', ALL_PERSONA_NAMES, 2)
    expect(out).toEqual(CORE_PERSONAS) // 2 slots both consumed by core
  })

  it('max=0 returns empty', async () => {
    expect(await selectRelevantPersonas({ runner: runnerReturning('[]') }, 'x', ALL_PERSONA_NAMES, 0)).toEqual([])
  })

  it('degrades to deterministic registry order when the LLM fails', async () => {
    const out = await selectRelevantPersonas({ runner: failingRunner }, 'x', ALL_PERSONA_NAMES, 4)
    expect(out.slice(0, 2)).toEqual(CORE_PERSONAS)
    // optional order = registry minus core: security, ops, product-manager, ...
    expect(out.slice(2)).toEqual(['security', 'ops'])
  })

  it('degrades when the LLM returns garbage', async () => {
    const out = await selectRelevantPersonas({ runner: runnerReturning('not an array') }, 'x', ALL_PERSONA_NAMES, 3)
    expect(out).toHaveLength(3)
    expect(out.slice(0, 2)).toEqual(CORE_PERSONAS)
  })

  it('never returns a non-candidate (filters hallucinated names)', async () => {
    const runner = runnerReturning('["wizard","security"]')
    const out = await selectRelevantPersonas({ runner }, 'x', ALL_PERSONA_NAMES, 4)
    expect(out).not.toContain('wizard')
    expect(out).toContain('security')
  })

  it('prefers ask() over run() when present', async () => {
    let usedAsk = false
    const runner: PersonaSessionRunner = {
      async run() { return { ok: true, text: '["ops"]' } },
      async ask() { usedAsk = true; return { ok: true, text: '["security"]' } },
    }
    const out = await selectRelevantPersonas({ runner }, 'x', ALL_PERSONA_NAMES, 3)
    expect(usedAsk).toBe(true)
    expect(out).toContain('security')
    expect(out).not.toContain('ops')
  })
})
