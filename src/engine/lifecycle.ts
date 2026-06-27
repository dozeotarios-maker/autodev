import * as fs from 'fs/promises'
import * as path from 'path'

export type LifecycleState = 'ARMED' | 'RUNNING'

/** A run-lock older than this can't belong to a live run — reclaim it (stale-session guard). */
const MAX_LOCK_AGE_MS = 3 * 60 * 60 * 1000 // 3 hours

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
    // Try to create the lock; if it exists but is STALE (owner process dead, or
    // older than any real run), reclaim it once and retry. Without this, a single
    // pi session that closed/crashed mid-run leaves a lock that blocks EVERY future
    // run with "already RUNNING" — observed live: one run wedged autodev for hours.
    for (let attempt = 0; attempt < 2; attempt++) {
      let fh: fs.FileHandle | undefined
      try {
        fh = await fs.open(this.lockPath, 'wx')
        await fh.writeFile(
          JSON.stringify({ pid: process.pid, idea: idea.slice(0, 200), startedAt: new Date().toISOString() })
        )
        return true
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          if (attempt === 0 && (await this.isStaleLock())) {
            await this.releaseLock() // reclaim the dead lock, then retry once
            continue
          }
          return false // a genuinely live lock (another running session)
        }
        throw err
      } finally {
        await fh?.close()
      }
    }
    return false
  }

  /**
   * A lock is stale when its owning process is gone (the session crashed/closed
   * mid-run) or it is older than any plausible run. Reclaiming it prevents a single
   * dead session from blocking all future runs forever.
   */
  private async isStaleLock(): Promise<boolean> {
    let content: { pid?: unknown; startedAt?: unknown }
    try {
      content = JSON.parse(await fs.readFile(this.lockPath, 'utf-8'))
    } catch {
      return true // unreadable / corrupt lock — reclaim it
    }
    const startedAt = Date.parse(typeof content.startedAt === 'string' ? content.startedAt : '')
    if (!Number.isNaN(startedAt) && Date.now() - startedAt > MAX_LOCK_AGE_MS) return true
    const pid = content.pid
    if (typeof pid !== 'number') return true
    if (pid === process.pid) return true // our own leftover — reclaim
    try {
      process.kill(pid, 0) // signal 0 = existence check only, sends nothing
      return false // owner alive — a live lock
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH' // no such process — stale
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
