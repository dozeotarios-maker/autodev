// M6a: R1 clean-context reviewer — sees diff only, no spec/trace in context
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { R1Reviewer } from '../../src/verify/reviewer.js'
import type { Judge } from '../../src/ports.js'

describe('M6a: R1Reviewer (clean-context)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls judge with review instruction + diff — no spec or trace present', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const reviewer = new R1Reviewer(judge)
    await reviewer.review({
      diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new',
      spec: 'SECRET SPEC: implement login by doing X',
      llmTrace: 'TRACE: step 1 -> step 2 -> step 3',
    })

    expect(judge.isStillRight).toHaveBeenCalledOnce()
    const [firstArg, secondArg] = (judge.isStillRight as ReturnType<typeof vi.fn>).mock.calls[0]
    // First arg is the review instruction, not the diff and not the secret spec
    expect(firstArg).toContain('Review this diff')
    expect(firstArg).not.toContain('SECRET SPEC')
    expect(firstArg).not.toContain('TRACE:')
    // Second arg is the actual diff
    expect(secondArg).toContain('-old')
    expect(secondArg).toContain('+new')
    expect(secondArg).not.toContain('SECRET SPEC')
    expect(secondArg).not.toContain('TRACE:')
  })

  it('flags a planted bad diff — judge returns not aligned', async () => {
    const judge: Judge = {
      isDone: vi.fn(),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'SQL injection vulnerability planted' }),
    }
    const reviewer = new R1Reviewer(judge)
    const result = await reviewer.review({
      diff: "+const query = `SELECT * FROM users WHERE id = ${userId}`",
      spec: 'irrelevant',
      llmTrace: 'irrelevant',
    })
    // Judge received the diff (not itself) and correctly flagged it
    const [, secondArg] = (judge.isStillRight as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(secondArg).toContain('SELECT * FROM users')
    expect(result.clean).toBe(false)
    expect(result.reason).toContain('SQL injection')
  })

  it('returns aligned=true when judge says aligned', async () => {
    const judge: Judge = {
      isDone: vi.fn(),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true, reason: 'looks good' }),
    }
    const reviewer = new R1Reviewer(judge)
    const result = await reviewer.review({
      diff: '+const x = 1',
      spec: 'ignored',
      llmTrace: 'ignored',
    })
    expect(result.clean).toBe(true)
  })

  it('returns aligned=false with reason when judge says not aligned', async () => {
    const judge: Judge = {
      isDone: vi.fn(),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'adds unused code' }),
    }
    const reviewer = new R1Reviewer(judge)
    const result = await reviewer.review({
      diff: '+const dead = "unreachable"',
      spec: 'ignored',
      llmTrace: 'ignored',
    })
    expect(result.clean).toBe(false)
    expect(result.reason).toContain('adds unused code')
  })

  it('reviewer context object has no spec or trace fields', async () => {
    const judge: Judge = {
      isDone: vi.fn(),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const reviewer = new R1Reviewer(judge)
    // The reviewer itself should not store spec/trace
    expect((reviewer as unknown as Record<string, unknown>).spec).toBeUndefined()
    expect((reviewer as unknown as Record<string, unknown>).llmTrace).toBeUndefined()
    expect((reviewer as unknown as Record<string, unknown>).trace).toBeUndefined()
  })

  it('handles empty diff gracefully', async () => {
    const judge: Judge = {
      isDone: vi.fn(),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const reviewer = new R1Reviewer(judge)
    const result = await reviewer.review({ diff: '', spec: '', llmTrace: '' })
    expect(result.clean).toBe(true)
  })
})
