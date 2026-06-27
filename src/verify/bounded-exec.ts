// C-0 Task 0.1: BoundedExec implementation — untrusted-repro runner
// Wraps spawn with: ActionMonitor gate, process-group kill on timeout, capped output buffer.

import { spawn } from 'child_process'
import { ActionMonitor } from '../safety/action-monitor.js'
import type { BoundedExec, BoundedExecResult } from '../ports.js'

const OUTPUT_CAP = 10_000 // last 10k chars retained

export class BoundedExecImpl implements BoundedExec {
  constructor(private actionMonitor: ActionMonitor) {}

  /** Re-root confinement to a new project dir (call alongside _resolveRepoRoot). */
  setRepoRoot(dir: string): void {
    this.actionMonitor = new ActionMonitor([dir])
  }

  run(cmd: string, cwd: string, opts: { timeoutMs: number }): Promise<BoundedExecResult> {
    // 1. Action-monitor gate — NEVER exec a blocked command
    const check = this.actionMonitor.checkBashCommand(cmd)
    if (!check.allowed) {
      return Promise.resolve({
        passed: false,
        exitCode: null,
        output: 'blocked: ' + (check.reason ?? 'command blocked'),
        timedOut: false,
        blocked: true,
      })
    }

    return new Promise<BoundedExecResult>((resolve) => {
      let timedOut = false
      let settled = false
      let outputBuf = ''

      // 2. Spawn with shell:true (arbitrary command lines) and detached:true (process-group leader)
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(cmd, { cwd, shell: true, detached: true })
      } catch (err) {
        resolve({
          passed: false,
          exitCode: null,
          output: err instanceof Error ? err.message : String(err),
          timedOut: false,
          blocked: false,
        })
        return
      }

      // 3. Collect stdout+stderr into a capped buffer
      const appendOutput = (chunk: Buffer | string) => {
        outputBuf += typeof chunk === 'string' ? chunk : chunk.toString()
        if (outputBuf.length > OUTPUT_CAP) {
          outputBuf = outputBuf.slice(outputBuf.length - OUTPUT_CAP)
        }
      }

      child.stdout?.on('data', appendOutput)
      child.stderr?.on('data', appendOutput)

      // 4. Timeout: kill the whole process group on expiry
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // process may have already exited — safe to ignore
          }
        }
      }, opts.timeoutMs)

      // 5. Resolve on close
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          // `blocked` is intentionally omitted: blocked returns early above and never reaches this path.
          passed: code === 0 && !timedOut,
          exitCode: code,
          output: outputBuf,
          timedOut,
          blocked: false,
        })
      })

      // Handle spawn error (e.g. ENOENT when shell:false; with shell:true this is rarer)
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          passed: false,
          exitCode: null,
          output: err.message,
          timedOut: false,
          blocked: false,
        })
      })
    })
  }
}
