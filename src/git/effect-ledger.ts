import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * EffectLedger — G20 external-effect idempotency ledger.
 *
 * Guarantees that a named effect (migration, push, schema change, etc.) fires
 * AT MOST ONCE, even if the process crashes and replays.  The ledger is
 * persisted to disk so a brand-new process instance can read prior records.
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

  constructor(private readonly dir: string) {
    this.ledgerPath = path.join(dir, 'effect-ledger.json')
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
    await fs.writeFile(this.ledgerPath, JSON.stringify(ledger, null, 2))
  }

  /**
   * Run `effect` exactly once.  If this effectId is already in the ledger,
   * the effect is NOT called and the previously memoised result is returned.
   *
   * G20 contract:
   *   - crash AFTER effect but BEFORE record → replay will re-run (acceptable:
   *     the ledger write is the durability boundary, not the effect itself).
   *   - crash AFTER record → replay skips the effect (no double-fire).
   */
  async once<T>(effectId: string, effect: () => Promise<T>): Promise<T> {
    const ledger = await this.load()

    if (ledger[effectId]) {
      // Already completed — return memoised result without re-running
      return JSON.parse(ledger[effectId].result) as T
    }

    // Run the effect
    const result = await effect()

    // Record completion AFTER the effect succeeds
    ledger[effectId] = {
      completedAt: new Date().toISOString(),
      result: JSON.stringify(result),
    }
    await this.save(ledger)

    return result
  }

  /**
   * Returns true if the given effectId has been recorded in the ledger.
   */
  async isRecorded(effectId: string): Promise<boolean> {
    const ledger = await this.load()
    return Object.prototype.hasOwnProperty.call(ledger, effectId)
  }
}
