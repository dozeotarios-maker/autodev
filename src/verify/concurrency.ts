// M6b: G23 concurrency lens — flags race conditions in diffs
import type { Judge } from '../ports.js'

export interface ConcurrencyFinding {
  description: string
  pattern?: string
}

export interface ConcurrencyResult {
  hasRace: boolean
  findings: ConcurrencyFinding[]
}

// Static patterns that indicate potential race conditions
const RACE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /await\s+\w+\.exists?\s*\(.*\)[\s\S]{0,200}await\s+\w+\.write/,
    description: 'TOCTOU: existence check followed by write — race window exists',
  },
  {
    pattern: /Promise\.all\s*\(\s*\[[\s\S]*\+\+|--[\s\S]*\]\s*\)/,
    description: 'Shared mutable counter incremented inside Promise.all — data race',
  },
  {
    pattern: /let\s+\w+\s*=\s*0[\s\S]{0,300}async\s+function[\s\S]{0,300}\+\+/,
    description: 'Shared mutable variable mutated in async function without synchronization',
  },
]

export class ConcurrencyLens {
  constructor(private readonly judge: Judge) {}

  async analyze(diff: string): Promise<ConcurrencyResult> {
    const findings: ConcurrencyFinding[] = []

    // Static pattern detection
    for (const { pattern, description } of RACE_PATTERNS) {
      if (pattern.test(diff)) {
        findings.push({ description, pattern: pattern.source })
      }
    }

    // LLM judge pass — isStillRight(prompt, diff) where aligned=false signals race
    const { aligned, reason } = await this.judge.isStillRight(
      'Does this code diff introduce any concurrency issues, race conditions, or unprotected shared state mutations?',
      diff
    )

    if (!aligned) {
      findings.push({
        description: reason ?? 'Concurrency issue flagged by lens',
      })
    }

    return {
      hasRace: findings.length > 0,
      findings,
    }
  }
}
