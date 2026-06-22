// M6a: mutation gate — shells out to StrykerJS; threshold 80% (configurable)
import { spawn } from 'child_process'

export interface MutationOptions {
  threshold?: number
}

export interface MutationResult {
  score: number
  passed: boolean
  error?: string
}

export class MutationGate {
  private readonly threshold: number

  constructor(options: MutationOptions = {}) {
    this.threshold = options.threshold ?? 80
  }

  async run(cwd: string): Promise<MutationResult> {
    return new Promise((resolve) => {
      const proc = spawn('stryker', ['run', '--reporters', 'json', '--logLevel', 'off'], {
        cwd,
        shell: false,
      })

      let stdout = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr.on('data', (_chunk: Buffer) => {
        // suppress stryker stderr — only care about JSON output
      })

      proc.on('close', (exitCode: number) => {
        if (exitCode !== 0) {
          // Try to parse score anyway; if not parseable, return failed
          try {
            const data = JSON.parse(stdout) as { mutationScore?: number }
            const score = data.mutationScore ?? 0
            resolve({ score, passed: score >= this.threshold, error: `Stryker exited with code ${exitCode}` })
          } catch {
            resolve({ score: 0, passed: false, error: `Stryker exited with code ${exitCode}` })
          }
          return
        }

        try {
          const data = JSON.parse(stdout) as { mutationScore?: number }
          const score = data.mutationScore ?? 0
          resolve({ score, passed: score >= this.threshold })
        } catch {
          resolve({ score: 0, passed: false, error: 'Failed to parse Stryker JSON output' })
        }
      })
    })
  }
}
