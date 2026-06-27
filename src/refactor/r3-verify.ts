// Stage D R3: Verify step — confirms behavior is preserved via characterization (green 3×)
// + full suite via verifier.runDeterministic. This is a DETERMINISTIC gate, not a steer.
// KEY DIFFERENCE FROM DEBUG: if characterization goes RED → behavior CHANGED → HARD STOP.
// Only a suite-regression-with-characterization-green is a retry signal.

import type { BoundedExec } from '../ports.js'
import type { Verifier } from '../ports.js'
import type { R1Output } from './refactor-output.js'
import { isHarnessError } from '../debug/harness-error.js'
import { resolveTestCommand } from '../verify/test-command.js'

export interface R3GateResult {
  characterizationGreen: boolean
  suiteGreen: boolean
  /** Output from the last characterization run (for diagnosis). */
  characterizationOutput: string
  /** Output from the suite run (for diagnosis). */
  suiteOutput: string
  /**
   * True when a harness-level error (import failure, no test suite found, etc.)
   * prevented the characterization from running at all.
   */
  harnessError?: boolean
  /**
   * True when the characterization went RED (behavior changed).
   * This is a hard-stop signal — do NOT retry on this condition.
   */
  behaviorChanged?: boolean
}

const CHAR_TIMEOUT_MS = 60_000

/**
 * R3 deterministic gate: run characterizationCommand 3× via BoundedExec, require consistent GREEN.
 * Then run the full suite via verifier.runDeterministic.
 *
 * If characterization goes RED → behaviorChanged=true (caller MUST hard-escalate, not retry).
 * If only suite fails (characterization green) → suiteGreen=false (caller may retry R2, capped).
 *
 * Returns gate result. Does not throw — all errors manifest as failed gates.
 */
export async function runR3Gate(
  r1: R1Output,
  repoRoot: string,
  boundedExec: BoundedExec,
  verifier: Verifier
): Promise<R3GateResult> {
  const RUNS = 3
  let lastCharOutput = ''

  // Run characterizationCommand 3× — require all green (behavior preserved)
  for (let i = 0; i < RUNS; i++) {
    const result = await boundedExec.run(r1.characterizationCommand, repoRoot, { timeoutMs: CHAR_TIMEOUT_MS })
    lastCharOutput = result.output

    if (result.timedOut || result.blocked) {
      return {
        characterizationGreen: false,
        suiteGreen: false,
        characterizationOutput: lastCharOutput,
        suiteOutput: '',
      }
    }

    // Distinguish harness-level failure from real assertion failure.
    if (!result.passed && isHarnessError(result.output)) {
      return {
        characterizationGreen: false,
        suiteGreen: false,
        characterizationOutput: lastCharOutput,
        suiteOutput: '',
        harnessError: true,
      }
    }

    if (!result.passed) {
      // Characterization is RED — behavior changed. Hard stop, do not retry.
      return {
        characterizationGreen: false,
        suiteGreen: false,
        characterizationOutput: lastCharOutput,
        suiteOutput: '',
        behaviorChanged: true,
      }
    }
  }

  // Characterization consistently green — now run the full suite
  const suiteResult = await verifier.runDeterministic(await resolveTestCommand(repoRoot), repoRoot)

  return {
    characterizationGreen: true,
    suiteGreen: suiteResult.passed,
    characterizationOutput: lastCharOutput,
    suiteOutput: suiteResult.output,
  }
}
