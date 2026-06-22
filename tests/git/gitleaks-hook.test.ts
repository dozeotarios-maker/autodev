// M5 gitleaks-hook test — D1 test-first
// G12: mock CLI boundary (gitleaks binary)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { GitleaksHook } from '../../src/git/gitleaks-hook.js'
import { spawn } from 'child_process'

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

/** Helper: build a fake ChildProcess that emits stdout data then closes */
function makeFakeProc(opts: {
  stdout?: string
  exitCode?: number
  errorEvent?: Error
}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()

  setImmediate(() => {
    if (opts.errorEvent) {
      proc.emit('error', opts.errorEvent)
      return
    }
    if (opts.stdout) {
      proc.stdout.emit('data', Buffer.from(opts.stdout))
    }
    proc.emit('close', opts.exitCode ?? 0)
  })

  return proc
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('M5: GitleaksHook — blocks staged secrets', () => {
  it('returns clean=true when gitleaks exits 0 (no secrets found)', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProc({ exitCode: 0 }))

    const hook = new GitleaksHook('/fake/repo')
    const result = await hook.scan({ staged: true })

    expect(result.clean).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it('returns clean=false and findings when gitleaks exits 1 (secret found)', async () => {
    const leakOutput = JSON.stringify([
      {
        Description: 'GitHub Personal Access Token',
        StartLine: 5,
        File: 'src/config.ts',
        Secret: 'ghp_REDACTED',
        RuleID: 'github-pat',
      },
    ])
    mockSpawn.mockReturnValueOnce(makeFakeProc({ stdout: leakOutput, exitCode: 1 }))

    const hook = new GitleaksHook('/fake/repo')
    const result = await hook.scan({ staged: true })

    expect(result.clean).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0]).toContain('GitHub Personal Access Token')
  })

  it('passes --staged flag (and NOT --no-git) when scanning staged files', async () => {
    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      expect(args).toContain('--staged')
      expect(args).not.toContain('--no-git')
      return makeFakeProc({ exitCode: 0 })
    })

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: true })
  })

  it('passes --no-git flag (and NOT --staged) for full scan', async () => {
    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      expect(args).not.toContain('--staged')
      expect(args).toContain('--no-git')
      return makeFakeProc({ exitCode: 0 })
    })

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: false })
  })

  it('uses gitleaks binary by default', async () => {
    mockSpawn.mockImplementationOnce((cmd: string) => {
      expect(cmd).toBe('gitleaks')
      return makeFakeProc({ exitCode: 0 })
    })

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: true })
  })

  it('propagates unexpected errors (binary missing / ENOENT)', async () => {
    const spawnError = Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' })
    mockSpawn.mockReturnValueOnce(makeFakeProc({ errorEvent: spawnError }))

    const hook = new GitleaksHook('/fake/repo')
    await expect(hook.scan({ staged: true })).rejects.toThrow(/gitleaks/)
  })

  it('rejects on non-zero non-1 exit code', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProc({ exitCode: 2 }))

    const hook = new GitleaksHook('/fake/repo')
    await expect(hook.scan({ staged: true })).rejects.toThrow(/exit code 2/)
  })
})
