// M4: G7 single integrator — reconciles lane outputs, enforces G18 broker-before-merge.

import { ContractRegistry } from './contract-registry.js'

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

  async reconcile(lanes: LaneOutput[]): Promise<ReconcileResult> {
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
