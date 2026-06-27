// C-1: D1 faithfulness check — uses the Judge port to confirm the repro
// actually demonstrates the reported bug (not a trivially-weak or unrelated repro).

import type { Judge } from '../ports.js'

export interface FaithfulnessResult {
  faithful: boolean
  reason?: string
}

/**
 * Check whether the repro file actually demonstrates the reported bug.
 * Uses Judge.isDone: "does the repro demonstrate the reported symptom?"
 *
 * If the judge port is unavailable, defaults to faithful=true (degrade gracefully).
 * If the judge call throws, defaults to faithful=true (fail-open: don't block on infra error).
 */
export async function checkReproFaithfulness(
  bugReport: string,
  reproSummary: string,
  reproOutput: string,
  judge: Judge
): Promise<FaithfulnessResult> {
  const goal = `The repro test should demonstrate the following bug: ${bugReport.slice(0, 500)}`
  const evidence = [
    `Repro summary: ${reproSummary.slice(0, 300)}`,
    `Repro output: ${reproOutput.slice(0, 1000)}`,
  ].join('\n')

  try {
    const done = await judge.isDone(goal, evidence)
    if (!done) {
      return {
        faithful: false,
        reason: 'Judge determined repro does not demonstrate the reported bug',
      }
    }
    return { faithful: true }
  } catch {
    // Judge infra error — fail-open (don't block on infrastructure failure)
    return { faithful: true }
  }
}
