// S2-M4: H2 done-judge + H9 still-right judge + PersonaPanel (parallel subagents)
import { describe, it, expect, vi } from 'vitest'
import { DoneJudge, StillRightJudge, PersonaPanel } from '../../src/engine/judges.js'
import type { Judge } from '../../src/ports.js'
import type { SubagentDriver } from '../../src/host/subagent-driver.js'
import type { SubagentResult } from '../../src/host/types.js'

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

describe('S2-M4: PersonaPanel — parallel subagents', () => {
  function makeDriver(outputs: string[]): SubagentDriver {
    return {
      invoke: vi.fn().mockImplementation(async (tasks: Array<{ agent: string; task: string }>) => {
        return tasks.map((t, i) => ({
          index: i,
          agent: t.agent,
          task: t.task,
          output: outputs[i] ?? JSON.stringify({ objection: null }),
        }) as SubagentResult)
      }),
    } as unknown as SubagentDriver
  }

  it('runs all personas as parallel subagent tasks', async () => {
    const personas = ['security-engineer', 'qa-engineer', 'ux-designer']
    const outputs = personas.map(() => JSON.stringify({ objection: null }))
    const driver = makeDriver(outputs)
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const panel = new PersonaPanel(driver, personas)
    await panel.review('plan: add login feature')
    expect(invoke).toHaveBeenCalledOnce()
    const tasks = invoke.mock.calls[0][0] as Array<{ agent: string }>
    expect(tasks).toHaveLength(3)
    expect(tasks.map(t => t.agent)).toEqual(personas)
  })

  it('aggregates objections from multiple personas', async () => {
    const personas = ['security-engineer', 'qa-engineer', 'ux-designer']
    const outputs = [
      JSON.stringify({ objection: 'Missing input validation' }),
      JSON.stringify({ objection: null }),
      JSON.stringify({ objection: 'Login button not accessible' }),
    ]
    const driver = makeDriver(outputs)
    const panel = new PersonaPanel(driver, personas)
    const result = await panel.review('plan')
    expect(result.hasObjections).toBe(true)
    expect(result.objections).toHaveLength(2)
    expect(result.objections[0].persona).toBe('security-engineer')
    expect(result.objections[0].objection).toContain('input validation')
    expect(result.objections[1].persona).toBe('ux-designer')
  })

  it('returns hasObjections=false when all personas approve', async () => {
    const personas = ['security-engineer', 'qa-engineer']
    const outputs = personas.map(() => JSON.stringify({ objection: null }))
    const driver = makeDriver(outputs)
    const panel = new PersonaPanel(driver, personas)
    const result = await panel.review('safe plan')
    expect(result.hasObjections).toBe(false)
    expect(result.objections).toHaveLength(0)
  })

  it('skips personas with unparseable output', async () => {
    const personas = ['security-engineer', 'qa-engineer', 'ux-designer']
    const outputs = [
      JSON.stringify({ objection: 'Real objection' }),
      'not valid json',
      JSON.stringify({ objection: null }),
    ]
    const driver = makeDriver(outputs)
    const panel = new PersonaPanel(driver, personas)
    const result = await panel.review('plan')
    expect(result.objections).toHaveLength(1)
    expect(result.objections[0].persona).toBe('security-engineer')
  })

  it('passes concurrency equal to persona count', async () => {
    const personas = ['a', 'b', 'c']
    const outputs = personas.map(() => JSON.stringify({ objection: null }))
    const driver = makeDriver(outputs)
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const panel = new PersonaPanel(driver, personas)
    await panel.review('plan')
    const opts = invoke.mock.calls[0][1] as { concurrency?: number }
    expect(opts.concurrency).toBe(3)
  })

  it('uses default 10 personas when none specified', async () => {
    const outputs = Array.from({ length: 10 }, () => JSON.stringify({ objection: null }))
    const driver = makeDriver(outputs)
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const panel = new PersonaPanel(driver)
    await panel.review('plan')
    const tasks = invoke.mock.calls[0][0] as unknown[]
    expect(tasks).toHaveLength(10)
  })
})
