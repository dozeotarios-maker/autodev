// H4: operator controls without restart.
// STEER.md: surfaced once to agent then deleted (mid-run redirect).
// AGENT_STOP kill-file: halts all tool calls when present.

import * as fs from 'fs/promises'
import * as path from 'path'

export interface SteerResult {
  halted: boolean
  steerContent?: string
}

export class SteerController {
  private steerPath: string
  private stopPath: string

  constructor(cwd: string) {
    this.steerPath = path.join(cwd, '.autodev', 'STEER.md')
    this.stopPath = path.join(cwd, '.autodev', 'AGENT_STOP')
  }

  async checkStop(): Promise<boolean> {
    try {
      await fs.access(this.stopPath)
      return true
    } catch {
      return false
    }
  }

  async consumeSteer(): Promise<string | undefined> {
    try {
      const content = await fs.readFile(this.steerPath, 'utf-8')
      await fs.unlink(this.steerPath)
      return content
    } catch {
      return undefined
    }
  }

  async check(): Promise<SteerResult> {
    if (await this.checkStop()) return { halted: true }
    const steerContent = await this.consumeSteer()
    return { halted: false, steerContent }
  }
}
