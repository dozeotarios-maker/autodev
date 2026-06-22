// S2-M5 / M4: G7 single integrator — reconciles lane outputs, enforces G18 broker-before-merge.
// Added: fromSubagentResults() converts SubagentRunner output → LaneOutput[] for reconciliation.

import { ContractRegistry } from './contract-registry.js'
import type { LaneRunResult } from './subagent-runner.js'
// LaneRunResult is the output of LaneSubagentRunner.run() — imported for fromSubagentResults()

export interface SharedBoundaryChange {
  symbol: string
  type: string
}

export interface LaneOutput {
  laneId: string
  files: string[]
  output: string
  sharedBoundaryChanges: SharedBoundaryChange[]
}

export interface ReconcileResult {
  ok: boolean
  reason?: string
  merged: LaneOutput[]
}

export class Integrator {
  constructor(private registry: ContractRegistry) {}

  /**
   * Convert SubagentRunner lane results into LaneOutput[] for reconciliation.
   *
   * S2-M5: the SubagentRunner returns raw output strings per lane. The integrator
   * adapts these to the LaneOutput contract. Shared boundary changes are initially
   * empty — lanes must call registry.publish() before reconcile() for any G18
   * protected symbol they mutate. A failed lane is surfaced via ok:false.
   */
  fromSubagentResults(results: LaneRunResult[]): LaneOutput[] {
    return results.map((r) => ({
      laneId: r.laneId,
      files: r.files,
      output: r.output,
      // Shared boundary changes are declared by lanes via registry.publish() calls;
      // the runner output itself does not encode them — they are extracted at build
      // time from the phase contract. Start empty; callers augment if needed.
      sharedBoundaryChanges: [],
    }))
  }

  /**
   * Reconcile lane results, enforcing G18 broker-before-merge.
   *
   * Also blocks on any failed lane from SubagentRunner (failed:true).
   */
  async reconcile(lanes: LaneOutput[], rawResults?: LaneRunResult[]): Promise<ReconcileResult> {
    // Block if any subagent lane failed outright (S2-M5 clean-tree / execution failure).
    if (rawResults) {
      const failed = rawResults.filter((r) => r.failed)
      if (failed.length > 0) {
        const ids = failed.map((r) => r.laneId).join(', ')
        return {
          ok: false,
          reason: `Lane(s) failed during subagent execution: ${ids}`,
          merged: [],
        }
      }
    }

    // G18: any lane with shared boundary changes must have those changes brokered.
    for (const lane of lanes) {
      for (const change of lane.sharedBoundaryChanges) {
        if (!this.registry.isBrokered(change.symbol)) {
          return {
            ok: false,
            reason: `G18: lane "${lane.laneId}" mutated shared boundary symbol "${change.symbol}" without publishing to the registry — broker before merge`,
            merged: [],
          }
        }
      }
    }

    return { ok: true, merged: lanes }
  }
}
