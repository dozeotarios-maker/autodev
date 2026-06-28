import { describe, it, expect } from 'vitest'
import { loadPersonaConfig, DEFAULT_PERSONA_CONFIG } from '../../src/persona/persona-config.js'

describe('loadPersonaConfig', () => {
  it('returns defaults for an empty env (no Gemini key => disabled)', () => {
    const c = loadPersonaConfig({})
    expect(c.model).toBe(DEFAULT_PERSONA_CONFIG.model)
    expect(c.concurrency).toBe(1)
    expect(c.enabled).toBe(false) // no GEMINI_API_KEY
  })

  it('enables by default when a Gemini key is present', () => {
    expect(loadPersonaConfig({ GEMINI_API_KEY: 'x' }).enabled).toBe(true)
  })

  it('AUTODEV_PERSONA_SUBAGENTS=1 forces enabled even without a key', () => {
    expect(loadPersonaConfig({ AUTODEV_PERSONA_SUBAGENTS: '1' }).enabled).toBe(true)
  })

  it('AUTODEV_PERSONA_SUBAGENTS=false disables even with a key', () => {
    expect(loadPersonaConfig({ GEMINI_API_KEY: 'x', AUTODEV_PERSONA_SUBAGENTS: 'false' }).enabled).toBe(false)
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
