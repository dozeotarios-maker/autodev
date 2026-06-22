// S2-M7: mutation gate — invokes StrykerJS via pi.exec (or child_process.spawn).
// Missing binary degrades gracefully: skip + log, no crash.
// Exit-code gate: 0 = parse score; non-zero = failed (score may still be parseable).

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

export interface MutationOptions {
  threshold?: number
  exec?: ExecFn
}

export interface MutationResult {
  score: number
  passed: boolean
  skipped?: boolean
  error?: string
}

// Recorded sample shape for output parsing validation
export interface StrykerJsonOutput {
  mutationScore?: number
}

/** Default exec using child_process.spawn wrapped as a promise */
function defaultExec(
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<PiExecResult> {
  return new Promise((resolve) => {
    const { spawn } = require('child_process') as typeof import('child_process')
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
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ stdout, stderr: err.message, exitCode: -1 })
    })

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

export class MutationGate {
  private readonly threshold: number
  private readonly exec: ExecFn

  constructor(options: MutationOptions = {}) {
    this.threshold = options.threshold ?? 80
    this.exec = options.exec ?? defaultExec
  }

  async run(cwd: string): Promise<MutationResult> {
    let result: PiExecResult
    try {
      result = await this.exec('stryker', ['run', '--reporters', 'json', '--logLevel', 'off'], { cwd })
    } catch (err) {
      // Binary missing or spawn error — degrade gracefully
      const msg = String(err)
      if (this._isMissingBinary(msg)) {
        console.log('[MutationGate] stryker binary not found — skipping mutation test')
        return { score: 0, passed: false, skipped: true, error: 'stryker binary not found' }
      }
      return { score: 0, passed: false, error: msg }
    }

    // Exit code -1 means spawn error (binary not found from within defaultExec)
    if (result.exitCode === -1) {
      if (this._isMissingBinary(result.stderr)) {
        console.log('[MutationGate] stryker binary not found — skipping mutation test')
        return { score: 0, passed: false, skipped: true, error: 'stryker binary not found' }
      }
      return { score: 0, passed: false, error: result.stderr || 'spawn failed' }
    }

    // Parse the JSON output regardless of exit code (score may be available on non-zero)
    try {
      const data = JSON.parse(result.stdout) as StrykerJsonOutput
      const score = data.mutationScore ?? 0
      const passed = result.exitCode === 0 && score >= this.threshold
      const error = result.exitCode !== 0 ? `Stryker exited with code ${result.exitCode}` : undefined
      return { score, passed, error }
    } catch {
      if (result.exitCode !== 0) {
        return { score: 0, passed: false, error: `Stryker exited with code ${result.exitCode}` }
      }
      return { score: 0, passed: false, error: 'Failed to parse Stryker JSON output' }
    }
  }

  private _isMissingBinary(msg: string): boolean {
    return /ENOENT|not found|No such file/i.test(msg)
  }
}
