// M6a: LLM judge — clean-context, satisfies Judge port interface
import type { Judge } from '../ports.js'

export type IsDoneCall = (goal: string, evidence: string) => Promise<boolean>
export type IsStillRightCall = (
  spec: string,
  currentDiff: string
) => Promise<{ aligned: boolean; reason?: string }>

export class LLMJudge implements Judge {
  constructor(
    private readonly isDoneCall?: IsDoneCall,
    private readonly isStillRightCall?: IsStillRightCall
  ) {}

  async isDone(goal: string, evidence: string): Promise<boolean> {
    if (!this.isDoneCall) return false
    return this.isDoneCall(goal, evidence)
  }

  async isStillRight(
    spec: string,
    currentDiff: string
  ): Promise<{ aligned: boolean; reason?: string }> {
    if (!this.isStillRightCall) return { aligned: true }
    return this.isStillRightCall(spec, currentDiff)
  }
}
