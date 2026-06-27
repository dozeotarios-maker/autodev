// G2: block recursive-delete, out-of-bounds-write, egress (G22/G24)

import * as fs from 'fs'
import * as os from 'os'
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
 * Resolve a path to its real (symlink-dereferenced) target.
 *
 * Fix 4 (Item 4): when the leaf doesn't exist (ENOENT), realpathSync throws and a
 * naive path.resolve fallback would NOT dereference a symlinked ancestor. Instead,
 * walk UP to the nearest existing ancestor, realpath THAT (following symlinks), then
 * re-join the missing tail — so a symlinked parent dir with a missing leaf still
 * resolves through the symlink.
 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    // Leaf (or some ancestor) doesn't exist. Find the nearest existing ancestor,
    // realpath it, then append the non-existent tail.
    const abs = path.resolve(p)
    let cur = abs
    const tail: string[] = []
    // Walk up until an existing dir is found or we hit the filesystem root.
    while (true) {
      const parent = path.dirname(cur)
      // Reached the root (dirname is idempotent at the root) without finding any
      // existing ancestor — fall back to the resolved absolute path.
      if (parent === cur) return abs
      tail.unshift(path.basename(cur))
      try {
        const realParent = fs.realpathSync(parent)
        return path.join(realParent, ...tail)
      } catch {
        cur = parent
      }
    }
  }
}

/**
 * Normalize a write-target token before the absolute-path/allowedPaths check (Item 2):
 *   (a) strip a single pair of surrounding matching quotes (" or ')
 *   (b) expand a leading `~` or `~/` to os.homedir()
 *   (c) expand a leading `$HOME` or `${HOME}` (optionally followed by `/…`) to os.homedir()
 * Returns the normalized token (unchanged when no rule applies).
 */
function normalizeWriteToken(tokenRaw: string): string {
  let t = tokenRaw
  // (a) strip surrounding matching quotes
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      t = t.slice(1, -1)
    }
  }
  const home = os.homedir()
  // (b) leading tilde: `~` alone or `~/rest`
  if (t === '~') return home
  if (t.startsWith('~/')) return path.join(home, t.slice(2))
  // (c) leading $HOME / ${HOME}
  if (t === '$HOME' || t === '${HOME}') return home
  if (t.startsWith('$HOME/')) return path.join(home, t.slice('$HOME/'.length))
  if (t.startsWith('${HOME}/')) return path.join(home, t.slice('${HOME}/'.length))
  return t
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

  // Item 2: a token is an "absolute write target" if, after stripping surrounding
  // quotes and expanding leading ~ / $HOME, it resolves to an absolute path.
  const asAbsTarget = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined
    const norm = normalizeWriteToken(raw)
    return norm.startsWith('/') ? norm : undefined
  }

  // 1. Redirect targets: `> /abs/path`, `>> /abs/path`, `>/abs/path`, `>>/abs/path`
  //    Also handles no-space variants embedded in any token (e.g. `x>/root/f`) and
  //    quoted / ~ / $HOME targets (e.g. `> ~/f`, `> "${HOME}/f"`, `> "/root/f"`).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // Bare operator: next token is the target
    if (t === '>' || t === '>>') {
      const target = asAbsTarget(tokens[i + 1])
      if (target) return target
      continue
    }
    // Scan the token for `>>` or `>` followed by a path anywhere in the token.
    // e.g. `x>/root/f`, `x>>/root/f`, `>>/root/f`, `>/root/f`, `x>~/f`, `x>"$HOME/f"`
    for (const op of ['>>', '>']) {
      const idx = t.indexOf(op)
      if (idx !== -1) {
        const after = t.slice(idx + op.length)
        if (after !== '') {
          const target = asAbsTarget(after)
          if (target) return target
        } else if (i + 1 < tokens.length) {
          // Operator at end of token — next token is the path
          const target = asAbsTarget(tokens[i + 1])
          if (target) return target
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
      const target = asAbsTarget(t)
      if (target) return target
      break // non-flag non-absolute → stop (relative path, not our concern)
    }
  }

  // 3. `dd of=<path>`
  for (const t of tokens) {
    if (t.startsWith('of=')) {
      const target = asAbsTarget(t.slice(3))
      if (target) return target
    }
  }

  // 4. `-o <path>` / `--output <path>` (curl, wget)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-o' || tokens[i] === '--output') {
      const target = asAbsTarget(tokens[i + 1])
      if (target) return target
    }
    // `--output=<path>`
    if (tokens[i].startsWith('--output=')) {
      const target = asAbsTarget(tokens[i].slice('--output='.length))
      if (target) return target
    }
  }

  // 5. `cp` / `mv` — detect as the head of ANY &&/;/| -split segment (Item 3).
  //    Write target = the `-t <dir>` / `--target-directory=<dir>` value if present,
  //    otherwise the DESTINATION (last non-flag arg). Sources (earlier args) are
  //    reads and are NOT flagged, so `cp /root/src ./local` stays allowed.
  for (const seg of cmd.split(/&&|\|\||[;|]/)) {
    const segTokens = seg.trim().split(/\s+/).filter((x) => x.length > 0)
    if (segTokens.length === 0) continue
    const head = segTokens[0]
    if (head !== 'cp' && head !== 'mv') continue

    // -t <dir> / --target-directory=<dir>
    let targetDir: string | undefined
    for (let i = 1; i < segTokens.length; i++) {
      const tok = segTokens[i]
      if (tok === '-t' || tok === '--target-directory') {
        targetDir = segTokens[i + 1]
        break
      }
      if (tok.startsWith('--target-directory=')) {
        targetDir = tok.slice('--target-directory='.length)
        break
      }
    }
    if (targetDir !== undefined) {
      const target = asAbsTarget(targetDir)
      if (target) return target
      // -t target is relative → not our concern; skip the destination scan below.
      continue
    }

    // No -t: destination is the LAST non-flag argument.
    let dest: string | undefined
    for (let i = segTokens.length - 1; i >= 1; i--) {
      if (segTokens[i].startsWith('-')) continue
      dest = segTokens[i]
      break
    }
    const target = asAbsTarget(dest)
    if (target) return target
  }

  // 6. `mkdir <abspath>` — first non-flag argument
  const firstToken = tokens[0]
  if (firstToken === 'mkdir') {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.startsWith('-')) continue // skip -p, -m etc.
      const target = asAbsTarget(t)
      if (target) return target
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
