import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * EffectLedger — G20 external-effect idempotency ledger.
 *
 * Guarantees that a named effect (migration, push, schema change, etc.) fires
 * AT MOST ONCE, even if the process crashes and replays.  The ledger is
 * persisted to disk so a brand-new process instance can read prior records.
 *
 * Concurrency safety (two-layer):
 *   1. In-process: per-effectId mutex (Map of in-flight Promises) prevents
 *      two concurrent once() calls in the same process from both running.
 *   2. Cross-process: exclusive lock file (effect-ledger.lock) via `fs.open`
 *      with the 'wx' flag; only one process can hold the lock at a time.
 *
 * Usage:
 *   const ledger = new EffectLedger('/path/to/workdir')
 *   const result = await ledger.once('migration-v3', () => runMigration())
 *   // On replay: effect is skipped, memoised result is returned immediately.
 */

interface LedgerEntry {
  completedAt: string
  result: string // JSON-serialised return value
}

interface LedgerFile {
  [effectId: string]: LedgerEntry
}

export class EffectLedger {
  private readonly ledgerPath: string
  private readonly lockPath: string
  // In-process mutex: effectId → promise of the in-flight once() call
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly dir: string) {
    this.ledgerPath = path.join(dir, 'effect-ledger.json')
    this.lockPath = path.join(dir, 'effect-ledger.lock')
  }

  private async load(): Promise<LedgerFile> {
    try {
      const raw = await fs.readFile(this.ledgerPath, 'utf-8')
      return JSON.parse(raw) as LedgerFile
    } catch {
      return {}
    }
  }

  private async save(ledger: LedgerFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    // mode 0o600: ledger gates irreversible effects; restrict to owner only
    await fs.writeFile(this.ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 })
  }

  /**
   * Acquire an exclusive cross-process lock file.
   * Retries with exponential back-off if the lock is held by another process.
   * Returns a release function.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(this.dir, { recursive: true })
    const maxWaitMs = 5000
    const startMs = Date.now()
    let delayMs = 20

    while (true) {
      try {
        // 'wx' = O_CREAT | O_EXCL — fails with EEXIST if lock already held
        const fh = await fs.open(this.lockPath, 'wx')
        await fh.close()
        return async () => {
          try { await fs.unlink(this.lockPath) } catch { /* already gone */ }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        if (Date.now() - startMs > maxWaitMs) {
          throw new Error(`EffectLedger: timed out waiting for lock after ${maxWaitMs}ms`)
        }
        await new Promise(r => setTimeout(r, delayMs))
        delayMs = Math.min(delayMs * 2, 500)
      }
    }
  }

  /**
   * Run `effect` exactly once.  If this effectId is already in the ledger,
   * the effect is NOT called and the previously memoised result is returned.
   *
   * G20 contract:
   *   - crash AFTER effect but BEFORE record → replay will re-run (acceptable:
   *     the ledger write is the durability boundary, not the effect itself).
   *   - crash AFTER record → replay skips the effect (no double-fire).
   *   - two concurrent once(id, fn) in the same process → fn runs EXACTLY once.
   *   - two concurrent once(id, fn) across processes → fn runs EXACTLY once.
   */
  async once<T>(effectId: string, effect: () => Promise<T>): Promise<T> {
    // Layer 1: in-process deduplication — attach to in-flight promise if present
    const existing = this.inflight.get(effectId)
    if (existing) {
      return existing as Promise<T>
    }

    const promise = this._runOnce<T>(effectId, effect)
    this.inflight.set(effectId, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(effectId)
    }
  }

  private async _runOnce<T>(effectId: string, effect: () => Promise<T>): Promise<T> {
    // Layer 2: cross-process lock around load-check-run-save
    const release = await this.acquireLock()
    try {
      const ledger = await this.load()

      if (ledger[effectId]) {
        // Already completed — return memoised result without re-running
        return JSON.parse(ledger[effectId].result) as T
      }

      // Run the effect while holding the lock
      const result = await effect()

      // Record completion AFTER the effect succeeds
      ledger[effectId] = {
        completedAt: new Date().toISOString(),
        result: JSON.stringify(result),
      }
      await this.save(ledger)

      return result
    } finally {
      await release()
    }
  }

  /**
   * Returns true if the given effectId has been recorded in the ledger.
   */
  async isRecorded(effectId: string): Promise<boolean> {
    const ledger = await this.load()
    return Object.prototype.hasOwnProperty.call(ledger, effectId)
  }
}
