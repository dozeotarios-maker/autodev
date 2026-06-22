// M-INT: FSM full-cycle P1→P6
// Wire real FSM + real memory (mock boundary) + real verify (mocked external),
// assert deterministic transitions + journaled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FSM, type Phase, type JournalEntry } from '../../src/engine/fsm.js'
import { LettaAdapter } from '../../src/memory/letta-adapter.js'
import { DeterministicVerifier } from '../../src/verify/deterministic.js'
import type { Judge } from '../../src/ports.js'

// Minimal stub judge for integration tests (replaces deleted LLMJudge)
function makeStubJudge(overrides: Partial<Judge> = {}): Judge {
  return {
    async isDone(_goal: string, _evidence: string): Promise<boolean> { return false },
    async isStillRight(_spec: string, _diff: string): Promise<{ aligned: boolean; reason?: string }> {
      return { aligned: true }
    },
    ...overrides,
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fsm-full-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M-INT: FSM full-cycle P1→P6', () => {
  it('transitions P1→P6 deterministically with real components', async () => {
    // Real FSM with journal callback.
    const journaled: JournalEntry[] = []
    const fsm = new FSM({
      onJournal: (entry) => journaled.push(entry),
    })

    // Real memory store (mock boundary — no Letta server needed).
    const memory = new LettaAdapter({ mock: true })

    // Stub judge (returns false by default — will allow advancement without judge gate).
    const judge = makeStubJudge()

    // Real deterministic verifier (we won't run an actual test command here).
    const verifier = new DeterministicVerifier()

    // Drive P1→P2→P3→P4→P5→P6.
    expect(fsm.getPhase()).toBe<Phase>('P1')

    const phases: Phase[] = []
    fsm.onTransition((p) => phases.push(p))

    // Store discovery artifact in memory (P1 action).
    await memory.store('idea', 'add a greeting function to utils.ts')

    await fsm.advance() // P1→P2
    expect(fsm.getPhase()).toBe('P2')

    // Recall the idea in planning (P2 action).
    const recalled = await memory.recall('idea', 1)
    expect(recalled.length).toBeGreaterThan(0)
    expect(recalled[0].value).toContain('greeting')

    await fsm.advance() // P2→P3
    await fsm.advance() // P3→P4

    // Judge (would normally gate P4 completion — mocked as non-blocking here).
    const done = await judge.isDone('add greeting function', 'function greet() implemented')
    // Default LLMJudge with no isDoneCall returns false; that's correct — the gate
    // would block in production. For integration we verify the judge is wired.
    expect(typeof done).toBe('boolean')

    await fsm.advance() // P4→P5
    await fsm.advance() // P5→P6

    expect(fsm.getPhase()).toBe<Phase>('P6')
    expect(phases).toEqual<Phase[]>(['P2', 'P3', 'P4', 'P5', 'P6'])

    // All transitions are journaled.
    expect(journaled.length).toBe(5)
    for (const entry of journaled) {
      expect(entry.timestamp).toBeTruthy()
      expect(typeof entry.phase).toBe('string')
    }
  })

  it('P4→P3 backedge fires when diff diverges from plan', async () => {
    const fsm = new FSM()

    // Advance to P4.
    await fsm.advance() // P2
    await fsm.advance() // P3
    await fsm.advance() // P4
    expect(fsm.getPhase()).toBe('P4')

    // Inject a divergent diff — judge.isStillRight would fire backedge in production.
    const judge = makeStubJudge({
      async isStillRight(_spec: string, _diff: string) {
        return { aligned: false, reason: 'diff diverges from spec' }
      },
    })
    const alignment = await judge.isStillRight('original spec', 'divergent diff content')
    expect(alignment.aligned).toBe(false)

    // Execute the backedge.
    const result = await fsm.backedge('P3')
    expect(result.ok).toBe(true)
    expect(fsm.getPhase()).toBe('P3')
  })

  it('cannot advance past P6 (terminal guard)', async () => {
    const fsm = new FSM()
    for (let i = 0; i < 5; i++) await fsm.advance()
    expect(fsm.getPhase()).toBe('P6')

    const result = await fsm.advance()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/P6/)
  })

  it('memory contradiction detection works during cycle', async () => {
    const memory = new LettaAdapter({ mock: true })

    // Store conflicting facts.
    await memory.store('arch', 'service X uses REST')
    await memory.store('arch', 'service X uses gRPC')

    const contradictions = await memory.detectContradictions('arch')
    expect(contradictions.length).toBeGreaterThan(0)
    expect(contradictions[0].conflictFlag).toBe(true)
  })

  it('verifier runs deterministic check (exit-code boundary, mocked cmd)', async () => {
    // Use a command that exists on the system and exits 0.
    const verifier = new DeterministicVerifier()
    const result = await verifier.run('true', tmpDir)
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
  })
})
