// S2-M4: SubagentJudge — implements the Judge port via SubagentDriver.invoke().
// Replaces LLMJudge (callback-injection wrong-arch).
// Each judge call spawns a cheap subagent; never calls a model directly.

import type { Judge } from '../ports.js'
import type { SubagentDriver } from '../host/subagent-driver.js'

export class SubagentJudge implements Judge {
  constructor(private readonly driver: SubagentDriver) {}

  /**
   * isDone: spawn a subagent that evaluates whether the goal has been achieved.
   * The subagent receives ONLY goal + evidence (clean-context).
   */
  async isDone(goal: string, evidence: string): Promise<boolean> {
    const task =
      `You are a done-judge. Your only job: determine whether the goal has been achieved.\n` +
      `Goal: ${goal}\n` +
      `Evidence: ${evidence}\n\n` +
      `Reply with a JSON object: {"done": true} if the goal is achieved, {"done": false} otherwise. ` +
      `No other text.`

    const results = await this.driver.invoke([{ agent: 'done-judge', task }])
    const output = results[0]?.output ?? ''

    try {
      const parsed = JSON.parse(output.trim()) as { done?: boolean }
      return parsed.done === true
    } catch {
      // Subagent output not parseable as JSON — conservative: treat as not done
      return false
    }
  }

  /**
   * isStillRight: spawn a subagent that checks whether the current diff is aligned with spec.
   * Receives ONLY spec + currentDiff (clean-context).
   */
  async isStillRight(
    spec: string,
    currentDiff: string
  ): Promise<{ aligned: boolean; reason?: string }> {
    const task =
      `You are a still-right judge. Check whether the diff is aligned with the spec.\n` +
      `Spec: ${spec}\n` +
      `Diff: ${currentDiff}\n\n` +
      `Reply with a JSON object: {"aligned": true} if aligned, ` +
      `{"aligned": false, "reason": "<one-line reason>"} if not aligned. No other text.`

    const results = await this.driver.invoke([{ agent: 'still-right-judge', task }])
    const output = results[0]?.output ?? ''

    try {
      const parsed = JSON.parse(output.trim()) as { aligned?: boolean; reason?: string }
      if (typeof parsed.aligned !== 'boolean') {
        return { aligned: true } // default safe
      }
      return { aligned: parsed.aligned, reason: parsed.reason }
    } catch {
      // Not parseable — default to aligned=true (conservative: avoid spurious backedges)
      return { aligned: true }
    }
  }
}
