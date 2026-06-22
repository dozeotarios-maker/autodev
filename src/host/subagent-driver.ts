// S2-M1: SubagentDriver — dispatches parallel subagent tasks via HostAgent.steer().
//
// The subagent tool is LLM-mediated: we compose a prompt instructing the host to
// call the `subagent` tool with {tasks, concurrency, worktree}, steer it, then
// parse the results by filtering TurnEndEvent.toolResults where toolName==='subagent'.
// Correlation by task index: the subagent tool is expected to return one result per task,
// in order (index 0..N-1).

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { HostAgent } from './host-agent.js'
import type {
  SubagentTask,
  SubagentResult,
  SubagentInvokeOptions,
  ToolResultEntry,
} from './types.js'
import { DirtyTreeError } from './types.js'

const execFileAsync = promisify(execFile)

/** Injectable git executor for testing */
export type GitExec = (args: string[], cwd: string) => Promise<{ stdout: string }>

function defaultGitExec(args: string[], cwd: string): Promise<{ stdout: string }> {
  return execFileAsync('git', args, { cwd }).then(({ stdout }) => ({ stdout }))
}

export class SubagentDriver {
  private gitExec: GitExec

  constructor(
    private hostAgent: HostAgent,
    opts?: { gitExec?: GitExec }
  ) {
    this.gitExec = opts?.gitExec ?? defaultGitExec
  }

  /**
   * Invoke parallel subagent tasks via the host's `subagent` tool.
   *
   * Flow:
   *   1. If worktree:true, check git status — stash if dirty, pop after.
   *   2. Compose a prompt instructing the host to call `subagent` with {tasks, concurrency, worktree}.
   *   3. steer() → await agent_end.
   *   4. Filter toolResults where toolName==='subagent'; correlate by task index.
   */
  async invoke(
    tasks: SubagentTask[],
    opts: SubagentInvokeOptions = {}
  ): Promise<SubagentResult[]> {
    const { worktree = false, concurrency } = opts

    let stashed = false
    const cwd = process.cwd()

    if (worktree) {
      stashed = await this._stashIfDirty(cwd)
    }

    try {
      const instruction = buildSubagentInstruction(tasks, { worktree, concurrency })
      const result = await this.hostAgent.steer(instruction, {
        expectTool: 'subagent',
      })

      return correlateResults(tasks, result.toolResults)
    } finally {
      if (stashed) {
        await this._stashPop(cwd)
      }
    }
  }

  // ── Git helpers ────────────────────────────────────────────────────────────

  private async _stashIfDirty(cwd: string): Promise<boolean> {
    const { stdout } = await this.gitExec(['status', '--porcelain'], cwd)
    if (!stdout.trim()) {
      return false // clean tree — nothing to stash
    }

    try {
      await this.gitExec(['stash', 'push', '-m', 'autodev-subagent-preflight'], cwd)
      return true
    } catch (err) {
      throw new DirtyTreeError(
        `Working tree is dirty and git stash failed: ${String(err)}`
      )
    }
  }

  private async _stashPop(cwd: string): Promise<void> {
    await this.gitExec(['stash', 'pop'], cwd)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a prompt instructing the host to call the `subagent` tool.
 * The host's LLM reads this and invokes the tool accordingly.
 */
function buildSubagentInstruction(
  tasks: SubagentTask[],
  opts: { worktree: boolean; concurrency?: number }
): string {
  const payload = JSON.stringify(
    {
      tasks: tasks.map((t, i) => ({ index: i, agent: t.agent, task: t.task })),
      concurrency: opts.concurrency,
      worktree: opts.worktree,
    },
    null,
    2
  )

  return [
    'Call the `subagent` tool with the following arguments to dispatch parallel subagent tasks:',
    '',
    '```json',
    payload,
    '```',
    '',
    `Run all ${tasks.length} task(s) and return one result per task in order (index 0..${tasks.length - 1}).`,
  ].join('\n')
}

/**
 * Filter toolResults for subagent calls and correlate by task index.
 * Correlates positionally (by order of filtered results).
 */
function correlateResults(
  tasks: SubagentTask[],
  toolResults: ToolResultEntry[]
): SubagentResult[] {
  // Filter to subagent tool results only
  const subagentResults = toolResults.filter(
    (r) => r.toolName === 'subagent'
  )

  return tasks.map((task, i) => {
    const match = subagentResults[i]
    const output = extractToolResultText(match)
    return {
      index: i,
      agent: task.agent,
      task: task.task,
      output,
    }
  })
}

function extractToolResultText(entry: ToolResultEntry | undefined): string {
  if (!entry) return ''
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((c) => (typeof c === 'object' && c !== null ? String(c.text ?? '') : ''))
      .join('')
  }
  return ''
}
