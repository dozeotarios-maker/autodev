// M6b: G21 dep-vetting — license + CVE + maintenance check
// External CLI boundary (osv-scanner / trivy) is injected/mocked in tests (G12)
import { spawn } from 'child_process'

export interface DepVetOptions {
  allowedLicenses?: string[]
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

export class DepVetter {
  private readonly allowedLicenses: string[]

  constructor(options: DepVetOptions = {}) {
    this.allowedLicenses = options.allowedLicenses ?? DEFAULT_ALLOWED_LICENSES
  }

  async vet(input: DepVetInput): Promise<DepVetResult> {
    // License check (static — no CLI needed)
    if (input.license && !this.allowedLicenses.includes(input.license)) {
      return {
        allowed: false,
        reason: `License "${input.license}" not in allowlist: ${this.allowedLicenses.join(', ')}`,
      }
    }

    // CVE scan via osv-scanner (mocked in tests)
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

  private runOsvScan(input: DepVetInput): Promise<{ clean: boolean; reason?: string }> {
    return new Promise((resolve) => {
      const args = ['scan', '--format', 'json', '--lockfile', `${input.cwd}/package-lock.json`]
      const proc = spawn('osv-scanner', args, { cwd: input.cwd, shell: false })

      let stdout = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr.on('data', (_chunk: Buffer) => {})

      proc.on('close', (exitCode: number) => {
        if (exitCode !== 0) {
          // exitCode 1 from osv-scanner means vulnerabilities found
          try {
            const data = JSON.parse(stdout) as {
              results?: Array<{ packages?: Array<{ vulnerabilities?: Array<{ id: string; severity: string }> }> }>
            }
            const vulns = data.results?.flatMap(r =>
              r.packages?.flatMap(p => p.vulnerabilities ?? []) ?? []
            ) ?? []
            if (vulns.length > 0) {
              const ids = vulns.map(v => v.id).join(', ')
              resolve({ clean: false, reason: `CVE found: ${ids}` })
              return
            }
          } catch {
            // parse error — treat as vulnerability found
          }
          resolve({ clean: false, reason: `osv-scanner exited with code ${exitCode} — vulnerabilities may be present` })
          return
        }
        resolve({ clean: true })
      })
    })
  }
}
