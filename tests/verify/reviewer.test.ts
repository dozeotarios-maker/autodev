// S2-M4: R1Reviewer — subagent-backed, clean-context (diff only, no spec/trace)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { R1Reviewer } from '../../src/verify/reviewer.js'
import type { SubagentDriver } from '../../src/host/subagent-driver.js'
import type { SubagentResult } from '../../src/host/types.js'

function makeDriver(output: string): SubagentDriver {
  return {
    invoke: vi.fn().mockResolvedValue([
      { index: 0, agent: 'reviewer', task: '', output } as SubagentResult,
    ]),
  } as unknown as SubagentDriver
}

describe('S2-M4: R1Reviewer (clean-context, subagent-backed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('subagent task contains ONLY diff — no spec or trace present', async () => {
    const driver = makeDriver(JSON.stringify({ aligned: true }))
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const reviewer = new R1Reviewer(driver)
    await reviewer.review({
      diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new',
      spec: 'SECRET SPEC: implement login by doing X',
      llmTrace: 'TRACE: step 1 -> step 2 -> step 3',
    })

    const tasks = invoke.mock.calls[0][0] as Array<{ task: string }>
    const taskText = tasks[0].task
    expect(taskText).toContain('-old')
    expect(taskText).toContain('+new')
    expect(taskText).not.toContain('SECRET SPEC')
    expect(taskText).not.toContain('TRACE:')
  })

  it('returns clean=true when subagent outputs {"aligned":true}', async () => {
    const driver = makeDriver(JSON.stringify({ aligned: true }))
    const reviewer = new R1Reviewer(driver)
    const result = await reviewer.review({ diff: '+const x = 1', spec: 'ignored', llmTrace: 'ignored' })
    expect(result.clean).toBe(true)
  })

  it('returns clean=false with reason when subagent outputs not-aligned', async () => {
    const driver = makeDriver(JSON.stringify({ aligned: false, reason: 'SQL injection vulnerability planted' }))
    const reviewer = new R1Reviewer(driver)
    const result = await reviewer.review({
      diff: "+const query = `SELECT * FROM users WHERE id = ${userId}`",
      spec: 'irrelevant',
      llmTrace: 'irrelevant',
    })
    expect(result.clean).toBe(false)
    expect(result.reason).toContain('SQL injection')
  })

  it('returns clean=true on unparseable subagent output (conservative)', async () => {
    const driver = makeDriver('not json')
    const reviewer = new R1Reviewer(driver)
    const result = await reviewer.review({ diff: '', spec: '', llmTrace: '' })
    expect(result.clean).toBe(true)
  })

  it('reviewer context object has no spec or trace fields', () => {
    const driver = makeDriver('')
    const reviewer = new R1Reviewer(driver)
    expect((reviewer as unknown as Record<string, unknown>).spec).toBeUndefined()
    expect((reviewer as unknown as Record<string, unknown>).llmTrace).toBeUndefined()
    expect((reviewer as unknown as Record<string, unknown>).trace).toBeUndefined()
  })

  it('handles empty diff gracefully', async () => {
    const driver = makeDriver(JSON.stringify({ aligned: true }))
    const reviewer = new R1Reviewer(driver)
    const result = await reviewer.review({ diff: '', spec: '', llmTrace: '' })
    expect(result.clean).toBe(true)
  })

  it('subagent agent name is "reviewer"', async () => {
    const driver = makeDriver(JSON.stringify({ aligned: true }))
    const invoke = (driver.invoke as ReturnType<typeof vi.fn>)
    const reviewer = new R1Reviewer(driver)
    await reviewer.review({ diff: 'x', spec: 'y', llmTrace: 'z' })
    const tasks = invoke.mock.calls[0][0] as Array<{ agent: string }>
    expect(tasks[0].agent).toBe('reviewer')
  })
})
