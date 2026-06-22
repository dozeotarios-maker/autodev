// M6a: deterministic verifier — exit-code based, never uses LLM trace
import { spawn } from 'child_process'

export interface DeterministicResult {
  passed: boolean
  exitCode: number
  output: string
}

const ALLOWED_BINARIES = new Set(['npm', 'npx', 'vitest', 'jest', 'node', 'pnpm', 'yarn', 'true'])

export class DeterministicVerifier {
  async run(testCmd: string, cwd: string): Promise<DeterministicResult> {
    return new Promise((resolve, reject) => {
      // Naive split on spaces — does not handle quoted args; documented limitation.
      const [bin, ...args] = testCmd.split(' ')
      if (!bin || !ALLOWED_BINARIES.has(bin)) {
        reject(new Error(`DeterministicVerifier: binary "${bin}" not in allowlist (${[...ALLOWED_BINARIES].join(', ')})`))
        return
      }
      const proc = spawn(bin, args, { cwd, shell: false })

      let output = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      proc.on('close', (exitCode: number) => {
        resolve({
          passed: exitCode === 0,
          exitCode,
          output,
        })
      })
    })
  }
}
