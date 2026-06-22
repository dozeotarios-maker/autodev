// S2-M4: SubagentJudge tests — mock SubagentDriver so no real subagent needed
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentJudge } from '../../src/verify/subagent-judge.js'
import type { SubagentDriver } from '../../src/host/subagent-driver.js'
import type { SubagentResult } from '../../src/host/types.js'

function makeDriver(outputs: string[]): SubagentDriver {
  let call = 0
  return {
    invoke: vi.fn().mockImplementation(async () => {
      const out = outputs[call++] ?? ''
      const result: SubagentResult = { index: 0, agent: 'test', task: 'test', output: out }
      return [result]
    }),
  } as unknown as SubagentDriver
}

describe('S2-M4: SubagentJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // isDone tests
  it('isDone returns true when subagent outputs {"done":true}', async () => {
    const driver = makeDriver([JSON.stringify({ done: true })])
    const judge = new SubagentJudge(driver)
    expect(await judge.isDone('build login', 'tests pass')).toBe(true)
  })

  it('isDone returns false when subagent outputs {"done":false}', async () => {
    const driver = makeDriver([JSON.stringify({ done: false })])
    const judge = new SubagentJudge(driver)
    expect(await judge.isDone('build login', 'partial')).toBe(false)
  })

  it('isDone returns false when subagent output is not parseable JSON', async () => {
    const driver = makeDriver(['not json at all'])
    const judge = new SubagentJudge(driver)
    expect(await judge.isDone('goal', 'evidence')).toBe(false)
  })

  it('isDone returns false when subagent output is empty', async () => {
    const driver = makeDriver([''])
    const judge = new SubagentJudge(driver)
    expect(await judge.isDone('goal', 'evidence')).toBe(false)
  })

  it('isDone task contains ONLY goal + evidence — no spec/trace', async () => {
    const driver = makeDriver([JSON.stringify({ done: true })])
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const judge = new SubagentJudge(driver)
    await judge.isDone('MY_GOAL', 'MY_EVIDENCE')
    const tasks = invoke.mock.calls[0][0] as Array<{ task: string }>
    expect(tasks[0].task).toContain('MY_GOAL')
    expect(tasks[0].task).toContain('MY_EVIDENCE')
  })

  // isStillRight tests
  it('isStillRight returns aligned=true when subagent outputs {"aligned":true}', async () => {
    const driver = makeDriver([JSON.stringify({ aligned: true })])
    const judge = new SubagentJudge(driver)
    const result = await judge.isStillRight('spec', 'diff')
    expect(result.aligned).toBe(true)
  })

  it('isStillRight returns aligned=false with reason', async () => {
    const driver = makeDriver([JSON.stringify({ aligned: false, reason: 'diverges from spec' })])
    const judge = new SubagentJudge(driver)
    const result = await judge.isStillRight('spec', 'diff')
    expect(result.aligned).toBe(false)
    expect(result.reason).toBe('diverges from spec')
  })

  it('isStillRight defaults to aligned=true on unparseable output (no spurious backedge)', async () => {
    const driver = makeDriver(['not json'])
    const judge = new SubagentJudge(driver)
    const result = await judge.isStillRight('spec', 'diff')
    expect(result.aligned).toBe(true)
  })

  it('isStillRight task contains spec + diff — not extra context', async () => {
    const driver = makeDriver([JSON.stringify({ aligned: true })])
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const judge = new SubagentJudge(driver)
    await judge.isStillRight('MY_SPEC', 'MY_DIFF')
    const tasks = invoke.mock.calls[0][0] as Array<{ task: string }>
    expect(tasks[0].task).toContain('MY_SPEC')
    expect(tasks[0].task).toContain('MY_DIFF')
  })

  it('satisfies the Judge port interface', () => {
    const driver = makeDriver([])
    const judge = new SubagentJudge(driver)
    expect(typeof judge.isDone).toBe('function')
    expect(typeof judge.isStillRight).toBe('function')
  })

  it('done-judge is a separate subagent (not self-judge) — agent name set', async () => {
    const driver = makeDriver([JSON.stringify({ done: true })])
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const judge = new SubagentJudge(driver)
    await judge.isDone('goal', 'evidence')
    const tasks = invoke.mock.calls[0][0] as Array<{ agent: string }>
    expect(tasks[0].agent).toBeTruthy()
    expect(tasks[0].agent).not.toBe('self')
  })
})
