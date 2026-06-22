// M6a: deterministic verifier — exit-code based, never uses LLM trace
import { spawn } from 'child_process'

export interface DeterministicResult {
  passed: boolean
  exitCode: number
  output: string
}

export class DeterministicVerifier {
  async run(testCmd: string, cwd: string): Promise<DeterministicResult> {
    return new Promise((resolve) => {
      const [bin, ...args] = testCmd.split(' ')
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
