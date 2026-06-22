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
    const loop = new ReviewLoop(judge, mockReviewer)
    await loop.run('diff')
    expect(mockReviewer).toHaveBeenCalledTimes(5)
  })
})
