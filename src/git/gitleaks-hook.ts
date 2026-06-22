import { execFile } from 'child_process'

/**
 * GitleaksHook — backstop secret scanner that shells out to the `gitleaks` CLI.
 *
 * In tests the `child_process.execFile` boundary is mocked (G12).
 * In production the real gitleaks binary (8.30.1+) must be on PATH.
 *
 * Exit codes (gitleaks detect):
 *   0 = no secrets found (clean)
 *   1 = secrets found (stdout contains JSON findings)
 *   other / binary-not-found = propagated as Error
 */

export interface GitleaksScanOptions {
  staged: boolean
}

export interface GitleaksScanResult {
  clean: boolean
  findings: string[]
}

interface GitleaksLeak {
  Description?: string
  RuleID?: string
  File?: string
  StartLine?: number
}

function runGitleaks(
  binary: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd }, (err, stdout, _stderr) => {
      if (!err) {
        resolve({ stdout, exitCode: 0 })
        return
      }
      // execFile sets err.code to the numeric exit code for non-zero exits
      const rawCode = (err as NodeJS.ErrnoException).code
      const code = rawCode !== undefined ? Number(rawCode) : undefined
      if (code === 1) {
        // gitleaks exit 1 = secrets found; stdout carries the JSON report
        resolve({ stdout, exitCode: 1 })
      } else {
        reject(new Error(`GitleaksHook: gitleaks scan failed — ${err.message}`))
      }
    })
  })
}

export class GitleaksHook {
  constructor(
    private readonly cwd: string,
    private readonly binary: string = 'gitleaks'
  ) {}

  async scan(options: GitleaksScanOptions): Promise<GitleaksScanResult> {
    const args = ['detect', '--report-format', 'json', '--no-git']
    if (options.staged) {
      args.push('--staged')
    }

    const result = await runGitleaks(this.binary, args, this.cwd)

    if (result.exitCode === 0) {
      return { clean: true, findings: [] }
    }

    // exit 1 → secrets found
    return { clean: false, findings: this.parseFindings(result.stdout) }
  }

  private parseFindings(stdout: string): string[] {
    try {
      const leaks = JSON.parse(stdout) as GitleaksLeak[]
      if (!Array.isArray(leaks)) return [stdout]
      return leaks.map((l) => {
        const parts: string[] = []
        if (l.Description) parts.push(l.Description)
        if (l.RuleID) parts.push(`rule:${l.RuleID}`)
        if (l.File) parts.push(`file:${l.File}`)
        if (l.StartLine != null) parts.push(`line:${l.StartLine}`)
        return parts.join(' | ') || 'secret detected'
      })
    } catch {
      return stdout ? [stdout] : ['secret detected (unparseable output)']
    }
  }

  // Satisfies GitOps port shape (scanSecrets)
  async scanSecrets(staged: boolean): Promise<{ clean: boolean; findings: string[] }> {
    return this.scan({ staged })
  }
}
