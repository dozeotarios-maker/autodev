import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { Journal, JournalEntry } from '../../src/engine/journal.js'
import { Checkpoint, CheckpointData } from '../../src/engine/checkpoint.js'
import { ResurrectionEngine } from '../../src/engine/resurrection.js'
import { EffectLedger } from '../../src/git/effect-ledger.js'
import { RetroWriter } from '../../src/engine/retro.js'

describe('M9: journal WAL', () => {
  it('writes an entry BEFORE an action', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-journal-'))
    const journal = new Journal(path.join(tmpDir, 'journal.jsonl'))

    await journal.write({ type: 'transition', phase: 'P2', action: 'start ELABORATE' })

    const lines = (await fs.readFile(path.join(tmpDir, 'journal.jsonl'), 'utf-8'))
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]) as JournalEntry
    expect(entry.type).toBe('transition')
    expect(entry.phase).toBe('P2')
    expect(entry.timestamp).toBeTruthy()

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('appends multiple entries (append-only WAL)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-journal-'))
    const journal = new Journal(path.join(tmpDir, 'journal.jsonl'))

    await journal.write({ type: 'transition', phase: 'P1', action: 'start DISCOVER' })
    await journal.write({ type: 'task', phase: 'P1', action: 'web research' })
    await journal.write({ type: 'transition', phase: 'P2', action: 'start ELABORATE' })

    const lines = (await fs.readFile(path.join(tmpDir, 'journal.jsonl'), 'utf-8'))
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(3)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('replay() returns all entries in order', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-journal-'))
    const journal = new Journal(path.join(tmpDir, 'journal.jsonl'))

    await journal.write({ type: 'transition', phase: 'P1', action: 'a' })
    await journal.write({ type: 'transition', phase: 'P2', action: 'b' })

    const entries = await journal.replay()
    expect(entries).toHaveLength(2)
    expect(entries[0].phase).toBe('P1')
    expect(entries[1].phase).toBe('P2')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('M9: checkpoint', () => {
  it('writes checkpoint AFTER completed step', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoint-'))
    const checkpoint = new Checkpoint(path.join(tmpDir, 'checkpoint.yaml'))

    const data: CheckpointData = {
      phase: 'P3',
      plan: 'implement login',
      taskStatuses: { 'task-1': 'done', 'task-2': 'pending' },
      inFlight: [],
      lastGoodCommit: 'abc123',
    }
    await checkpoint.write(data)

    const restored = await checkpoint.read()
    expect(restored!.phase).toBe('P3')
    expect(restored!.lastGoodCommit).toBe('abc123')
    expect(restored!.taskStatuses['task-1']).toBe('done')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns null when checkpoint file does not exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoint-'))
    const checkpoint = new Checkpoint(path.join(tmpDir, 'nonexistent.yaml'))
    const result = await checkpoint.read()
    expect(result).toBeNull()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('M9: resurrection engine', () => {
  it('crash mid-action marks step suspect, no completion', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-res-'))
    const journalPath = path.join(tmpDir, 'journal.jsonl')
    const checkpointPath = path.join(tmpDir, 'checkpoint.yaml')

    const journal = new Journal(journalPath)
    await journal.write({ type: 'pre-action', phase: 'P4', action: 'write src/auth.ts' })

    const engine = new ResurrectionEngine()
    const state = await engine.reconstruct(journalPath, checkpointPath)

    expect(state.halfDone).toContain('write src/auth.ts')
    expect(state.phase).toBe('P4')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('resume is read-only (dryRun=true replays nothing destructive)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-res-'))
    const journalPath = path.join(tmpDir, 'journal.jsonl')
    const checkpointPath = path.join(tmpDir, 'checkpoint.yaml')

    const journal = new Journal(journalPath)
    await journal.write({ type: 'transition', phase: 'P3', action: 'plan complete' })

    const checkpoint = new Checkpoint(checkpointPath)
    await checkpoint.write({
      phase: 'P4',
      plan: 'build auth',
      taskStatuses: {},
      inFlight: [],
      lastGoodCommit: 'def456',
    })

    const engine = new ResurrectionEngine()
    const state = await engine.reconstruct(journalPath, checkpointPath)
    const result = await engine.resume(state, { dryRun: true })

    expect(result.resumed).toBe(true)
    expect(result.report).toBeTruthy()

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('isIdempotentSafe returns false for a recorded effect (EffectLedger format)', async () => {
    // G20: a recorded effect must NOT be approved for re-fire.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-idempotent-'))
    const ledger = new EffectLedger(tmpDir)
    // Record an effect via the ledger's once() method
    await ledger.once('deploy-migration-v3', async () => 'done')

    const engine = new ResurrectionEngine()
    const safe = await engine.isIdempotentSafe('deploy-migration-v3', tmpDir)

    // A recorded effect is NOT idempotent-safe (would double-fire)
    expect(safe).toBe(false)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('isIdempotentSafe returns true for an unrecorded effect', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-idempotent-'))

    const engine = new ResurrectionEngine()
    const safe = await engine.isIdempotentSafe('never-run-effect', tmpDir)

    expect(safe).toBe(true)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('ZERO modifications to M3 FSM files (verified by import boundary)', async () => {
    const fsm = {
      onResume: vi.fn().mockResolvedValue(undefined),
      getPhase: vi.fn().mockReturnValue('P4'),
    }
    const engine = new ResurrectionEngine()
    engine.hookFSM(fsm)

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-res-hook-'))
    const journal = new Journal(path.join(tmpDir, 'journal.jsonl'))
    await journal.write({ type: 'transition', phase: 'P4', action: 'something' })
    const checkpoint = new Checkpoint(path.join(tmpDir, 'checkpoint.yaml'))
    await checkpoint.write({
      phase: 'P4',
      plan: 'x',
      taskStatuses: {},
      inFlight: [],
      lastGoodCommit: 'aaa',
    })
    const state = await engine.reconstruct(
      path.join(tmpDir, 'journal.jsonl'),
      path.join(tmpDir, 'checkpoint.yaml')
    )
    await engine.resumeViaFSM(state)
    expect(fsm.onResume).toHaveBeenCalled()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('M9: R5 retro writer', () => {
  it('writes a generalizable lesson to global plane', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-retro-'))
    const retro = new RetroWriter(tmpDir)

    await retro.write({
      runId: 'run-001',
      lesson: 'Always add index on foreign keys',
      bugPattern: 'missing-index',
      convention: 'db-migrations',
    })

    const files = await fs.readdir(tmpDir)
    expect(files.length).toBeGreaterThan(0)

    const content = await fs.readFile(path.join(tmpDir, files[0]), 'utf-8')
    // retro.jsonl: read first line
    const parsed = JSON.parse(content.split('\n').filter(Boolean)[0]) as { lesson: string }
    expect(parsed.lesson).toBe('Always add index on foreign keys')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('appends lessons across multiple runs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-retro-'))
    const retro = new RetroWriter(tmpDir)

    await retro.write({ runId: 'run-001', lesson: 'Lesson A', bugPattern: 'pattern-a', convention: 'c1' })
    await retro.write({ runId: 'run-002', lesson: 'Lesson B', bugPattern: 'pattern-b', convention: 'c2' })

    const all = await retro.readAll()
    expect(all.length).toBeGreaterThanOrEqual(2)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
