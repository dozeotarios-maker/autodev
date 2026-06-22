import { describe, it, expect } from 'vitest'
import { scoreComplexity, ComplexityInput, ComplexityTier } from '../../src/engine/complexity.js'

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
