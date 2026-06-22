// M6c: G24 clean-context security-lane reviewer — flags injected repo content
import type { SecurityLane, SecurityFinding } from '../ports.js'

export interface SecurityReviewResult {
  clean: boolean
  findings: SecurityFinding[]
}

export interface SecurityScreenResult {
  safe: boolean
  threats: string[]
}

export class SecurityLaneReviewer {
  constructor(private readonly lane: SecurityLane) {}

  async screenRepo(content: string): Promise<SecurityScreenResult> {
    // Each call is independent — no prior content bleeds into context
    return this.lane.screenContent(content, 'repo')
  }

  async reviewDiff(diff: string): Promise<SecurityReviewResult> {
    return this.lane.reviewDiff(diff)
  }
}
