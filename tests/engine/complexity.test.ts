import { describe, it, expect } from 'vitest'
import { scoreComplexity, ComplexityInput, ComplexityTier, tierSizing, DEFAULT_SIZING, Sizing, tierFromOverride, isValidComplexityInput } from '../../src/engine/complexity.js'

describe('M3: complexity scorer', () => {
  it('XS: 1 file, low novelty, blast 1, low irreversibility', () => {
    const input: ComplexityInput = { files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' }
    const result = scoreComplexity(input)
    expect(result.tier).toBe<ComplexityTier>('XS')
  })

  it('L: ~6 files, medium novelty, blast 3, medium irreversibility', () => {
    const input: ComplexityInput = { files: 6, novelty: 'med', blastRadius: 3, irreversibility: 'med' }
    const result = scoreComplexity(input)
    expect(result.tier).toBe<ComplexityTier>('L')
  })

  it('XL: many files, high novelty, blast 5, high irreversibility', () => {
    const input: ComplexityInput = { files: 20, novelty: 'high', blastRadius: 5, irreversibility: 'high' }
    const result = scoreComplexity(input)
    expect(result.tier).toBe<ComplexityTier>('XL')
  })

  it('S tier for small but not XS inputs', () => {
    const input: ComplexityInput = { files: 3, novelty: 'low', blastRadius: 2, irreversibility: 'low' }
    const result = scoreComplexity(input)
    expect(result.tier).toBe<ComplexityTier>('S')
  })

  it('M tier for medium feature', () => {
    const input: ComplexityInput = { files: 4, novelty: 'med', blastRadius: 3, irreversibility: 'low' }
    const result = scoreComplexity(input)
    expect(result.tier).toBe<ComplexityTier>('M')
  })

  it('returns numeric score alongside tier', () => {
    const result = scoreComplexity({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' })
    expect(typeof result.score).toBe('number')
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('higher inputs produce equal-or-higher score', () => {
    const low = scoreComplexity({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' })
    const high = scoreComplexity({ files: 20, novelty: 'high', blastRadius: 5, irreversibility: 'high' })
    expect(high.score).toBeGreaterThan(low.score)
  })
})

describe('M3: tierSizing — §6 table', () => {
  it('XS: panelPersonas=0, laneCap=1, reviewRounds=1, thinkingLevel=low', () => {
    const s: Sizing = tierSizing('XS')
    expect(s.panelPersonas).toBe(0)
    expect(s.laneCap).toBe(1)
    expect(s.reviewRounds).toBe(1)
    expect(s.thinkingLevel).toBe('low')
  })

  it('S: panelPersonas=2, laneCap=2, reviewRounds=1, thinkingLevel=medium', () => {
    const s: Sizing = tierSizing('S')
    expect(s.panelPersonas).toBe(2)
    expect(s.laneCap).toBe(2)
    expect(s.reviewRounds).toBe(1)
    expect(s.thinkingLevel).toBe('medium')
  })

  it('M: panelPersonas=4, laneCap=3, reviewRounds=2, thinkingLevel=high', () => {
    const s: Sizing = tierSizing('M')
    expect(s.panelPersonas).toBe(4)
    expect(s.laneCap).toBe(3)
    expect(s.reviewRounds).toBe(2)
    expect(s.thinkingLevel).toBe('high')
  })

  it('L: panelPersonas=6, laneCap=5, reviewRounds=3, thinkingLevel=high', () => {
    const s: Sizing = tierSizing('L')
    expect(s.panelPersonas).toBe(6)
    expect(s.laneCap).toBe(5)
    expect(s.reviewRounds).toBe(3)
    expect(s.thinkingLevel).toBe('high')
  })

  it('XL: panelPersonas=8, laneCap=5, reviewRounds=5, thinkingLevel=xhigh', () => {
    const s: Sizing = tierSizing('XL')
    expect(s.panelPersonas).toBe(8)
    expect(s.laneCap).toBe(5)
    expect(s.reviewRounds).toBe(5)
    expect(s.thinkingLevel).toBe('xhigh')
  })

  it('DEFAULT_SIZING equals tierSizing("M")', () => {
    expect(DEFAULT_SIZING).toEqual(tierSizing('M'))
  })
})

// ── B1: tierFromOverride ───────────────────────────────────────────────────────

describe('B1: tierFromOverride — override prefix → tier mapping', () => {
  it('quick → XS', () => { expect(tierFromOverride('quick')).toBe('XS') })
  it('mid → M', () => { expect(tierFromOverride('mid')).toBe('M') })
  it('full → XL', () => { expect(tierFromOverride('full')).toBe('XL') })
  it('bogus → null', () => { expect(tierFromOverride('bogus')).toBeNull() })
  it('empty string → null', () => { expect(tierFromOverride('')).toBeNull() })
  it('case-insensitive: QUICK → XS', () => { expect(tierFromOverride('QUICK')).toBe('XS') })
  it('case-insensitive: Mid → M', () => { expect(tierFromOverride('Mid')).toBe('M') })
  it('build → null (task-type only, not a tier)', () => { expect(tierFromOverride('build')).toBeNull() })
})

// ── B1: isValidComplexityInput ────────────────────────────────────────────────

describe('B1: isValidComplexityInput — validation', () => {
  it('valid minimal input', () => {
    expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(true)
  })
  it('valid with all enums set to med/high', () => {
    expect(isValidComplexityInput({ files: 10, novelty: 'high', blastRadius: 5, irreversibility: 'med' })).toBe(true)
  })
  it('valid with extra rationale field (ComplexityInput & { rationale })', () => {
    expect(isValidComplexityInput({ files: 2, novelty: 'med', blastRadius: 2, irreversibility: 'low', rationale: 'small util' })).toBe(true)
  })
  it('files < 1 → false', () => {
    expect(isValidComplexityInput({ files: 0, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(false)
  })
  it('files > 50 → false', () => {
    expect(isValidComplexityInput({ files: 51, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(false)
  })
  it('files at boundary 50 → true', () => {
    expect(isValidComplexityInput({ files: 50, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(true)
  })
  it('bad novelty enum → false', () => {
    expect(isValidComplexityInput({ files: 1, novelty: 'huge', blastRadius: 1, irreversibility: 'low' })).toBe(false)
  })
  it('blastRadius > 5 → false', () => {
    expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 9, irreversibility: 'low' })).toBe(false)
  })
  it('blastRadius < 1 → false', () => {
    expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 0, irreversibility: 'low' })).toBe(false)
  })
  it('bad irreversibility enum → false', () => {
    expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'critical' })).toBe(false)
  })
  it('null → false', () => { expect(isValidComplexityInput(null)).toBe(false) })
  it('missing fields → false', () => { expect(isValidComplexityInput({ files: 1 })).toBe(false) })
  it('string → false', () => { expect(isValidComplexityInput('low')).toBe(false) })
})

// ── B1: trivial assessment → XS ───────────────────────────────────────────────

describe('B1: trivial self-assessment scores XS', () => {
  it('files:1 novelty:low blast:1 irrev:low → XS with panelPersonas 0', () => {
    const result = scoreComplexity({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' })
    expect(result.tier).toBe('XS')
    expect(tierSizing(result.tier).panelPersonas).toBe(0)
  })
})
