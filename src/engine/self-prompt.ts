// M3: self-prompt loop — after each turn_end, writes the next instruction
// via HostAgent.steer() (which owns the await and the void-return reconciliation).
// Runaway backstop: maxIterations.
//
// Rework (S2-M1): the original typed sendUserMessage as ()=>Promise<void> which is WRONG —
// the real pi.sendUserMessage returns void (fire-and-forget). Rewired to accept a
// `steer` function (HostAgent.steer) which handles the await internally.

import type { AgentResult } from '../host/types.js'

export interface SelfPromptOptions {
  /**
   * steer(instruction) → Promise<AgentResult>.
   * Caller passes HostAgent.steer bound to the HostAgent instance.
   * This reconciles the void-return of pi.sendUserMessage: HostAgent.steer fires
   * sendUserMessage (void) then awaits the next agent_end event.
   */
  steer: (instruction: string) => Promise<AgentResult>
  maxIterations: number
}

export interface PromptResult {
  halted: boolean
  reason?: string
  agentResult?: AgentResult
}

export class SelfPromptLoop {
  private count = 0
  private opts: SelfPromptOptions

  constructor(opts: SelfPromptOptions) {
    this.opts = opts
  }

  async next(instruction: string): Promise<PromptResult> {
    if (this.count >= this.opts.maxIterations) {
      return {
        halted: true,
        reason: `Self-prompt loop halted: max iterations (${this.opts.maxIterations}) reached`,
      }
    }

    this.count++
    const agentResult = await this.opts.steer(instruction)
    return { halted: false, agentResult }
  }

  reset(): void {
    this.count = 0
  }

  getCount(): number {
    return this.count
  }
}
