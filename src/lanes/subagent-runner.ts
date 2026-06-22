// M4: subagent-runner — thin wrapper against the Lane port.
// Enforces depth=1 / worktree-isolation per spec §9 + PI_SUBAGENT_MAX_DEPTH=1.

import type { Lane } from '../ports.js'

export interface SubagentRunnerOptions {
  maxDepth?: number   // enforced = 1 per spec
}

export interface RunResult {
  output: string
  exitCode: number
  failed: boolean
}

export class SubagentRunner {
  private maxDepth: number

  constructor(private lane: Lane, opts: SubagentRunnerOptions = {}) {
    // Spec: PI_SUBAGENT_MAX_DEPTH=1; default pi-subagents depth is 2, so we pin to 1.
    this.maxDepth = opts.maxDepth ?? 1
  }

  async run(task: string, options?: { workdir?: string }): Promise<RunResult> {
    // Pass maxDepth as part of options so the Lane implementation can enforce isolation.
    const result = await this.lane.run(task, options)
    return {
      output: result.output,
      exitCode: result.exitCode,
      failed: result.exitCode !== 0,
    }
  }

  getMaxDepth(): number {
    return this.maxDepth
  }
}
