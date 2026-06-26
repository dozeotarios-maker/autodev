// G2: block recursive-delete, out-of-bounds-write, egress (G22/G24)

import * as fs from 'fs'
import * as path from 'path'

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

const DEFAULT_PROTECTED_PATHS = ['/root/.openclaw']

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a path, falling back to path.resolve when the path doesn't exist yet.
 * Used for symlink resolution (fix 4).
 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Extract the first absolute-path WRITE target from a bash command string.
 * Returns undefined when no absolute write target is clearly identified
 * (conservative: only blocks on unambiguously identified absolute paths).
 *
 * Patterns scanned:
 *   - tokens after `>` or `>>` (redirect targets)
 *   - `tee <path>` (first non-flag arg)
 *   - `dd of=<path>`
 *   - `-o <path>` / `--output <path>` (curl/wget style)
 *   - `cp`/`mv` last argument (destination)
 *   - `mkdir <abspath>`
 */
function _extractBashWriteTarget(cmd: string): string | undefined {
  // Tokenize the command (simple whitespace split; does not handle quoting perfectly
  // but is conservative: false negatives are acceptable, false positives are not).
  const tokens = cmd.trim().split(/\s+/)

  // 1. Redirect targets: `> /abs/path`, `>> /abs/path`, `>/abs/path`, `>>/abs/path`
  //    Also handles no-space variants embedded in any token (e.g. `x>/root/f`).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // Bare operator: next token is the target
    if (t === '>' || t === '>>') {
      const target = tokens[i + 1]
      if (target && target.startsWith('/')) return target
      continue
    }
    // Scan the token for `>>` or `>` followed by an absolute path anywhere in the token.
    // e.g. `x>/root/f`, `x>>/root/f`, `>>/root/f`, `>/root/f`
    for (const op of ['>>', '>']) {
      const idx = t.indexOf(op)
      if (idx !== -1) {
        const after = t.slice(idx + op.length)
        if (after.startsWith('/')) return after
        // Operator at end of token — next token is the path
        if (after === '' && i + 1 < tokens.length && tokens[i + 1].startsWith('/')) {
          return tokens[i + 1]
        }
        break // only process first `>>` or `>` per token
      }
    }
  }

  // 2. `tee <path>` — first non-flag argument after `tee`
  const teeIdx = tokens.indexOf('tee')
  if (teeIdx !== -1) {
    for (let i = teeIdx + 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.startsWith('-')) continue // skip flags like -a
      if (t.startsWith('/')) return t
      break // non-flag non-absolute → stop (relative path, not our concern)
    }
  }

  // 3. `dd of=<path>`
  for (const t of tokens) {
    if (t.startsWith('of=')) {
      const target = t.slice(3)
      if (target.startsWith('/')) return target
    }
  }

  // 4. `-o <path>` / `--output <path>` (curl, wget)
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === '-o' || tokens[i] === '--output') {
      const target = tokens[i + 1]
      if (target && target.startsWith('/')) return target
    }
    // `--output=<path>`
    if (tokens[i].startsWith('--output=')) {
      const target = tokens[i].slice('--output='.length)
      if (target.startsWith('/')) return target
    }
  }

  // 5. `cp` / `mv` — last argument is the destination
  const firstToken = tokens[0]
  if (firstToken === 'cp' || firstToken === 'mv') {
    const lastToken = tokens[tokens.length - 1]
    if (lastToken && lastToken.startsWith('/')) return lastToken
  }

  // 6. `mkdir <abspath>` — first non-flag argument
  if (firstToken === 'mkdir') {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.startsWith('-')) continue // skip -p, -m etc.
      if (t.startsWith('/')) return t
      break
    }
  }

  return undefined
}

export class ActionMonitor {
  constructor(
    private allowedPaths: string[] = [],
    private protectedPaths: string[] = DEFAULT_PROTECTED_PATHS,
  ) {}

  checkBashCommand(cmd: string): ActionCheckResult {
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return { allowed: false, reason: `Blocked dangerous command: ${cmd.slice(0, 80)}` }
      }
    }
    for (const p of this.protectedPaths) {
      if (cmd.includes(p)) {
        return { allowed: false, reason: `Command touches protected path (main pipeline): ${cmd.slice(0, 80)}` }
      }
    }
    // Fix 1: block absolute-path WRITE targets that escape allowedPaths confinement.
    // Only applies when allowedPaths is set (same gate as checkFileWrite).
    if (this.allowedPaths.length > 0) {
      const absTarget = _extractBashWriteTarget(cmd)
      if (absTarget !== undefined) {
        const check = this.checkFileWrite(absTarget)
        if (!check.allowed) {
          return { allowed: false, reason: `Bash absolute-path write escape blocked: ${absTarget}` }
        }
      }
    }
    return { allowed: true }
  }

  checkFileWrite(filePath: string): ActionCheckResult {
    // Fix 4: use realpathSafe so symlinked paths resolving to protected/out-of-bounds
    // targets are caught (e.g. a symlink cwd->$HOME is caught by the guardrail).
    const r = realpathSafe(filePath)
    for (const p of this.protectedPaths) {
      const pr = realpathSafe(p)
      if (r === pr || r.startsWith(pr + path.sep)) {
        return { allowed: false, reason: `Write to protected path (main pipeline) blocked: ${filePath}` }
      }
    }
    if (this.allowedPaths.length === 0) return { allowed: true }
    // Resolve allowedPaths to absolute before comparing so repoRoot-relative confinement works
    const ok = this.allowedPaths.some(p => {
      const ap = realpathSafe(p)
      return r === ap || r.startsWith(ap + path.sep)
    })
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
