// M3: H7 ambiguity gate.
// Evaluates idea clarity; if ambiguous, surfaces exactly ONE batched clarifying question.
// Rule: never batch more than 1 question (spec H7).

export interface AmbiguityResult {
  ambiguous: boolean
  questions: string[]
}

// Specificity signals that reduce ambiguity score:
const SPECIFICITY_PATTERNS = [
  /src\/[^\s]+\.(ts|js|py|go|rs)/i,   // file path mentioned
  /\b(GET|POST|PUT|DELETE|PATCH)\b/,   // HTTP method
  /\b(returns?|responds?\s+with|outputs?)\b/i,
  /\b(test|spec|endpoint|route|function|method|class|schema)\b/i,
  /\b(table|column|field|index|migration)\b/i,
  /\b(JSON|YAML|CSV|XML)\b/i,
  /\bexample[s]?\s*:/i,
  /\b\d+\s*(ms|seconds?|minutes?|KB|MB|GB)\b/i,
]

// Vague idea signals that raise ambiguity:
const VAGUE_PATTERNS = [
  /^fix\s+it$/i,
  /^do\s+something$/i,
  /^build\s+something\b/i,
  /^make\s+it\s+(better|work|faster)$/i,
]

const AMBIGUITY_WORD_THRESHOLD = 8   // fewer than N words → likely vague
const SPECIFICITY_THRESHOLD = 2      // need at least N specificity signals to be clear

export class AmbiguityGate {
  async evaluate(idea: string): Promise<AmbiguityResult> {
    const trimmed = idea.trim()

    // Hard-vague patterns
    if (VAGUE_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        ambiguous: true,
        questions: [this.generateQuestion(trimmed)],
      }
    }

    const words = trimmed.split(/\s+/).filter(Boolean)
    const specificityCount = SPECIFICITY_PATTERNS.filter((p) => p.test(trimmed)).length

    if (words.length < AMBIGUITY_WORD_THRESHOLD || specificityCount < SPECIFICITY_THRESHOLD) {
      return {
        ambiguous: true,
        questions: [this.generateQuestion(trimmed)],
      }
    }

    return { ambiguous: false, questions: [] }
  }

  private generateQuestion(idea: string): string {
    if (idea.length < 20) {
      return `What specifically should change, and in which file or module? (e.g. "add X to src/Y.ts that does Z")`
    }
    return `Could you clarify the expected outcome? What file/module should be changed and what should the result look like?`
  }
}
