import * as fs from 'fs/promises'
import * as path from 'path'

export type LifecycleState = 'ARMED' | 'RUNNING'

export interface LifecycleOptions {
  cwd: string
  onArmed?: () => void | Promise<void>
  onRunning?: () => void | Promise<void>
}

export class Lifecycle {
  private state: LifecycleState = 'ARMED'
  private lockPath: string

  constructor(private opts: LifecycleOptions) {
    this.lockPath = path.join(opts.cwd, '.autodev', 'running.lock')
  }

  getState(): LifecycleState {
    return this.state
  }

  async arm(): Promise<void> {
    this.state = 'ARMED'
    await this.opts.onArmed?.()
  }

  async run(idea: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.state === 'RUNNING') {
      return { ok: false, reason: 'Already RUNNING in this instance' }
    }

    if (await this.isLocked()) {
      return { ok: false, reason: 'Another session is already running in this repo' }
    }

    await this.acquireLock(idea)
    this.state = 'RUNNING'
    await this.opts.onRunning?.()
    return { ok: true }
  }

  async release(): Promise<void> {
    this.state = 'ARMED'
    await this.releaseLock()
  }

  private async isLocked(): Promise<boolean> {
    try {
      await fs.access(this.lockPath)
      return true
    } catch {
      return false
    }
  }

  private async acquireLock(idea: string): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true })
    await fs.writeFile(
      this.lockPath,
      JSON.stringify({ pid: process.pid, idea: idea.slice(0, 200), startedAt: new Date().toISOString() })
    )
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockPath)
    } catch {
      // already gone — acceptable
    }
  }
}
