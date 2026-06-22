import { spawn } from 'child_process'

/**
 * GitleaksHook — backstop secret scanner that shells out to the `gitleaks` CLI.
 *
 * In tests the `child_process.spawn` boundary is mocked (G12).
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
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(binary, args, { cwd, shell: false })
    } catch (err) {
      reject(new Error(`GitleaksHook: failed to spawn gitleaks — ${(err as Error).message}`))
      return
    }

    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    // stderr suppressed — gitleaks writes non-JSON diagnostics there

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        // Binary not found — resolve as skipped (degrade gracefully, no crash)
        resolve({ stdout: '', exitCode: -1 })
      } else {
        reject(new Error(`GitleaksHook: gitleaks scan failed — ${err.message}`))
      }
    })

    proc.on('close', (exitCode: number | null) => {
      const code = exitCode ?? -1
      if (code === 0) {
        resolve({ stdout, exitCode: 0 })
      } else if (code === 1) {
        // gitleaks exit 1 = secrets found; stdout carries the JSON report
        resolve({ stdout, exitCode: 1 })
      } else {
        reject(new Error(`GitleaksHook: gitleaks scan failed — exit code ${code}`))
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
    // --no-git and --staged are mutually exclusive: --staged implies git mode
    const args = ['detect', '--report-format', 'json']
    if (options.staged) {
      args.push('--staged')
    } else {
      args.push('--no-git')
    }

    const result = await runGitleaks(this.binary, args, this.cwd)

    if (result.exitCode === -1) {
      // Binary not found — degrade gracefully: skip + log, no crash
      console.log(`[GitleaksHook] gitleaks binary not found — skipping secret scan`)
      return { clean: true, findings: [] }
    }

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
