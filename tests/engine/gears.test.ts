// B2 Task 1: Gear type + gearFromTier + gearFromForced — unit tests (TDD, failing first)

import { describe, it, expect } from 'vitest'
import { gearFromTier, gearFromForced } from '../../src/engine/complexity.js'
import type { Gear } from '../../src/engine/complexity.js'

describe('B2 Task1: gearFromTier — tier → gear mapping', () => {
  it('XS → quick', () => { expect(gearFromTier('XS')).toBe<Gear>('quick') })
  it('S → middle', () => { expect(gearFromTier('S')).toBe<Gear>('middle') })
  it('M → middle', () => { expect(gearFromTier('M')).toBe<Gear>('middle') })
  it('L → full', () => { expect(gearFromTier('L')).toBe<Gear>('full') })
  it('XL → full', () => { expect(gearFromTier('XL')).toBe<Gear>('full') })
})

describe('B2 Task1: gearFromForced — forcedTier? → Gear | undefined', () => {
  it('XS → quick', () => { expect(gearFromForced('XS')).toBe('quick') })
  it('S → middle', () => { expect(gearFromForced('S')).toBe('middle') })
  it('M → middle', () => { expect(gearFromForced('M')).toBe('middle') })
  it('L → full', () => { expect(gearFromForced('L')).toBe('full') })
  it('XL → full', () => { expect(gearFromForced('XL')).toBe('full') })
  it('undefined → undefined (no prefix, no gear forced)', () => { expect(gearFromForced(undefined)).toBeUndefined() })
})
