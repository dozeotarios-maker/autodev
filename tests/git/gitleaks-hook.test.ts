// M5 gitleaks-hook test — D1 test-first
// G12: mock CLI boundary (gitleaks binary)
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

import { GitleaksHook } from '../../src/git/gitleaks-hook.js'
import { execFile } from 'child_process'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('M5: GitleaksHook — blocks staged secrets', () => {
  it('returns clean=true when gitleaks exits 0 (no secrets found)', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', '')
    )

    const hook = new GitleaksHook('/fake/repo')
    const result = await hook.scan({ staged: true })

    expect(result.clean).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it('returns clean=false and findings when gitleaks exits non-zero (secret found)', async () => {
    const leakOutput = JSON.stringify([
      {
        Description: 'GitHub Personal Access Token',
        StartLine: 5,
        File: 'src/config.ts',
        Secret: 'ghp_REDACTED',
        RuleID: 'github-pat',
      },
    ])
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(Object.assign(new Error('exit 1'), { code: 1 }), leakOutput, '')
    )

    const hook = new GitleaksHook('/fake/repo')
    const result = await hook.scan({ staged: true })

    expect(result.clean).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0]).toContain('GitHub Personal Access Token')
  })

  it('passes --staged flag when scanning staged files', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        expect(args).toContain('--staged')
        cb(null, '', '')
      }
    )

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: true })
  })

  it('does NOT pass --staged flag for full scan', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        expect(args).not.toContain('--staged')
        cb(null, '', '')
      }
    )

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: false })
  })

  it('uses gitleaks binary by default', async () => {
    mockExecFile.mockImplementationOnce(
      (cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        expect(cmd).toBe('gitleaks')
        cb(null, '', '')
      }
    )

    const hook = new GitleaksHook('/fake/repo')
    await hook.scan({ staged: true })
  })

  it('propagates unexpected errors (not exit-code errors)', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(new Error('gitleaks: command not found'), '', '')
    )

    const hook = new GitleaksHook('/fake/repo')
    // When gitleaks binary is missing, it should throw (not silently pass)
    await expect(hook.scan({ staged: true })).rejects.toThrow(/gitleaks/)
  })
})
