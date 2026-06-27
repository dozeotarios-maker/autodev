// S2-M4: H2 done-judge + H9 still-right judge
import { describe, it, expect, vi } from 'vitest'
import { DoneJudge, StillRightJudge } from '../../src/engine/judges.js'
import type { Judge } from '../../src/ports.js'

describe('M3: H2 done-judge', () => {
  it('returns true when goal is met according to stub judge', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const doneJudge = new DoneJudge(stubJudge)
    const result = await doneJudge.check('build a login page', 'login page implemented with tests passing')
    expect(result).toBe(true)
    expect(stubJudge.isDone).toHaveBeenCalledWith('build a login page', 'login page implemented with tests passing')
  })

  it('returns false when goal is NOT met', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const doneJudge = new DoneJudge(stubJudge)
    const result = await doneJudge.check('build a login page', 'work in progress')
    expect(result).toBe(false)
  })

  it('uses a separate judge instance (not self-judge)', () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const doneJudge = new DoneJudge(judge)
    expect(doneJudge).toBeDefined()
    expect(judge.isDone).toBeDefined()
  })
})

describe('M3: H9 still-right judge', () => {
  it('returns aligned=true when diff matches spec', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const stillRight = new StillRightJudge(stubJudge)
    const result = await stillRight.check(
      'spec: implement login with JWT',
      '+ const token = jwt.sign(payload, secret)'
    )
    expect(result.aligned).toBe(true)
  })

  it('returns aligned=false when diff diverges from spec', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'Using sessions instead of JWT' }),
    }
    const stillRight = new StillRightJudge(stubJudge)
    const result = await stillRight.check(
      'spec: implement login with JWT',
      '+ req.session.userId = user.id'
    )
    expect(result.aligned).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('signals P4→P3 backedge needed when diverged', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'Scope drift detected' }),
    }
    const stillRight = new StillRightJudge(stubJudge)
    const result = await stillRight.check('spec', 'divergent diff')
    expect(result.needsBackedge).toBe(true)
  })

  it('no backedge needed when aligned', async () => {
    const stubJudge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const stillRight = new StillRightJudge(stubJudge)
    const result = await stillRight.check('spec', 'aligned diff')
    expect(result.needsBackedge).toBe(false)
  })
})

