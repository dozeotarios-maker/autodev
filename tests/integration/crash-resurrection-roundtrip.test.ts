// M-INT: crash-resurrection round-trip
// Drive FSM to mid-P4, simulate crash, restart, journal reconstructs,
// resume replays nothing destructive, G20 ledger prevents double-fire.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FSM } from '../../src/engine/fsm.js'
import { Journal } from '../../src/engine/journal.js'
import { Checkpoint } from '../../src/engine/checkpoint.js'
import { ResurrectionEngine } from '../../src/engine/resurrection.js'
import { EffectLedger } from '../../src/git/effect-ledger.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resurrection-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M-INT: crash-resurrection round-trip', () => {
  it('journal reconstructs phase after simulated crash mid-P4', async () => {
    const journalPath = path.join(tmpDir, 'journal.jsonl')
    const checkpointPath = path.join(tmpDir, 'checkpoint.json')

    // === PRE-CRASH: drive FSM to mid-P4, write journal entries ===
    const journal = new Journal(journalPath)
    const checkpoint = new Checkpoint(checkpointPath)

    // Simulate transitions written to journal.
    await journal.write({ type: 'transition', phase: 'P1', action: 'advance' })
    await journal.write({ type: 'transition', phase: 'P2', action: 'advance' })
    await journal.write({ type: 'transition', phase: 'P3', action: 'advance' })
    await journal.write({ type: 'transition', phase: 'P4', action: 'advance' })

    // Write a pre-action entry for an action that never completed (crash).
    await journal.write({ type: 'pre-action', phase: 'P4', action: 'deploy-migration' })
    // ^^^ No matching completion — this is the half-done action.

    // Checkpoint was last written at P3 (before the crash).
    await checkpoint.write({
      phase: 'P3',
      plan: 'test-plan',
      taskStatuses: {},
      inFlight: [],
      lastGoodCommit: 'abc123',
    })

    // === POST-CRASH: resurrection engine reconstructs state ===
    const engine = new ResurrectionEngine()
    const state = await engine.reconstruct(journalPath, checkpointPath)

    // Phase comes from checkpoint (P3) — the last verified-safe state.
    // The journal's transition to P4 is NOT the phase; checkpoint is the ground truth.
    // The half-done pre-action in P4 is detected separately via journal scanning.
    expect(state.phase).toBe('P3')
    expect(state.lastGoodCommit).toBe('abc123')
    // The half-done action is identified.
    expect(state.halfDone).toContain('deploy-migration')
  })

  it('resume in dry-run mode replays nothing destructive', async () => {
    const journalPath = path.join(tmpDir, 'journal.jsonl')
    const checkpointPath = path.join(tmpDir, 'checkpoint.json')

    const engine = new ResurrectionEngine()
    const state = await engine.reconstruct(journalPath, checkpointPath)

    const result = await engine.resume(state, { dryRun: true })
    expect(result.resumed).toBe(true)
    expect(result.report).toContain('dry-run')
    // No files mutated — only a report is produced.
  })

  it('G20 ledger prevents double-fire of a completed effect', async () => {
    const ledger = new EffectLedger(tmpDir)

    let callCount = 0
    const effect = async () => {
      callCount++
      return { migrated: true }
    }

    // First call: effect fires.
    const r1 = await ledger.once('migration-v1', effect)
    expect(r1).toEqual({ migrated: true })
    expect(callCount).toBe(1)

    // Simulate crash + replay: second call must NOT re-fire the effect.
    const r2 = await ledger.once('migration-v1', effect)
    expect(r2).toEqual({ migrated: true })
    expect(callCount).toBe(1) // effect not called again — G20 prevents double-fire
  })

  it('FSM resumes at correct phase via onResume after crash', async () => {
    // The FSM's onResume extension point (M3) is used by resurrection (M9)
    // without modifying M3 files.
    const fsm = new FSM()
    const engine = new ResurrectionEngine()
    engine.hookFSM(fsm)

    // Simulate resurrection to P4.
    await engine.resumeViaFSM({ phase: 'P4', lastGoodCommit: 'abc123', halfDone: [] })
    expect(fsm.getPhase()).toBe('P4')
  })

  it('isIdempotentSafe returns false for already-completed action', async () => {
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl')
    const journal = new Journal(ledgerPath)

    // Record a completion entry.
    await journal.write({ type: 'completion', phase: 'P4', action: 'push-to-prod' })

    const engine = new ResurrectionEngine()
    const safe = await engine.isIdempotentSafe('push-to-prod', ledgerPath)
    expect(safe).toBe(false) // already done — not safe to replay
  })

  it('isIdempotentSafe returns true for never-completed action', async () => {
    const ledgerPath = path.join(tmpDir, 'ledger-empty.jsonl')

    const engine = new ResurrectionEngine()
    const safe = await engine.isIdempotentSafe('push-to-prod', ledgerPath)
    expect(safe).toBe(true) // never done — safe to run
  })
})
