// Runaway backstop: max iterations/turns per run → halt + escalate.
// Safety stop against infinite loops/thrash — NOT a cost control (cost is not a factor per §3).

export interface RunawayConfig {
  maxIterations: number
  maxTurns: number
}

const DEFAULTS: RunawayConfig = { maxIterations: 200, maxTurns: 100 }

export class RunawayBackstop {
  private iterations = 0
  private turns = 0
  private config: RunawayConfig

  constructor(config: Partial<RunawayConfig> = {}) {
    this.config = { ...DEFAULTS, ...config }
  }

  tick(): { halt: boolean; reason?: string } {
    this.iterations++
    if (this.iterations >= this.config.maxIterations) {
      return { halt: true, reason: `Runaway backstop: exceeded ${this.config.maxIterations} iterations` }
    }
    return { halt: false }
  }

  tickTurn(): { halt: boolean; reason?: string } {
    this.turns++
    if (this.turns >= this.config.maxTurns) {
      return { halt: true, reason: `Runaway backstop: exceeded ${this.config.maxTurns} turns` }
    }
    return { halt: false }
  }

  reset(): void {
    this.iterations = 0
    this.turns = 0
  }
}
