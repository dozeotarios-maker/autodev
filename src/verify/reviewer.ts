// S2-M4: R1 clean-context reviewer — spawns a `reviewer` subagent given ONLY the diff.
// Spec and builder-trace are intentionally NEVER passed to the subagent task.
import type { SubagentDriver } from '../host/subagent-driver.js'

export interface ReviewInput {
  diff: string
  spec: string    // received but intentionally NOT passed to the subagent task
  llmTrace: string // received but intentionally NOT passed to the subagent task
}

export interface ReviewResult {
  clean: boolean
  reason?: string
}

export class R1Reviewer {
  constructor(private readonly driver: SubagentDriver) {}

  async review(input: ReviewInput): Promise<ReviewResult> {
    // Clean-context: pass ONLY the diff — spec and llmTrace never reach the subagent.
    const task =
      `You are a code reviewer. Review this diff for correctness, security, and quality.\n\n` +
      `Diff:\n${input.diff}\n\n` +
      `Reply with JSON: {"aligned": true} if the diff is clean, ` +
      `{"aligned": false, "reason": "<one-line finding>"} if issues found. No other text.`

    const results = await this.driver.invoke([{ agent: 'reviewer', task }])
    const output = results[0]?.output ?? ''

    try {
      const parsed = JSON.parse(output.trim()) as { aligned?: boolean; reason?: string }
      if (typeof parsed.aligned !== 'boolean') {
        return { clean: false, reason: 'reviewer output unparseable' }
      }
      return { clean: parsed.aligned, reason: parsed.reason }
    } catch {
      return { clean: false, reason: 'reviewer output unparseable' }
    }
  }
}
