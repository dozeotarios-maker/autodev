// M6b: AI-slop humanizer — detects AI-slop patterns + LLM critic for prose quality
import type { Judge } from '../ports.js'

export interface ReviewFinding {
  severity: 'CRIT' | 'HIGH' | 'MED' | 'LOW'
  description: string
}

export interface HumanizerResult {
  slopDetected: boolean
  findings: ReviewFinding[]
}

const SLOP_PATTERNS: RegExp[] = [
  /certainly[!,]?/i,
  /as an AI( language model)?/i,
  /I would be happy to/i,
  /I('d| would) be (delighted|glad|pleased) to/i,
  /in conclusion[,!]/i,
  /leveraging synerg/i,
  /paramount/i,
  /it is important to note/i,
  /cutting.edge technology/i,
  /\bsimply\b/i,
  /\bbasically\b/i,
]

export class Humanizer {
  constructor(private readonly judge: Judge) {}

  async analyze(text: string): Promise<HumanizerResult> {
    const findings: ReviewFinding[] = []

    // Static slop pattern detection
    for (const pattern of SLOP_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({
          severity: 'LOW',
          description: `AI-slop pattern detected: "${pattern.source}"`,
        })
        break // one finding per static check is enough
      }
    }

    // LLM critic pass — isDone(prompt, text) where false = poor prose quality
    const goodProse = await this.judge.isDone(
      'Is this prose natural, concise, and free of AI-slop filler phrases?',
      text
    )
    if (!goodProse) {
      findings.push({
        severity: 'LOW',
        description: 'LLM critic flagged prose as AI-slop quality',
      })
    }

    return {
      slopDetected: findings.length > 0,
      findings,
    }
  }
}
