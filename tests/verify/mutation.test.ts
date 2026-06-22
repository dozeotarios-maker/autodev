// S2-M7: MutationGate — injected ExecFn boundary; missing-binary degrades gracefully
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MutationGate } from '../../src/verify/mutation.js'
import type { ExecFn, PiExecResult } from '../../src/verify/mutation.js'

function makeExec(exitCode: number, score: number | null, stderr = ''): ExecFn {
  const stdout = score !== null ? JSON.stringify({ mutationScore: score }) : 'not json'
  return vi.fn().mockResolvedValue({ stdout, stderr, exitCode } as PiExecResult)
}

function makeExecError(message: string): ExecFn {
  return vi.fn().mockRejectedValue(new Error(message))
}

function makeExecSpawnFail(message: string): ExecFn {
  return vi.fn().mockResolvedValue({ stdout: '', stderr: message, exitCode: -1 } as PiExecResult)
}

describe('S2-M7: MutationGate (injected exec)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes when mutation score >= default threshold (80)', async () => {
    const gate = new MutationGate({ exec: makeExec(0, 85) })
    const result = await gate.run('/tmp/repo')
    expect(result.score).toBe(85)
    expect(result.passed).toBe(true)
  })

  it('fails when mutation score < 80', async () => {
    const gate = new MutationGate({ exec: makeExec(0, 72) })
    const result = await gate.run('/tmp/repo')
    expect(result.score).toBe(72)
    expect(result.passed).toBe(false)
  })

  it('threshold is configurable', async () => {
    const gate = new MutationGate({ threshold: 70, exec: makeExec(0, 75) })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(true)
  })

  it('fails when threshold is 80 and score is exactly 79', async () => {
    const gate = new MutationGate({ threshold: 80, exec: makeExec(0, 79) })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(false)
  })

  it('passes when score exactly equals threshold', async () => {
    const gate = new MutationGate({ threshold: 80, exec: makeExec(0, 80) })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(true)
  })

  it('fails when stryker exits non-zero', async () => {
    const gate = new MutationGate({ exec: makeExec(1, 0) })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('calls exec with stryker command', async () => {
    const exec = makeExec(0, 90)
    const gate = new MutationGate({ exec })
    await gate.run('/tmp/repo')
    expect(exec).toHaveBeenCalledOnce()
    const [cmd] = (exec as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cmd).toMatch(/stryker/i)
  })

  it('degrades gracefully when binary missing (ENOENT reject)', async () => {
    const exec = makeExecError('spawn stryker ENOENT')
    const gate = new MutationGate({ exec })
    const result = await gate.run('/tmp/repo')
    expect(result.skipped).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.error).toMatch(/not found|ENOENT/i)
  })

  it('degrades gracefully when binary missing (exitCode -1 + ENOENT in stderr)', async () => {
    const exec = makeExecSpawnFail('spawn stryker ENOENT')
    const gate = new MutationGate({ exec })
    const result = await gate.run('/tmp/repo')
    expect(result.skipped).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('validates output parsing vs recorded sample shape', async () => {
    // Recorded sample: stryker JSON output with mutationScore field
    const recordedSample = JSON.stringify({ mutationScore: 87.5, killed: 70, survived: 10 })
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: recordedSample, stderr: '', exitCode: 0 })
    const gate = new MutationGate({ exec })
    const result = await gate.run('/tmp/repo')
    expect(result.score).toBe(87.5)
    expect(result.passed).toBe(true)
  })
})
