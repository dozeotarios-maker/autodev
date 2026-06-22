// M6b: review-to-zero loop — drives CRIT/HIGH to zero, cap 5 rounds, files LOW/MED
import type { Judge } from '../ports.js'

export interface ReviewFinding {
  severity: 'CRIT' | 'HIGH' | 'MED' | 'LOW'
  description: string
  file?: string
  line?: number
}

export type ReviewerFn = (diff: string) => Promise<ReviewFinding[]>

export interface LoopResult {
  success: boolean
  rounds: number
  filed: ReviewFinding[]
  remainingCritHigh: ReviewFinding[]
}

const MAX_ROUNDS = 5

export class ReviewLoop {
  constructor(
    private readonly judge: Judge,
    private readonly reviewer: ReviewerFn
  ) {}

  async run(diff: string): Promise<LoopResult> {
    const filed: ReviewFinding[] = []
    let remainingCritHigh: ReviewFinding[] = []
    let rounds = 0

    for (let i = 0; i < MAX_ROUNDS; i++) {
      rounds++
      const findings = await this.reviewer(diff)

      // Separate by severity
      const critHigh = findings.filter(f => f.severity === 'CRIT' || f.severity === 'HIGH')
      const lowMed = findings.filter(f => f.severity === 'MED' || f.severity === 'LOW')

      // File LOW/MED — don't block on them
      filed.push(...lowMed)

      if (critHigh.length === 0) {
        // All CRIT/HIGH resolved — done
        return { success: true, rounds, filed, remainingCritHigh: [] }
      }

      remainingCritHigh = critHigh
      // Continue loop to drive CRIT/HIGH to zero
    }

    // Cap reached with CRIT/HIGH remaining
    return { success: false, rounds, filed, remainingCritHigh }
  }
}
