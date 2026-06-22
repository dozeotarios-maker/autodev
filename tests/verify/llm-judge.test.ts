// M6a: LLM judge — clean-context, EvilGenie holdout pattern
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMJudge } from '../../src/verify/llm-judge.js'

describe('M6a: LLMJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isDone returns true when model call returns true', async () => {
    const mockCall = vi.fn().mockResolvedValue(true)
    const judge = new LLMJudge(mockCall)
    const result = await judge.isDone('build login', 'login works, tests pass')
    expect(result).toBe(true)
    expect(mockCall).toHaveBeenCalledOnce()
  })

  it('isDone returns false when model call returns false', async () => {
    const mockCall = vi.fn().mockResolvedValue(false)
    const judge = new LLMJudge(mockCall)
    const result = await judge.isDone('build login', 'nothing merged yet')
    expect(result).toBe(false)
  })

  it('isStillRight returns aligned result from model', async () => {
    const mockCall = vi.fn().mockResolvedValue({ aligned: true, reason: 'on track' })
    const judge = new LLMJudge(undefined, mockCall)
    const result = await judge.isStillRight('spec: feature A', 'diff shows feature A added')
    expect(result.aligned).toBe(true)
    expect(result.reason).toBe('on track')
  })

  it('isStillRight returns not-aligned when drift detected', async () => {
    const mockCall = vi.fn().mockResolvedValue({ aligned: false, reason: 'diverges from spec' })
    const judge = new LLMJudge(undefined, mockCall)
    const result = await judge.isStillRight('spec: feature A', 'diff modifies feature B instead')
    expect(result.aligned).toBe(false)
    expect(result.reason).toContain('diverges')
  })

  it('judge does not include LLM trace in model calls', async () => {
    const mockCall = vi.fn().mockResolvedValue(true)
    const judge = new LLMJudge(mockCall)
    await judge.isDone('goal', 'evidence only — no trace here')
    const [goalArg, evidenceArg] = mockCall.mock.calls[0]
    // Evidence passed to model should not be "trace" content
    expect(goalArg).toBe('goal')
    expect(evidenceArg).toBe('evidence only — no trace here')
  })

  it('satisfies the Judge port interface', async () => {
    const judge = new LLMJudge(
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue({ aligned: true })
    )
    // Port compliance: has isDone and isStillRight
    expect(typeof judge.isDone).toBe('function')
    expect(typeof judge.isStillRight).toBe('function')
  })
})
