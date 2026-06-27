// C-1: Debug track (D1–D5) output types and validators.
// Mirrors the P*Output pattern from src/phases/phase-output.ts.
// Each DnOutput is the typed result of a debug step steer.

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Commands allowed as the first token in a reproCommand.
 * Must match deterministic.ts ALLOWED_BINARIES (npm,npx,vitest,jest,node,pnpm,yarn,true).
 */
export const ALLOWED_BINARIES = new Set([
  'npm', 'npx', 'vitest', 'jest', 'node', 'pnpm', 'yarn', 'true',
])

export const MAX_DEBUG_ROUNDS = 3

// ── D1 — Reproduce ────────────────────────────────────────────────────────────

export interface D1Output {
  /** One-paragraph description of the repro approach. */
  reproSummary: string
  /** Full command to run the repro file, e.g. `npx vitest run tests/debug-repro-xxx.test.ts`. */
  reproCommand: string
  /** Path to the new dedicated repro file (must NOT be an existing file). */
  reproArtifact: string
  /** True once the gate confirms the repro runs red consistently. Set by controller, not steer. */
  reproConfirmedRed?: boolean
}

/**
 * Validate D1Output. Rejects:
 *   - Missing or empty required string fields.
 *   - reproCommand whose first token is not in ALLOWED_BINARIES.
 *   - reproArtifact that doesn't look like a new file path
 *     (must contain a path separator or look like a relative path with extension).
 */
export function validateD1Output(raw: unknown): raw is D1Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['reproSummary'] !== 'string' || !o['reproSummary'].trim()) return false
  if (typeof o['reproCommand'] !== 'string' || !o['reproCommand'].trim()) return false
  if (typeof o['reproArtifact'] !== 'string' || !o['reproArtifact'].trim()) return false

  // reproCommand first token must be an allowed binary
  const firstToken = (o['reproCommand'] as string).trim().split(/\s+/)[0] ?? ''
  if (!ALLOWED_BINARIES.has(firstToken)) return false

  // reproCommand must not contain shell metacharacters (plan mandates vitest-only repros;
  // metacharacters have no legit use and allow shell injection via shell:true in boundedExec)
  if (/[;&|`$><]|\$\(/.test(o['reproCommand'] as string)) return false

  // reproArtifact must look like a file path (contains path separator or has an extension)
  const artifact = (o['reproArtifact'] as string).trim()
  if (!artifact.includes('/') && !artifact.includes('\\') && !/\.[a-z]+$/i.test(artifact)) {
    return false
  }

  return true
}

// ── D2 — Root-cause ───────────────────────────────────────────────────────────

export interface HypothesisEntry {
  /** One sentence claim. */
  claim: string
  /** Evidence supporting this hypothesis. */
  evidenceFor: string
  /** Evidence against this hypothesis. */
  evidenceAgainst: string
}

export interface D2Output {
  /** Array of ≥2 competing hypotheses. */
  hypotheses: HypothesisEntry[]
  /** The selected root-cause explanation. */
  rootCause: string
  /** File + line or symbol where the root cause lives (e.g. "src/auth.ts:45"). */
  rootCauseLocation: string
}

/**
 * Validate D2Output. Rejects:
 *   - Missing or empty rootCause / rootCauseLocation.
 *   - Fewer than 2 hypotheses.
 *   - Any hypothesis entry missing claim/evidenceFor/evidenceAgainst.
 */
export function validateD2Output(raw: unknown): raw is D2Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['rootCause'] !== 'string' || !o['rootCause'].trim()) return false
  if (typeof o['rootCauseLocation'] !== 'string' || !o['rootCauseLocation'].trim()) return false
  if (!Array.isArray(o['hypotheses'])) return false
  if ((o['hypotheses'] as unknown[]).length < 2) return false

  for (const h of o['hypotheses'] as unknown[]) {
    if (!h || typeof h !== 'object') return false
    const hy = h as Record<string, unknown>
    if (typeof hy['claim'] !== 'string' || !hy['claim'].trim()) return false
    if (typeof hy['evidenceFor'] !== 'string') return false
    if (typeof hy['evidenceAgainst'] !== 'string') return false
  }

  return true
}

// ── D3 — Fix ─────────────────────────────────────────────────────────────────

export interface D3Output {
  /** One-paragraph description of the fix applied. */
  fixSummary: string
  /** List of production files changed (NOT the repro file). */
  filesChanged: string[]
}

export function validateD3Output(raw: unknown): raw is D3Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['fixSummary'] !== 'string' || !o['fixSummary'].trim()) return false
  if (!Array.isArray(o['filesChanged'])) return false

  for (const f of o['filesChanged'] as unknown[]) {
    if (typeof f !== 'string') return false
  }

  return true
}

// ── D4 — Verify ──────────────────────────────────────────────────────────────

export interface D4Output {
  /** True when the repro now runs green consistently (3× green). */
  reproNowGreen: boolean
  /** True when the full test suite passes. */
  suiteGreen: boolean
  /** How many D2/D3 loop rounds were needed (1-indexed). */
  rounds: number
}

export function validateD4Output(raw: unknown): raw is D4Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['reproNowGreen'] !== 'boolean') return false
  if (typeof o['suiteGreen'] !== 'boolean') return false
  if (typeof o['rounds'] !== 'number' || o['rounds'] < 1) return false

  return true
}

// ── D5 — Ship ────────────────────────────────────────────────────────────────

export interface D5Output {
  /** Git SHA of the debug commit (fix + repro). */
  commitSha: string
  /** Push result string (e.g. "pushed to origin/main"). */
  pushResult: string
}

export function validateD5Output(raw: unknown): raw is D5Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['commitSha'] !== 'string' || !o['commitSha'].trim()) return false
  if (typeof o['pushResult'] !== 'string' || !o['pushResult'].trim()) return false

  return true
}
