// Stage D: Refactor track (R1–R4) output types and validators.
// Mirrors debug-output.ts patterns. Each RnOutput is the typed result of a refactor step steer.

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Commands allowed as the first token in a characterizationCommand.
 * Must match deterministic.ts ALLOWED_BINARIES (npm,npx,vitest,jest,node,pnpm,yarn,true).
 * Re-declared here (not re-exported from debug-output) to keep refactor module self-contained.
 */
export const ALLOWED_BINARIES = new Set([
  'npm', 'npx', 'vitest', 'jest', 'node', 'pnpm', 'yarn', 'true',
])

export const MAX_REFACTOR_ROUNDS = 2

// ── R1 — Characterize ────────────────────────────────────────────────────────

export interface R1Output {
  /** One-paragraph description of what behavior is being characterized. */
  characterizationSummary: string
  /** Full command to run the characterization file, e.g. `npx vitest run tests/refactor-char-xxx.test.ts`. */
  characterizationCommand: string
  /** Path to the characterization test file (new or existing). */
  characterizationArtifact: string
  /** True when existing tests already cover the target behavior (no new file needed). */
  coversExisting: boolean
  /** True once the gate confirms the characterization runs green consistently. Set by controller, not steer. */
  characterizationGreen?: boolean
}

/**
 * Validate R1Output. Rejects:
 *   - Missing or empty required string fields.
 *   - characterizationCommand whose first token is not in ALLOWED_BINARIES.
 *   - Shell metacharacters in characterizationCommand.
 *   - characterizationArtifact that doesn't look like a file path.
 */
export function validateR1Output(raw: unknown): raw is R1Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['characterizationSummary'] !== 'string' || !o['characterizationSummary'].trim()) return false
  if (typeof o['characterizationCommand'] !== 'string' || !o['characterizationCommand'].trim()) return false
  if (typeof o['characterizationArtifact'] !== 'string' || !o['characterizationArtifact'].trim()) return false
  if (typeof o['coversExisting'] !== 'boolean') return false

  // characterizationCommand first token must be an allowed binary
  const firstToken = (o['characterizationCommand'] as string).trim().split(/\s+/)[0] ?? ''
  if (!ALLOWED_BINARIES.has(firstToken)) return false

  // characterizationCommand must not contain shell metacharacters
  if (/[;&|`$><]|\$\(/.test(o['characterizationCommand'] as string)) return false

  // characterizationArtifact must look like a file path (contains path separator or has an extension)
  const artifact = (o['characterizationArtifact'] as string).trim()
  if (!artifact.includes('/') && !artifact.includes('\\') && !/\.[a-z]+$/i.test(artifact)) {
    return false
  }

  return true
}

// ── R2 — Transform ───────────────────────────────────────────────────────────

export interface R2Output {
  /** One-paragraph description of the refactor applied. */
  transformSummary: string
  /** List of files changed by the refactor (NOT the characterization file). */
  filesChanged: string[]
}

export function validateR2Output(raw: unknown): raw is R2Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['transformSummary'] !== 'string' || !o['transformSummary'].trim()) return false
  if (!Array.isArray(o['filesChanged'])) return false

  for (const f of o['filesChanged'] as unknown[]) {
    if (typeof f !== 'string') return false
  }

  return true
}

// ── R3 — Verify ──────────────────────────────────────────────────────────────

export interface R3Output {
  /** True when the characterization still runs green (behavior preserved). */
  characterizationStillGreen: boolean
  /** True when the full test suite passes. */
  suiteGreen: boolean
  /** How many R2/R3 loop rounds were needed (1-indexed). */
  rounds: number
}

export function validateR3Output(raw: unknown): raw is R3Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['characterizationStillGreen'] !== 'boolean') return false
  if (typeof o['suiteGreen'] !== 'boolean') return false
  if (typeof o['rounds'] !== 'number' || o['rounds'] < 1) return false

  return true
}

// ── R4 — Ship ────────────────────────────────────────────────────────────────

export interface R4Output {
  /** Git SHA of the refactor commit (transform files + characterization artifact). */
  commitSha: string
  /** Push result string (e.g. "pushed to origin/main"). */
  pushResult: string
}

export function validateR4Output(raw: unknown): raw is R4Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>

  if (typeof o['commitSha'] !== 'string' || !o['commitSha'].trim()) return false
  if (typeof o['pushResult'] !== 'string' || !o['pushResult'].trim()) return false

  return true
}
