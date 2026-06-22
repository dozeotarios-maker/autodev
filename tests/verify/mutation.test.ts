// M6a: mutation gate — shells out to StrykerJS; boundary mocked (G12)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MutationGate } from '../../src/verify/mutation.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'

function makeStrykerMock(exitCode: number, score: number) {
  const stdout = JSON.stringify({ mutationScore: score })
  return vi.fn().mockImplementation(() => {
    const proc = {
      stdout: {
        on(event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
        },
      },
      stderr: {
        on(_event: string, _cb: unknown) {},
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'close') setTimeout(() => cb(exitCode), 10)
      },
    }
    return proc
  })
}

describe('M6a: MutationGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes when mutation score >= default threshold (80)', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 85))
    const gate = new MutationGate()
    const result = await gate.run('/tmp/repo')
    expect(result.score).toBe(85)
    expect(result.passed).toBe(true)
  })

  it('fails when mutation score < 80', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 72))
    const gate = new MutationGate()
    const result = await gate.run('/tmp/repo')
    expect(result.score).toBe(72)
    expect(result.passed).toBe(false)
  })

  it('threshold is configurable', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 75))
    const gate = new MutationGate({ threshold: 70 })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(true)
  })

  it('fails when threshold is 80 and score is exactly 79', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 79))
    const gate = new MutationGate({ threshold: 80 })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(false)
  })

  it('passes when score exactly equals threshold', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 80))
    const gate = new MutationGate({ threshold: 80 })
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(true)
  })

  it('fails when stryker exits non-zero', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(1, 0))
    const gate = new MutationGate()
    const result = await gate.run('/tmp/repo')
    expect(result.passed).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('shells out to stryker — spawn is called with stryker binary', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(makeStrykerMock(0, 90))
    const gate = new MutationGate()
    await gate.run('/tmp/repo')
    expect(spawn).toHaveBeenCalled()
    const [cmd] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cmd).toMatch(/stryker/i)
  })
})
