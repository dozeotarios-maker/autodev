// Stage D R4: Ship step — commits refactor files + characterization artifact via
// gitOps.scopedCommit, scans secrets, pushes.
// TierDGate is SKIPPED for refactor v1 (documented in plan).

import type { GitOps } from '../ports.js'
import type { R1Output } from './refactor-output.js'
import type { R2Output } from './refactor-output.js'
import type { R4Output } from './refactor-output.js'

export interface R4Result {
  ok: boolean
  output?: R4Output
  reason?: string
}

/**
 * R4 ship: commit refactor files + characterization artifact, scan secrets, push.
 *
 * allowedPaths = [...r2.filesChanged, r1.characterizationArtifact]
 * Commit message derived from r2.transformSummary.
 *
 * TierDGate: SKIPPED for refactor v1. A behavior-preserving refactor auto-commits
 * (silent-execution contract). Add tierDGate here if future versions require operator
 * approval before committing refactors.
 */
export async function runR4Ship(
  r1: R1Output,
  r2: R2Output,
  repoRoot: string,
  gitOps: GitOps
): Promise<R4Result> {
  // Build the commit message from transform summary
  const message = [
    `refactor: ${r2.transformSummary.slice(0, 72)}`,
    '',
    r2.transformSummary.slice(0, 200),
    '',
    `Characterization: ${r1.characterizationArtifact}`,
  ].join('\n')

  // Paths to commit: refactor files + characterization tests (both in one commit)
  const allowedPaths = [...r2.filesChanged, r1.characterizationArtifact]
    // Strip blank/whitespace-only entries
    .filter(p => p && p.trim())
    // Deduplicate (characterizationArtifact should not be in filesChanged, but guard anyway)
    .filter((p, i, arr) => arr.indexOf(p) === i)

  if (allowedPaths.length === 0) {
    return { ok: false, reason: 'R4: no files to commit (filesChanged is empty and characterizationArtifact not set)' }
  }

  // Secrets scan (staged=false: scan working tree before staging)
  const secretsScan = await gitOps.scanSecrets(false)
  if (!secretsScan.clean) {
    return {
      ok: false,
      reason: `R4: secrets scan failed — ${secretsScan.findings.slice(0, 3).join('; ')}`,
    }
  }

  // Commit via scopedCommit (PORT — stages only allowedPaths, never git add .)
  let commitResult: { sha: string }
  try {
    commitResult = await gitOps.scopedCommit(message, allowedPaths)
  } catch (err) {
    return { ok: false, reason: `R4: scopedCommit failed: ${String(err)}` }
  }

  // Per-phase push
  let pushResult: string
  try {
    await gitOps.perPhasePush('main')
    pushResult = 'pushed to origin/main'
  } catch (err) {
    // Push failure is not fatal for the commit itself — surface as partial success
    pushResult = `push failed: ${String(err)}`
  }

  void repoRoot // repoRoot used by gitOps impl internally (passed via scopedCommit cwd)

  return {
    ok: true,
    output: {
      commitSha: commitResult.sha,
      pushResult,
    },
  }
}
