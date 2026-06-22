// M6b: review-to-zero loop — drives CRIT/HIGH to zero, cap 5 rounds, files LOW/MED
import type { Judge } from '../ports.js'

export interface ReviewFinding {
  severity: 'CRIT' | 'HIGH' | 'MED' | 'LOW'
  description: string
  file?: string
  line?: number
}

export type ReviewerFn = (diff: string) => Promise<ReviewFinding[]>

// fixerFn receives remaining CRIT/HIGH findings and returns an updated diff after applying fixes.
// Without a fixerFn, the loop reviews the diff once and returns immediately (no re-review of
// unchanged input since that would trivially loop to cap without ever converging).
export type FixerFn = (findings: ReviewFinding[], currentDiff: string) => Promise<string>

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
    private readonly reviewer: ReviewerFn,
    private readonly fixerFn?: FixerFn
  ) {}

  async run(diff: string): Promise<LoopResult> {
    const filed: ReviewFinding[] = []
    let remainingCritHigh: ReviewFinding[] = []
    let currentDiff = diff
    let rounds = 0

    for (let i = 0; i < MAX_ROUNDS; i++) {
      rounds++
      const findings = await this.reviewer(currentDiff)

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

      if (this.fixerFn) {
        // Apply fixes to produce a new diff for the next review round.
        currentDiff = await this.fixerFn(critHigh, currentDiff)
      }
      // Without a fixerFn the same diff is re-reviewed each round. A non-deterministic
      // reviewer (e.g. LLM-backed) may still converge; a deterministic one will hit cap.
    }

    // Cap reached with CRIT/HIGH remaining
    return { success: false, rounds, filed, remainingCritHigh }
  }
}
