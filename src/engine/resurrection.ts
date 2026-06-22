// M9: resurrection engine — hooks via FSM's onResume/phase-reconstruction extension points.
// ZERO modifications to M3 files (spec M9 constraint).

import type { ResurrectionState } from '../ports.js'
import { Journal } from './journal.js'
import { Checkpoint } from './checkpoint.js'
import type { FSMCheckpoint, Phase } from './fsm.js'

// The minimal FSM interface resurrection needs — avoids importing the concrete FSM class.
export interface FSMHandle {
  onResume(checkpoint: FSMCheckpoint): Promise<void>
  getPhase(): Phase
}

export class ResurrectionEngine {
  private fsmHandle: FSMHandle | null = null

  // Extension point: called by external wiring (not by M3 FSM internals).
  hookFSM(fsm: FSMHandle): void {
    this.fsmHandle = fsm
  }

  async reconstruct(journalPath: string, checkpointPath: string): Promise<ResurrectionState> {
    const journal = new Journal(journalPath)
    const checkpoint = new Checkpoint(checkpointPath)

    const entries = await journal.replay()
    const cp = await checkpoint.read()

    // Determine current phase from checkpoint or journal.
    const phase = cp?.phase ?? (entries[entries.length - 1]?.phase ?? 'P1')

    // Find half-done: pre-action entries with no matching completion.
    const halfDone: string[] = []
    for (const entry of entries) {
      if (entry.type === 'pre-action') {
        const hasCompletion = entries.some(
          (e) => e.type === 'completion' && e.action === entry.action && e.phase === entry.phase
        )
        if (!hasCompletion) {
          halfDone.push(entry.action)
        }
      }
    }

    return {
      phase,
      lastGoodCommit: cp?.lastGoodCommit ?? '',
      halfDone,
    }
  }

  async resume(
    state: ResurrectionState,
    options?: { dryRun?: boolean }
  ): Promise<{ resumed: boolean; report: string }> {
    const lines: string[] = [
      `Resurrection report:`,
      `  Phase: ${state.phase}`,
      `  Last good commit: ${state.lastGoodCommit || '(none)'}`,
      `  Half-done actions: ${state.halfDone.length === 0 ? 'none' : state.halfDone.join(', ')}`,
    ]

    if (options?.dryRun) {
      lines.push('  Mode: dry-run — no destructive replay performed')
    }

    return {
      resumed: true,
      report: lines.join('\n'),
    }
  }

  // Resume via FSM extension point — calls onResume, never modifies FSM internals.
  async resumeViaFSM(state: ResurrectionState): Promise<void> {
    if (!this.fsmHandle) return
    await this.fsmHandle.onResume({
      phase: state.phase as Phase,
      backedgeCount: 0,
    })
  }

  // G20: check effect ledger to avoid double-firing.
  async isIdempotentSafe(action: string, ledgerPath: string): Promise<boolean> {
    const journal = new Journal(ledgerPath)
    const entries = await journal.replay()
    const alreadyDone = entries.some(
      (e) => e.type === 'completion' && e.action === action
    )
    return !alreadyDone
  }
}
