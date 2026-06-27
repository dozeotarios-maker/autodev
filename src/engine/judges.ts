// S2-M4: H2 done-judge + H9 still-right judge.
// All backed by the Judge port (SubagentJudge in production; stub in tests).

import type { Judge } from '../ports.js'

// H2: separate "done?" judge — cheap model, not self-judge.
export class DoneJudge {
  constructor(private judge: Judge) {}

  async check(goal: string, evidence: string): Promise<boolean> {
    return this.judge.isDone(goal, evidence)
  }
}

export interface StillRightResult {
  aligned: boolean
  reason?: string
  needsBackedge: boolean
}

// H9: still-right judge — re-anchors trajectory to frozen spec; signals P4→P3 backedge.
export class StillRightJudge {
  constructor(private judge: Judge) {}

  async check(spec: string, currentDiff: string): Promise<StillRightResult> {
    const { aligned, reason } = await this.judge.isStillRight(spec, currentDiff)
    return {
      aligned,
      reason,
      needsBackedge: !aligned,
    }
  }
}

