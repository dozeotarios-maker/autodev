// M3: self-prompt loop — after each turn_end, writes the next instruction
// via sendUserMessage(deliverAs:'followUp'). Runaway backstop: maxIterations.

export interface SelfPromptOptions {
  sendUserMessage: (message: string, options: { deliverAs: 'followUp' }) => Promise<void>
  maxIterations: number
}

export interface PromptResult {
  halted: boolean
  reason?: string
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
    await this.opts.sendUserMessage(instruction, { deliverAs: 'followUp' })
    return { halted: false }
  }

  reset(): void {
    this.count = 0
  }

  getCount(): number {
    return this.count
  }
}
