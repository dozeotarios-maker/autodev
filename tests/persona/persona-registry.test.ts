import { describe, it, expect } from 'vitest'
import { PERSONA_REGISTRY, ALL_PERSONA_NAMES, getPersona } from '../../src/persona/persona-registry.js'

describe('PERSONA_REGISTRY', () => {
  it('drops the legal persona', () => {
    expect(ALL_PERSONA_NAMES).not.toContain('legal')
    expect(getPersona('legal')).toBeUndefined()
  })

  it('adds the autonomous-engineer persona', () => {
    expect(ALL_PERSONA_NAMES).toContain('autonomous-engineer')
    expect(getPersona('autonomous-engineer')?.systemPrompt).toMatch(/idempoten|agentic|automation/i)
  })

  it('keeps the always-relevant core', () => {
    expect(ALL_PERSONA_NAMES).toContain('user')
    expect(ALL_PERSONA_NAMES).toContain('developer')
  })

  it('every spec has a substantive system prompt and a relevance hint', () => {
    for (const name of ALL_PERSONA_NAMES) {
      const spec = PERSONA_REGISTRY[name]
      expect(spec.name).toBe(name)
      expect(spec.systemPrompt.length).toBeGreaterThanOrEqual(80)
      expect(spec.relevanceHint.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate names', () => {
    expect(new Set(ALL_PERSONA_NAMES).size).toBe(ALL_PERSONA_NAMES.length)
  })

  it('exposes the expected 10-persona P2/P3 namespace', () => {
    expect(ALL_PERSONA_NAMES).toEqual([
      'user', 'developer', 'security', 'ops', 'product-manager',
      'architect', 'qa', 'accessibility', 'performance', 'autonomous-engineer',
    ])
  })
})
