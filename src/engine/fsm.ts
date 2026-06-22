// M3: 6-phase FSM (P1–P6) with deterministic transitions, journaling,
// P4→P3 backedge, pause support, and onResume/phase-reconstruction extension points.

export type Phase = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'

export interface JournalEntry {
  phase: Phase
  timestamp: string
  backedge?: boolean
}

export interface FSMCheckpoint {
  phase: Phase
  backedgeCount: number
}

export interface FSMOptions {
  onJournal?: (entry: JournalEntry) => void
  onPhaseReconstruct?: (checkpoint: FSMCheckpoint) => Promise<void>
  isPaused?: () => boolean
}

const PHASE_ORDER: Phase[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
const PHASE_INDEX = new Map(PHASE_ORDER.map((p, i) => [p, i]))

export interface TransitionResult {
  ok: boolean
  reason?: string
  phase?: Phase
}

export class FSM {
  private phase: Phase = 'P1'
  private backedgeCount = 0
  private transitionListeners: Array<(phase: Phase) => void> = []
  private opts: FSMOptions

  constructor(opts: FSMOptions = {}) {
    this.opts = opts
  }

  getPhase(): Phase {
    return this.phase
  }

  onTransition(cb: (phase: Phase) => void): void {
    this.transitionListeners.push(cb)
  }

  async advance(): Promise<TransitionResult> {
    if (this.opts.isPaused?.()) {
      return { ok: false, reason: 'FSM is paused — check pause file before advancing' }
    }

    const currentIdx = PHASE_INDEX.get(this.phase)!
    if (currentIdx >= PHASE_ORDER.length - 1) {
      return { ok: false, reason: `Already at P6 (terminal phase); cannot advance further` }
    }

    const next = PHASE_ORDER[currentIdx + 1]
    this.phase = next
    this.journal({ phase: next })
    this.transitionListeners.forEach((cb) => cb(next))
    return { ok: true, phase: next }
  }

  async backedge(target: Phase): Promise<TransitionResult> {
    // Only valid: P4→P3
    if (this.phase !== 'P4' || target !== 'P3') {
      return {
        ok: false,
        reason: `Backedge only valid P4→P3; current phase is ${this.phase}, target is ${target}`,
      }
    }
    this.backedgeCount++
    this.phase = 'P3'
    this.journal({ phase: 'P3', backedge: true })
    this.transitionListeners.forEach((cb) => cb('P3'))
    return { ok: true, phase: 'P3' }
  }

  // Extension point: called by M9 resurrection without modifying this file.
  async onResume(checkpoint: FSMCheckpoint): Promise<void> {
    this.phase = checkpoint.phase
    this.backedgeCount = checkpoint.backedgeCount
    await this.opts.onPhaseReconstruct?.(checkpoint)
  }

  private journal(entry: Omit<JournalEntry, 'timestamp'>): void {
    const full: JournalEntry = { ...entry, timestamp: new Date().toISOString() }
    this.opts.onJournal?.(full)
  }
}
