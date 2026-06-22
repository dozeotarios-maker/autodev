// S2-M5: subagent-runner — two classes:
//
//   SubagentRunner   — original Lane-port-based runner (kept for backward compat;
//                      used by src/extension/index.ts and Stage-1 tests).
//
//   LaneSubagentRunner — S2-M5 rewrite: maps LaneAssignment[] → SubagentDriver.invoke()
//                        with worktree:true so each lane runs in a worktree-isolated
//                        pi-subagent. This is the real build-lane implementation.
//
// Clean-tree precondition: the SubagentDriver stash guard handles it automatically
// when worktree:true is passed — LaneSubagentRunner relies on that invariant.

import type { Lane } from '../ports.js'
import type { LaneAssignment } from './partitioner.js'
import type { SubagentDriver } from '../host/subagent-driver.js'
import type { SubagentTask, SubagentResult } from '../host/types.js'

// ── Original SubagentRunner (Lane-port-based, backward compat) ────────────────

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

// ── S2-M5: LaneSubagentRunner (SubagentDriver-based, real pi-subagents) ───────

export interface LaneRunResult {
  /** Lane id from the partitioner (e.g. "lane-1") */
  laneId: string
  /** Files this lane is responsible for */
  files: string[]
  /** Raw output text from the subagent tool result */
  output: string
  /** True when the subagent reported a known failure pattern */
  failed: boolean
}

export interface LaneSubagentRunnerOptions {
  /** Max concurrent subagent lanes. Forwarded to SubagentDriver as concurrency. Default: 5 */
  concurrency?: number
  /** Agent role label injected into each subagent task. Default: "worker" */
  defaultAgent?: string
}

export class LaneSubagentRunner {
  private concurrency: number
  private defaultAgent: string

  constructor(
    private driver: SubagentDriver,
    opts: LaneSubagentRunnerOptions = {}
  ) {
    this.concurrency = opts.concurrency ?? 5
    this.defaultAgent = opts.defaultAgent ?? 'worker'
  }

  /**
   * Run all lanes in parallel as worktree-isolated pi-subagents.
   *
   * Each LaneAssignment becomes one SubagentTask. The SubagentDriver composes a
   * single subagent instruction (with worktree:true) that the host's LLM dispatches
   * in parallel. Results are correlated by index back to their originating lane.
   */
  async run(lanes: LaneAssignment[]): Promise<LaneRunResult[]> {
    if (lanes.length === 0) {
      return []
    }

    // Map each lane to a SubagentTask.
    const tasks: SubagentTask[] = lanes.map((lane) => ({
      agent: this.defaultAgent,
      task: buildLaneTask(lane),
    }))

    // Invoke all tasks via the SubagentDriver with worktree isolation.
    // The driver stashes a dirty tree if present and pops after.
    const results: SubagentResult[] = await this.driver.invoke(tasks, {
      worktree: true,
      concurrency: this.concurrency,
    })

    // Correlate results back to lane assignments by index.
    return lanes.map((lane, i) => {
      const result = results[i]
      const output = result?.output ?? ''
      return {
        laneId: lane.id,
        files: lane.files,
        output,
        failed: isFailedOutput(output),
      }
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a descriptive task string for a lane.
 * The subagent receives this as its work instruction.
 */
function buildLaneTask(lane: LaneAssignment): string {
  const fileList = lane.files.join(', ')
  return `Lane ${lane.id}: implement changes for the following files: [${fileList}]`
}

/**
 * Heuristic: treat output as failed if it contains an error marker.
 * Real subagent errors surface via isError on the tool result, but we
 * also catch common text patterns as a belt-and-suspenders guard.
 */
function isFailedOutput(output: string): boolean {
  const lower = output.toLowerCase()
  return lower.includes('error:') || lower.includes('fatal:') || lower.startsWith('failed')
}
