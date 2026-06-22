// Loop detector: same task fails N consecutive times → stop, no blind retry.
// Absorbed from §13 storm-breaker's loop-break function (retained generically after DeepSeek removal).

export interface LoopDetectConfig {
  maxConsecutiveFailures: number
}

const DEFAULTS: LoopDetectConfig = { maxConsecutiveFailures: 3 }

export class LoopDetector {
  private failures = new Map<string, number>()
  private config: LoopDetectConfig

  constructor(config: Partial<LoopDetectConfig> = {}) {
    this.config = { ...DEFAULTS, ...config }
  }

  recordFailure(taskId: string): { loop: boolean; reason?: string } {
    const count = (this.failures.get(taskId) ?? 0) + 1
    this.failures.set(taskId, count)
    if (count >= this.config.maxConsecutiveFailures) {
      return {
        loop: true,
        reason: `Task "${taskId}" failed ${count} consecutive times — halting to avoid blind retry`,
      }
    }
    return { loop: false }
  }

  recordSuccess(taskId: string): void {
    this.failures.delete(taskId)
  }

  getFailureCount(taskId: string): number {
    return this.failures.get(taskId) ?? 0
  }
}
