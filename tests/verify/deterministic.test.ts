// M6a: deterministic verify — exit-code based, never uses LLM trace
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeterministicVerifier } from '../../src/verify/deterministic.js'

// Mock child_process to avoid real shell execution
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'

function makeSpawnMock(exitCode: number, stdout: string, stderr = '') {
  return vi.fn().mockImplementation(() => {
    const ee: Record<string, ((...args: unknown[]) => void)[]> = {}
    const proc = {
      stdout: {
        on(event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
        },
      },
      stderr: {
        on(event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data' && stderr) setTimeout(() => cb(Buffer.from(stderr)), 0)
        },
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!ee[event]) ee[event] = []
        ee[event].push(cb)
        if (event === 'close') setTimeout(() => cb(exitCode), 10)
      },
    }
    return proc
  })
}

describe('M6a: DeterministicVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes when test command exits 0', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeSpawnMock(0, 'Tests passed\n1 test passed')
    )
    const v = new DeterministicVerifier()
    const result = await v.run('npm test', '/tmp/repo')
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('fails when test command exits non-zero', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeSpawnMock(1, '', '1 test failed')
    )
    const v = new DeterministicVerifier()
    const result = await v.run('npm test', '/tmp/repo')
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('includes stdout+stderr in output', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeSpawnMock(0, 'PASS suite', 'some warning')
    )
    const v = new DeterministicVerifier()
    const result = await v.run('npm test', '/tmp/repo')
    expect(result.output).toContain('PASS suite')
  })

  it('never calls an LLM — no judge property', async () => {
    const v = new DeterministicVerifier()
    // The verifier must not have any LLM/judge dependency
    expect((v as unknown as Record<string, unknown>).judge).toBeUndefined()
    expect((v as unknown as Record<string, unknown>).llm).toBeUndefined()
  })

  it('captures exit code 2 as failed', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeSpawnMock(2, '', 'Error: config invalid')
    )
    const v = new DeterministicVerifier()
    const result = await v.run('vitest run', '/tmp/repo')
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(2)
  })
})
