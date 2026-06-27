// C-1 D5: Ship step — commits fix + repro via gitOps.scopedCommit, scans secrets, pushes.
// TierDGate is SKIPPED for debug v1 (a bugfix auto-commits; documented in plan).

import type { GitOps } from '../ports.js'
import type { D1Output } from './debug-output.js'
import type { D2Output } from './debug-output.js'
import type { D3Output } from './debug-output.js'
import type { D5Output } from './debug-output.js'

export interface D5Result {
  ok: boolean
  output?: D5Output
  reason?: string
}

/**
 * D5 ship: commit fix files + repro artifact, scan secrets, push.
 *
 * allowedPaths = [...d3.filesChanged, d1.reproArtifact]
 * Commit message derived from d2.rootCause + d3.fixSummary.
 *
 * TierDGate: SKIPPED for debug v1. A bugfix auto-commits without operator approval
 * (silent-execution contract; consistent with quick/middle gear which also skip tierDGate).
 * Document: if a future version requires approval for risky fixes, add tierDGate here.
 */
export async function runD5Ship(
  d1: D1Output,
  d2: D2Output,
  d3: D3Output,
  repoRoot: string,
  gitOps: GitOps
): Promise<D5Result> {
  // Build the commit message from root cause + fix summary
  const message = [
    `fix: ${d2.rootCause.slice(0, 72)}`,
    '',
    d3.fixSummary.slice(0, 200),
    '',
    `Root cause: ${d2.rootCauseLocation}`,
    `Repro: ${d1.reproArtifact}`,
  ].join('\n')

  // Paths to commit: fix files + the repro test (both go in the same commit)
  const allowedPaths = [...d3.filesChanged, d1.reproArtifact]
    // Deduplicate (repro should not be in filesChanged, but guard anyway)
    .filter((p, i, arr) => arr.indexOf(p) === i)

  if (allowedPaths.length === 0) {
    return { ok: false, reason: 'D5: no files to commit (filesChanged is empty and reproArtifact not set)' }
  }

  // Secrets scan (staged=false: scan working tree before staging)
  const secretsScan = await gitOps.scanSecrets(false)
  if (!secretsScan.clean) {
    return {
      ok: false,
      reason: `D5: secrets scan failed — ${secretsScan.findings.slice(0, 3).join('; ')}`,
    }
  }

  // Commit via scopedCommit (PORT — stages only allowedPaths, never git add .)
  let commitResult: { sha: string }
  try {
    commitResult = await gitOps.scopedCommit(message, allowedPaths)
  } catch (err) {
    return { ok: false, reason: `D5: scopedCommit failed: ${String(err)}` }
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
