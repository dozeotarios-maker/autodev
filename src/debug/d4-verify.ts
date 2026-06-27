// C-1 D4: Verify step — confirms the fix works via BoundedExec (repro green 3x)
// + full suite via verifier.runDeterministic. This is a DETERMINISTIC gate, not a steer.
// The controller calls this directly; D4Output is constructed by the controller.

import type { BoundedExec } from '../ports.js'
import type { Verifier } from '../ports.js'
import type { D1Output } from './debug-output.js'

export interface D4GateResult {
  reproGreen: boolean
  suiteGreen: boolean
  /** Output from the last repro run (for diagnosis). */
  reproOutput: string
  /** Output from the suite run (for diagnosis). */
  suiteOutput: string
}

const REPRO_TIMEOUT_MS = 60_000

/**
 * D4 deterministic gate: run reproCommand 3× via BoundedExec, require consistent GREEN.
 * Then run the full suite via verifier.runDeterministic.
 *
 * Returns whether both passed. Does not throw — all errors manifest as failed gates.
 */
export async function runD4Gate(
  d1: D1Output,
  repoRoot: string,
  boundedExec: BoundedExec,
  verifier: Verifier
): Promise<D4GateResult> {
  const RUNS = 3
  let lastReproOutput = ''

  // Run reproCommand 3× — require all green
  for (let i = 0; i < RUNS; i++) {
    const result = await boundedExec.run(d1.reproCommand, repoRoot, { timeoutMs: REPRO_TIMEOUT_MS })
    lastReproOutput = result.output
    if (!result.passed || result.timedOut || result.blocked) {
      // Not consistently green
      return {
        reproGreen: false,
        suiteGreen: false,
        reproOutput: lastReproOutput,
        suiteOutput: '',
      }
    }
  }

  // Repro is consistently green — now run the full suite
  const suiteResult = await verifier.runDeterministic('npx vitest run', repoRoot)

  return {
    reproGreen: true,
    suiteGreen: suiteResult.passed,
    reproOutput: lastReproOutput,
    suiteOutput: suiteResult.output,
  }
}
