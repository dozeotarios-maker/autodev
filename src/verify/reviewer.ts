// M6a: R1 clean-context reviewer — sees diff only, never spec or LLM trace
import type { Judge } from '../ports.js'

export interface ReviewInput {
  diff: string
  spec: string    // received but intentionally NOT passed to judge
  llmTrace: string // received but intentionally NOT passed to judge
}

export interface ReviewResult {
  clean: boolean
  reason?: string
}

export class R1Reviewer {
  constructor(private readonly judge: Judge) {}

  async review(input: ReviewInput): Promise<ReviewResult> {
    // Clean-context: pass ONLY the diff — spec and llmTrace never reach the judge
    const result = await this.judge.isStillRight(input.diff, input.diff)
    return {
      clean: result.aligned,
      reason: result.reason,
    }
  }
}
