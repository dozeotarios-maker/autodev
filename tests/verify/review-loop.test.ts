// M6b: review-to-zero loop — drives CRIT/HIGH to zero, caps at 5 rounds, files LOW/MED
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReviewLoop, type ReviewFinding } from '../../src/verify/review-loop.js'
import type { Judge } from '../../src/ports.js'

function makeFinding(severity: 'CRIT' | 'HIGH' | 'MED' | 'LOW', desc = 'issue'): ReviewFinding {
  return { severity, description: desc, file: 'src/foo.ts', line: 1 }
}

describe('M6b: ReviewLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when no CRIT/HIGH findings from the start', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('LOW')])
    const loop = new ReviewLoop(judge, mockReviewer)
    const result = await loop.run('diff text')
    expect(result.success).toBe(true)
    expect(result.rounds).toBe(1)
    expect(result.filed.length).toBeGreaterThan(0)
  })

  it('iterates until CRIT/HIGH gone (resolves in round 2)', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const mockReviewer = vi.fn()
      .mockResolvedValueOnce([makeFinding('CRIT', 'sql injection'), makeFinding('LOW')])
      .mockResolvedValueOnce([makeFinding('LOW')])
    const loop = new ReviewLoop(judge, mockReviewer)
    const result = await loop.run('diff text')
    expect(result.success).toBe(true)
    expect(result.rounds).toBe(2)
  })

  it('caps at 5 rounds and fails if CRIT/HIGH persist', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('HIGH', 'persistent bug')])
    const loop = new ReviewLoop(judge, mockReviewer)
    const result = await loop.run('diff text')
    expect(result.success).toBe(false)
    expect(result.rounds).toBe(5)
    expect(result.remainingCritHigh.length).toBeGreaterThan(0)
  })

  it('files LOW and MED findings instead of blocking', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([
      makeFinding('MED', 'naming convention'),
      makeFinding('LOW', 'whitespace'),
    ])
    const loop = new ReviewLoop(judge, mockReviewer)
    const result = await loop.run('diff text')
    expect(result.success).toBe(true)
    expect(result.filed).toHaveLength(2)
    expect(result.filed.every(f => f.severity === 'MED' || f.severity === 'LOW')).toBe(true)
  })

  it('does not exceed 5 review rounds', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('CRIT')])
    // fixer always returns the same diff so reviewer keeps returning CRIT — hits cap
    const fixerFn = vi.fn().mockResolvedValue('diff')
    const loop = new ReviewLoop(judge, mockReviewer, fixerFn)
    await loop.run('diff')
    expect(mockReviewer).toHaveBeenCalledTimes(5)
  })

  it('without fixerFn: runs up to cap when CRIT/HIGH persist', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('CRIT', 'security issue')])
    const loop = new ReviewLoop(judge, mockReviewer) // no fixerFn
    const result = await loop.run('diff')
    // Without a fixer the diff never changes; a deterministic reviewer hits the cap
    expect(result.rounds).toBe(5)
    expect(result.success).toBe(false)
    expect(mockReviewer).toHaveBeenCalledTimes(5)
  })

  it('with fixerFn: converges to zero CRIT/HIGH findings', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    // Round 1 returns CRIT; fixer clears it; round 2 returns empty → success
    const mockReviewer = vi.fn()
      .mockResolvedValueOnce([makeFinding('CRIT', 'injection')])
      .mockResolvedValueOnce([])
    const fixerFn = vi.fn().mockResolvedValue('fixed diff')
    const loop = new ReviewLoop(judge, mockReviewer, fixerFn)
    const result = await loop.run('original diff')
    expect(result.success).toBe(true)
    expect(result.rounds).toBe(2)
    expect(result.remainingCritHigh).toHaveLength(0)
    // fixer was called with the CRIT finding and the original diff
    expect(fixerFn).toHaveBeenCalledWith([makeFinding('CRIT', 'injection')], 'original diff')
    // second reviewer call gets the fixed diff
    expect(mockReviewer).toHaveBeenNthCalledWith(2, 'fixed diff')
  })
})

describe('S2.5: ReviewLoop maxRounds param (sizing.reviewRounds)', () => {
  it('maxRounds=1 (XS) → caps at 1 round', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('CRIT', 'persistent')])
    const loop = new ReviewLoop(judge, mockReviewer, undefined, 1)
    const result = await loop.run('diff')
    expect(result.rounds).toBe(1)
    expect(result.success).toBe(false)
    expect(mockReviewer).toHaveBeenCalledTimes(1)
  })

  it('maxRounds=5 (XL) → caps at 5 rounds', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('CRIT', 'persistent')])
    const loop = new ReviewLoop(judge, mockReviewer, undefined, 5)
    const result = await loop.run('diff')
    expect(result.rounds).toBe(5)
    expect(result.success).toBe(false)
    expect(mockReviewer).toHaveBeenCalledTimes(5)
  })

  it('default (no maxRounds arg) → behaves as 5 rounds', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false }),
    }
    const mockReviewer = vi.fn().mockResolvedValue([makeFinding('HIGH', 'persistent')])
    const loop = new ReviewLoop(judge, mockReviewer)
    const result = await loop.run('diff')
    expect(result.rounds).toBe(5)
  })
})
