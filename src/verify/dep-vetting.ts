// S2-M7: G21 dep-vetting — license + CVE + maintenance check.
// CLI boundary (osv-scanner / trivy) injected via ExecFn for testability and graceful degradation.

import path from 'path'
import { spawn } from 'child_process'

export interface PiExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<PiExecResult>

export interface DepVetOptions {
  allowedLicenses?: string[]
  exec?: ExecFn
}

export interface DepVetInput {
  name: string
  version: string
  license?: string
  lastPublished?: string
  cwd: string
}

export interface DepVetResult {
  allowed: boolean
  reason?: string
  maintenanceWarning?: boolean
}

const DEFAULT_ALLOWED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
]

// 2 years in milliseconds
const STALE_THRESHOLD_MS = 2 * 365 * 24 * 60 * 60 * 1000

/** Default exec using child_process.spawn wrapped as a promise */
function defaultExec(
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<PiExecResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command, args, { cwd: options?.cwd, shell: false })
    } catch (err) {
      resolve({ stdout: '', stderr: String(err), exitCode: -1 })
      return
    }

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (_chunk: Buffer) => {})

    proc.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ stdout, stderr: err.message, exitCode: -1 })
    })

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

function isMissingBinary(msg: string): boolean {
  return /ENOENT|not found|No such file/i.test(msg)
}

export class DepVetter {
  private readonly allowedLicenses: string[]
  private readonly exec: ExecFn

  constructor(options: DepVetOptions = {}) {
    this.allowedLicenses = options.allowedLicenses ?? DEFAULT_ALLOWED_LICENSES
    this.exec = options.exec ?? defaultExec
  }

  async vet(input: DepVetInput): Promise<DepVetResult> {
    // License check (static — no CLI needed)
    if (input.license && !this.allowedLicenses.includes(input.license)) {
      return {
        allowed: false,
        reason: `License "${input.license}" not in allowlist: ${this.allowedLicenses.join(', ')}`,
      }
    }

    // CVE scan via osv-scanner
    const cveResult = await this.runOsvScan(input)
    if (!cveResult.clean) {
      return { allowed: false, reason: cveResult.reason }
    }

    // Maintenance check
    let maintenanceWarning = false
    if (input.lastPublished) {
      const age = Date.now() - new Date(input.lastPublished).getTime()
      if (age > STALE_THRESHOLD_MS) {
        maintenanceWarning = true
      }
    }

    return { allowed: true, maintenanceWarning }
  }

  private async runOsvScan(input: DepVetInput): Promise<{ clean: boolean; reason?: string }> {
    // Path-traversal guard
    const resolvedCwd = path.resolve(input.cwd)
    const lockfilePath = path.resolve(resolvedCwd, 'package-lock.json')
    if (!lockfilePath.startsWith(resolvedCwd + path.sep) && lockfilePath !== resolvedCwd) {
      throw new Error(`dep-vetting: lockfile path escapes project root: ${lockfilePath}`)
    }

    const args = ['scan', '--format', 'json', '--lockfile', lockfilePath]

    let result: PiExecResult
    try {
      result = await this.exec('osv-scanner', args, { cwd: input.cwd })
    } catch (err) {
      const msg = String(err)
      if (isMissingBinary(msg)) {
        console.log('[DepVetter] osv-scanner binary not found — skipping CVE scan')
        return { clean: true } // degrade gracefully
      }
      return { clean: false, reason: `osv-scanner failed: ${msg}` }
    }

    // exitCode -1 = spawn error from within defaultExec
    if (result.exitCode === -1) {
      if (isMissingBinary(result.stderr)) {
        console.log('[DepVetter] osv-scanner binary not found — skipping CVE scan')
        return { clean: true } // degrade gracefully
      }
      return { clean: false, reason: `osv-scanner spawn failed: ${result.stderr}` }
    }

    if (result.exitCode !== 0) {
      // exitCode 1 from osv-scanner means vulnerabilities found
      try {
        const data = JSON.parse(result.stdout) as {
          results?: Array<{ packages?: Array<{ vulnerabilities?: Array<{ id: string; severity: string }> }> }>
        }
        const vulns =
          data.results?.flatMap((r) =>
            r.packages?.flatMap((p) => p.vulnerabilities ?? []) ?? []
          ) ?? []
        if (vulns.length > 0) {
          const ids = vulns.map((v) => v.id).join(', ')
          return { clean: false, reason: `CVE found: ${ids}` }
        }
      } catch {
        // parse error — treat as vulnerability found
      }
      return {
        clean: false,
        reason: `osv-scanner exited with code ${result.exitCode} — vulnerabilities may be present`,
      }
    }

    return { clean: true }
  }
}
