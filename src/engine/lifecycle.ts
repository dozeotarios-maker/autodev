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

    // Set state synchronously before async I/O so callers see RUNNING immediately
    // (prevents a second concurrent input from also entering run()).
    this.state = 'RUNNING'

    const acquired = await this.acquireLockAtomic(idea)
    if (!acquired) {
      // Rollback — another process holds the lock
      this.state = 'ARMED'
      return { ok: false, reason: 'Another session is already running in this repo' }
    }

    await this.opts.onRunning?.()
    return { ok: true }
  }

  async release(): Promise<void> {
    this.state = 'ARMED'
    await this.releaseLock()
  }

  /**
   * Atomically acquire the run-lock using O_EXCL (exclusive create).
   * Returns true if the lock was acquired, false if already locked (EEXIST).
   * Replaces the TOCTOU-prone fs.access + fs.writeFile pattern.
   */
  private async acquireLockAtomic(idea: string): Promise<boolean> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true })
    let fh: fs.FileHandle | undefined
    try {
      fh = await fs.open(this.lockPath, 'wx')
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, idea: idea.slice(0, 200), startedAt: new Date().toISOString() })
      )
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false
      }
      throw err
    } finally {
      await fh?.close()
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
