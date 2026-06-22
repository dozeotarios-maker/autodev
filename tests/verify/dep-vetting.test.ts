// M6b: G21 dep-vetting — license + CVE + maintenance; osv/trivy CLI boundary mocked
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DepVetter } from '../../src/verify/dep-vetting.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'

function makeCliMock(exitCode: number, stdout: string) {
  return vi.fn().mockImplementation(() => {
    const proc = {
      stdout: {
        on(event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
        },
      },
      stderr: {
        on(_: string, __: unknown) {},
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'close') setTimeout(() => cb(exitCode), 10)
      },
    }
    return proc
  })
}

describe('M6b: DepVetter (G21)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks dep with known CVE (osv-scanner finds vulnerability)', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(1, JSON.stringify({
        results: [{ packages: [{ vulnerabilities: [{ id: 'CVE-2024-1234', severity: 'HIGH' }] }] }]
      }))
    )
    const vetter = new DepVetter()
    const result = await vetter.vet({ name: 'evil-package', version: '1.0.0', cwd: '/tmp/repo' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/CVE|vulnerabilit/i)
  })

  it('blocks dep with incompatible license (GPL in proprietary project)', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(0, JSON.stringify({ results: [] }))
    )
    const vetter = new DepVetter({ allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'] })
    const result = await vetter.vet({
      name: 'gpl-lib',
      version: '2.0.0',
      license: 'GPL-3.0',
      cwd: '/tmp/repo',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/license|GPL/i)
  })

  it('allows dep with MIT license and no CVEs', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(0, JSON.stringify({ results: [] }))
    )
    const vetter = new DepVetter()
    const result = await vetter.vet({
      name: 'safe-package',
      version: '3.1.0',
      license: 'MIT',
      cwd: '/tmp/repo',
    })
    expect(result.allowed).toBe(true)
  })

  it('flags unmaintained dep (no commits in 2 years)', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(0, JSON.stringify({ results: [] }))
    )
    const vetter = new DepVetter()
    const result = await vetter.vet({
      name: 'abandoned-lib',
      version: '0.1.0',
      license: 'MIT',
      lastPublished: new Date('2021-01-01').toISOString(),
      cwd: '/tmp/repo',
    })
    expect(result.maintenanceWarning).toBe(true)
  })

  it('shells out to osv-scanner or trivy — spawn called', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(0, JSON.stringify({ results: [] }))
    )
    const vetter = new DepVetter()
    await vetter.vet({ name: 'any-pkg', version: '1.0.0', cwd: '/tmp' })
    expect(spawn).toHaveBeenCalled()
  })

  it('blocks dep with CRITICAL CVE severity', async () => {
    ;(spawn as ReturnType<typeof vi.fn>).mockImplementation(
      makeCliMock(1, JSON.stringify({
        results: [{ packages: [{ vulnerabilities: [{ id: 'CVE-2024-9999', severity: 'CRITICAL' }] }] }]
      }))
    )
    const vetter = new DepVetter()
    const result = await vetter.vet({ name: 'bad-pkg', version: '1.0.0', cwd: '/tmp' })
    expect(result.allowed).toBe(false)
  })
})
