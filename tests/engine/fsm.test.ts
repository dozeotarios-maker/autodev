import { describe, it, expect, vi } from 'vitest'
import { FSM, Phase, FSMCheckpoint } from '../../src/engine/fsm.js'

describe('M3: 6-phase FSM', () => {
  it('starts in P1 (DISCOVER)', () => {
    const fsm = new FSM()
    expect(fsm.getPhase()).toBe<Phase>('P1')
  })

  it('transitions P1→P2→P3→P4→P5→P6 in order', async () => {
    const fsm = new FSM()
    const phases: Phase[] = []
    fsm.onTransition((p: Phase) => phases.push(p))

    await fsm.advance() // P1→P2
    await fsm.advance() // P2→P3
    await fsm.advance() // P3→P4
    await fsm.advance() // P4→P5
    await fsm.advance() // P5→P6
    expect(phases).toEqual<Phase[]>(['P2', 'P3', 'P4', 'P5', 'P6'])
  })

  it('cannot advance past P6', async () => {
    const fsm = new FSM()
    for (let i = 0; i < 5; i++) await fsm.advance()
    const result = await fsm.advance()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/P6/)
  })

  it('journals every transition', async () => {
    const journal: string[] = []
    const fsm = new FSM({ onJournal: (entry: { phase: Phase; timestamp: string }) => journal.push(entry.phase) })
    await fsm.advance()
    expect(journal).toContain('P2')
  })

  it('supports P4→P3 backedge', async () => {
    const fsm = new FSM()
    // advance to P4
    await fsm.advance()
    await fsm.advance()
    await fsm.advance()
    expect(fsm.getPhase()).toBe('P4')

    await fsm.backedge('P3')
    expect(fsm.getPhase()).toBe('P3')
  })

  it('backedge is only valid P4→P3', async () => {
    const fsm = new FSM()
    await fsm.advance() // P2
    const result = await fsm.backedge('P3')
    expect(result.ok).toBe(false)
  })

  it('onResume(checkpoint) restores phase', async () => {
    const fsm = new FSM()
    const checkpoint: FSMCheckpoint = { phase: 'P4', backedgeCount: 0 }
    await fsm.onResume(checkpoint)
    expect(fsm.getPhase()).toBe('P4')
  })

  it('exposes phase-reconstruction extension point', async () => {
    const reconstruct = vi.fn().mockResolvedValue(undefined)
    const fsm = new FSM({ onPhaseReconstruct: reconstruct })
    const checkpoint: FSMCheckpoint = { phase: 'P3', backedgeCount: 1 }
    await fsm.onResume(checkpoint)
    expect(reconstruct).toHaveBeenCalledWith(checkpoint)
  })

  it('pause file blocks advance when set', async () => {
    const fsm = new FSM({ isPaused: () => true })
    const result = await fsm.advance()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/pause/i)
  })
})
