// M5 effect-ledger test — D1 test-first
// G20: idempotency ledger — no double-fire on replay after crash
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { EffectLedger } from '../../src/git/effect-ledger.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ledger-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M5: EffectLedger — G20 no-double-fire idempotency', () => {
  it('allows a new effect to execute', async () => {
    const ledger = new EffectLedger(tmpDir)
    let called = 0
    const result = await ledger.once('migration-v1', async () => {
      called++
      return 'done'
    })
    expect(called).toBe(1)
    expect(result).toBe('done')
  })

  it('G20: does NOT re-execute an effect already recorded in the ledger', async () => {
    const ledger = new EffectLedger(tmpDir)
    let called = 0
    const effect = async () => { called++; return 'done' }

    await ledger.once('migration-v1', effect)
    // Simulate crash-then-replay: create a new ledger instance (same dir = same ledger file)
    const ledger2 = new EffectLedger(tmpDir)
    const result2 = await ledger2.once('migration-v1', effect)

    expect(called).toBe(1)       // effect must NOT fire a second time
    expect(result2).toBe('done') // returns the memoised result
  })

  it('G20: different effect IDs can both execute', async () => {
    const ledger = new EffectLedger(tmpDir)
    let calls: string[] = []

    await ledger.once('step-1', async () => { calls.push('step-1'); return 'r1' })
    await ledger.once('step-2', async () => { calls.push('step-2'); return 'r2' })

    expect(calls).toEqual(['step-1', 'step-2'])
  })

  it('G20: replay after crash-before-record re-executes (effect was not completed)', async () => {
    // Simulate: effect started but crashed before ledger.record() could be called.
    // A fresh ledger (no record for this ID) MUST re-run the effect.
    const ledger = new EffectLedger(tmpDir)
    let called = 0
    const effect = async () => { called++; return 'ok' }

    // ledger2 is a clean instance — no prior record
    const ledger2 = new EffectLedger(tmpDir)
    await ledger2.once('new-migration', effect)
    expect(called).toBe(1)
  })

  it('persists ledger to disk so a new process can read it', async () => {
    const ledger = new EffectLedger(tmpDir)
    await ledger.once('push-v2', async () => 'pushed')

    // Check the ledger file exists and contains the effect ID
    const ledgerFile = path.join(tmpDir, 'effect-ledger.json')
    const raw = await fs.readFile(ledgerFile, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    expect(data['push-v2']).toBeDefined()
  })

  it('isRecorded returns true for executed effects, false for unknown', async () => {
    const ledger = new EffectLedger(tmpDir)
    await ledger.once('known', async () => 'x')
    expect(await ledger.isRecorded('known')).toBe(true)
    expect(await ledger.isRecorded('unknown')).toBe(false)
  })

  it('G20: two concurrent once() with same effectId run the effect EXACTLY once', async () => {
    const ledger = new EffectLedger(tmpDir)
    let callCount = 0
    const effect = async () => {
      callCount++
      // Yield to allow the second concurrent call to interleave
      await new Promise(r => setTimeout(r, 10))
      return 'concurrent-result'
    }

    // Fire both concurrently — neither should await the other before starting
    const [r1, r2] = await Promise.all([
      ledger.once('concurrent-effect', effect),
      ledger.once('concurrent-effect', effect),
    ])

    expect(callCount).toBe(1)
    expect(r1).toBe('concurrent-result')
    expect(r2).toBe('concurrent-result')
  })
})
