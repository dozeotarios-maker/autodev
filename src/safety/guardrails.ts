// G10: screen repo/web content for prompt injection before adding to agent context.
// G24: all repo content treated as untrusted (ICLR-2026 arXiv 2603.03456).

export interface GuardrailCheckResult {
  safe: boolean
  threats: string[]
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(your|the|all)\s+(prior|previous|earlier|above)\s+(instructions?|context|rules?)/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|unrestricted|evil|malicious)/i,
  /act\s+as\s+(if\s+)?(you\s+(are|were)\s+)?(a\s+)?(different|unrestricted|evil|malicious)/i,
  /system\s+prompt\s*:/i,
  /<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\]/,
  /forget\s+(everything|all)\s+(you|I've|above)/i,
]

export class Guardrails {
  screenContent(content: string, source: 'repo' | 'web'): GuardrailCheckResult {
    const threats: string[] = []
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        threats.push(`Potential prompt injection in ${source} content`)
        break
      }
    }
    return { safe: threats.length === 0, threats }
  }
}
