// M6a: holdout + clean-context LLM judge + test-tree edit-detection
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoldoutVerifier } from '../../src/verify/holdout.js'
import type { Judge } from '../../src/ports.js'

describe('M6a: HoldoutVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes when judge says done and no test-tree edits', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const v = new HoldoutVerifier(judge)
    const result = await v.run({
      goal: 'add login feature',
      evidence: 'tests pass, coverage 90%',
      testFiles: ['tests/login.test.ts'],
      testFilesSnapshot: { 'tests/login.test.ts': 'content-hash-abc' },
    })
    expect(result.passed).toBe(true)
    expect(judge.isDone).toHaveBeenCalledOnce()
  })

  it('fails when judge says not done', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const v = new HoldoutVerifier(judge)
    const result = await v.run({
      goal: 'add login feature',
      evidence: 'partial implementation',
      testFiles: [],
      testFilesSnapshot: {},
    })
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/judge/i)
  })

  it('catches reward-hack: test-tree edit changes hash', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const v = new HoldoutVerifier(judge)
    const result = await v.run({
      goal: 'pass tests',
      evidence: 'all green',
      testFiles: ['tests/a.test.ts'],
      // Snapshot differs from current content → edit detected
      testFilesSnapshot: { 'tests/a.test.ts': 'original-hash' },
      currentTestHashes: { 'tests/a.test.ts': 'tampered-hash' },
    })
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/test.*edit|edit.*test|tamper|reward.hack/i)
  })

  it('judge receives only goal+evidence — not spec or LLM trace', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const v = new HoldoutVerifier(judge)
    await v.run({
      goal: 'feature X',
      evidence: 'output Y',
      testFiles: [],
      testFilesSnapshot: {},
      // These must NOT appear in judge call
      llmTrace: 'INTERNAL TRACE: step 1 step 2',
      spec: 'SPEC: do X by doing Y',
    })
    const call = (judge.isDone as ReturnType<typeof vi.fn>).mock.calls[0]
    // goal is first arg, evidence is second
    expect(call[0]).toBe('feature X')
    expect(call[1]).not.toContain('INTERNAL TRACE')
    expect(call[1]).not.toContain('SPEC:')
  })

  it('passes when test-tree hashes match snapshot', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const v = new HoldoutVerifier(judge)
    const result = await v.run({
      goal: 'feature',
      evidence: 'done',
      testFiles: ['tests/b.test.ts'],
      testFilesSnapshot: { 'tests/b.test.ts': 'hash-xyz' },
      currentTestHashes: { 'tests/b.test.ts': 'hash-xyz' },
    })
    expect(result.passed).toBe(true)
  })
})
