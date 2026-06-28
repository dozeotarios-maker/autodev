import { describe, it, expect } from 'vitest'
import { loadPersonaConfig, DEFAULT_PERSONA_CONFIG } from '../../src/persona/persona-config.js'

describe('loadPersonaConfig', () => {
  it('defaults to the selected/session model, enabled, no key needed', () => {
    const c = loadPersonaConfig({})
    expect(c.model).toBe('') // '' = selected/session model
    expect(c.provider).toBe('')
    expect(c.concurrency).toBe(1)
    expect(c.enabled).toBe(true) // default ON — selected model is always available
  })

  it('AUTODEV_PERSONA_SUBAGENTS=0 disables (forces host-synthesis)', () => {
    expect(loadPersonaConfig({ AUTODEV_PERSONA_SUBAGENTS: '0' }).enabled).toBe(false)
    expect(loadPersonaConfig({ AUTODEV_PERSONA_SUBAGENTS: 'false' }).enabled).toBe(false)
  })

  it('infers the provider from an explicit model id', () => {
    expect(loadPersonaConfig({ AUTODEV_PERSONA_MODEL: 'gemini-2.5-flash' }).provider).toBe('google')
    expect(loadPersonaConfig({ AUTODEV_PERSONA_MODEL: 'gpt-5.4' }).provider).toBe('openai')
    expect(loadPersonaConfig({ AUTODEV_PERSONA_MODEL: 'claude-opus-4-8' }).provider).toBe('anthropic')
  })

  it('an explicit AUTODEV_PERSONA_PROVIDER overrides inference', () => {
    expect(loadPersonaConfig({ AUTODEV_PERSONA_MODEL: 'custom', AUTODEV_PERSONA_PROVIDER: 'openai' }).provider).toBe('openai')
  })

  it('parses overrides', () => {
    const c = loadPersonaConfig({
      AUTODEV_PERSONA_MODEL: 'gemini-2.0-flash',
      AUTODEV_PERSONA_CONCURRENCY: '3',
      AUTODEV_PERSONA_WEB_RESEARCH: 'off',
      AUTODEV_PERSONA_FALLBACK: 'no',
      AUTODEV_PERSONA_MAX_RETRIES: '5',
      AUTODEV_PERSONA_TIMEOUT_MS: '5000',
      AUTODEV_PERSONA_BUDGET_MS: '60000',
    })
    expect(c.model).toBe('gemini-2.0-flash')
    expect(c.concurrency).toBe(3)
    expect(c.webResearch).toBe(false)
    expect(c.fallbackToHost).toBe(false)
    expect(c.maxRetries).toBe(5)
    expect(c.timeoutMs).toBe(5000)
    expect(c.budgetMs).toBe(60000)
  })

  it('clamps invalid numerics to safe floors', () => {
    const c = loadPersonaConfig({ AUTODEV_PERSONA_CONCURRENCY: 'abc', AUTODEV_PERSONA_TIMEOUT_MS: '-1' })
    expect(c.concurrency).toBe(1) // 'abc' => NaN => default 1, clamped >= 1
    expect(c.timeoutMs).toBe(1000) // '-1' is finite => clamped to the 1000ms floor
  })

  it('accepts truthy synonyms 1/true/yes/on (case-insensitive)', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
      expect(loadPersonaConfig({ AUTODEV_PERSONA_WEB_RESEARCH: v }).webResearch).toBe(true)
    }
  })
})
