// S2-M7: DepVetter — injected ExecFn boundary; missing-binary degrades gracefully
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DepVetter } from '../../src/verify/dep-vetting.js'
import type { ExecFn, PiExecResult } from '../../src/verify/dep-vetting.js'

function makeExec(exitCode: number, stdout: string): ExecFn {
  return vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode } as PiExecResult)
}

function makeExecError(message: string): ExecFn {
  return vi.fn().mockRejectedValue(new Error(message))
}

function makeExecSpawnFail(stderr: string): ExecFn {
  return vi.fn().mockResolvedValue({ stdout: '', stderr, exitCode: -1 } as PiExecResult)
}

const emptyOsv = JSON.stringify({ results: [] })
const cveSample = JSON.stringify({
  results: [{ packages: [{ vulnerabilities: [{ id: 'CVE-2024-1234', severity: 'HIGH' }] }] }]
})
const criticalCve = JSON.stringify({
  results: [{ packages: [{ vulnerabilities: [{ id: 'CVE-2024-9999', severity: 'CRITICAL' }] }] }]
})

describe('S2-M7: DepVetter (injected exec, G21)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks dep with known CVE (osv-scanner finds vulnerability)', async () => {
    const vetter = new DepVetter({ exec: makeExec(1, cveSample) })
    const result = await vetter.vet({ name: 'evil-package', version: '1.0.0', cwd: '/tmp/repo' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/CVE|vulnerabilit/i)
  })

  it('blocks dep with incompatible license (GPL in proprietary project)', async () => {
    const vetter = new DepVetter({
      allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'],
      exec: makeExec(0, emptyOsv),
    })
    const result = await vetter.vet({
      name: 'gpl-lib', version: '2.0.0', license: 'GPL-3.0', cwd: '/tmp/repo',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/license|GPL/i)
  })

  it('allows dep with MIT license and no CVEs', async () => {
    const vetter = new DepVetter({ exec: makeExec(0, emptyOsv) })
    const result = await vetter.vet({
      name: 'safe-package', version: '3.1.0', license: 'MIT', cwd: '/tmp/repo',
    })
    expect(result.allowed).toBe(true)
  })

  it('flags unmaintained dep (no commits in 2 years)', async () => {
    const vetter = new DepVetter({ exec: makeExec(0, emptyOsv) })
    const result = await vetter.vet({
      name: 'abandoned-lib', version: '0.1.0', license: 'MIT',
      lastPublished: new Date('2021-01-01').toISOString(),
      cwd: '/tmp/repo',
    })
    expect(result.maintenanceWarning).toBe(true)
  })

  it('calls exec (osv-scanner) as CLI boundary', async () => {
    const exec = makeExec(0, emptyOsv)
    const vetter = new DepVetter({ exec })
    await vetter.vet({ name: 'any-pkg', version: '1.0.0', cwd: '/tmp' })
    expect(exec).toHaveBeenCalled()
    const [cmd] = (exec as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cmd).toMatch(/osv-scanner/i)
  })

  it('blocks dep with CRITICAL CVE severity', async () => {
    const vetter = new DepVetter({ exec: makeExec(1, criticalCve) })
    const result = await vetter.vet({ name: 'bad-pkg', version: '1.0.0', cwd: '/tmp' })
    expect(result.allowed).toBe(false)
  })

  it('degrades gracefully when osv-scanner binary missing (ENOENT reject)', async () => {
    const vetter = new DepVetter({ exec: makeExecError('spawn osv-scanner ENOENT') })
    const result = await vetter.vet({ name: 'pkg', version: '1.0.0', cwd: '/tmp/repo' })
    // Graceful degradation: skip CVE scan, allow the dep
    expect(result.allowed).toBe(true)
  })

  it('degrades gracefully when osv-scanner binary missing (exitCode -1 + ENOENT stderr)', async () => {
    const vetter = new DepVetter({ exec: makeExecSpawnFail('spawn osv-scanner ENOENT') })
    const result = await vetter.vet({ name: 'pkg', version: '1.0.0', cwd: '/tmp/repo' })
    expect(result.allowed).toBe(true)
  })

  it('validates output parsing vs recorded osv-scanner sample shape', async () => {
    // Recorded sample: osv-scanner JSON output shape
    const recorded = JSON.stringify({
      results: [
        {
          source: { path: '/tmp/repo/package-lock.json', type: 'lockfile' },
          packages: [
            {
              package: { name: 'lodash', version: '4.17.11', ecosystem: 'npm' },
              vulnerabilities: [{ id: 'GHSA-35jh-r3h4-6jhm', severity: 'HIGH' }],
            }
          ]
        }
      ]
    })
    const vetter = new DepVetter({ exec: makeExec(1, recorded) })
    const result = await vetter.vet({ name: 'lodash', version: '4.17.11', cwd: '/tmp/repo' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/GHSA|CVE|vulnerabilit/i)
  })
})
