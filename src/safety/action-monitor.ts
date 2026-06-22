// G2: block recursive-delete, out-of-bounds-write, egress (G22/G24)

export interface ActionCheckResult {
  allowed: boolean
  reason?: string
}

const DANGEROUS_BASH_PATTERNS = [
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/,   // rm -rf, rm -fr, rm -Rf …
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/,   // rm -fr variant
  /rm\s+--no-preserve-root/i,
]

// All legitimate outbound hosts for pi-autodev:
//   - GitHub/npm: VCS + package registry
//   - generativelanguage.googleapis.com: Gemini LLM API
//   - localhost variants: Letta (8283), Ollama (11434), codebase-memory (7777)
//
// IMPORTANT: all fetch() calls in this codebase MUST route through checkEgress()
// before executing. checkEgress() is the sole egress gate (G22/G24).
//
// Split allowlist:
//   EGRESS_EXACT  — non-TLD tokens matched by equality only (localhost, IPs).
//                   hostname.endsWith('.localhost') must NOT pass.
//   EGRESS_SUFFIX — real domain roots matched by exact OR subdomain suffix.
//                   e.g. 'github.com' matches 'github.com' and 'api.github.com'.
const EGRESS_EXACT = new Set([
  // Local services (Letta :8283, Ollama :11434, codebase-memory :7777)
  'localhost',
  '127.0.0.1',
  '::1',
])

const EGRESS_SUFFIX = new Set([
  'github.com',
  'githubusercontent.com',
  'npmjs.com',
  'npmjs.org',
  // Gemini LLM API
  'generativelanguage.googleapis.com',
])

export class ActionMonitor {
  constructor(private allowedPaths: string[] = []) {}

  checkBashCommand(cmd: string): ActionCheckResult {
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return { allowed: false, reason: `Blocked dangerous command: ${cmd.slice(0, 80)}` }
      }
    }
    return { allowed: true }
  }

  checkFileWrite(filePath: string): ActionCheckResult {
    if (this.allowedPaths.length === 0) return { allowed: true }
    const normalized = filePath.replace(/\\/g, '/')
    const ok = this.allowedPaths.some(p => normalized.startsWith(p.replace(/\\/g, '/')))
    if (!ok) {
      return { allowed: false, reason: `Write to out-of-bounds path blocked: ${filePath}` }
    }
    return { allowed: true }
  }

  checkEgress(url: string): ActionCheckResult {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` }
    }
    // Exact match for non-TLD entries (localhost, IPs): subdomain suffix NOT allowed.
    if (EGRESS_EXACT.has(hostname)) return { allowed: true }
    // Suffix match for real domains: exact or '.<domain>' subdomain.
    for (const domain of EGRESS_SUFFIX) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return { allowed: true }
    }
    return { allowed: false, reason: `Egress blocked: ${hostname} not in allowlist` }
  }
}
