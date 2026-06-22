import { describe, it, expect, vi } from 'vitest'
import { SelfPromptLoop } from '../../src/engine/self-prompt.js'
import type { AgentResult } from '../../src/host/types.js'

// Minimal AgentResult for mock steer responses
function mockResult(seq = 1, rawText = ''): AgentResult {
  return { rawText, toolResults: [], seq }
}

describe('M3: self-prompt loop (rewired to HostAgent.steer)', () => {
  it('calls steer with the instruction after turn_end', async () => {
    const steer = vi.fn().mockResolvedValue(mockResult(1, 'done'))
    const loop = new SelfPromptLoop({ steer, maxIterations: 5 })

    const result = await loop.next('implement the login form')

    expect(steer).toHaveBeenCalledWith(
      expect.stringContaining('login form')
    )
    expect(result.halted).toBe(false)
    expect(result.agentResult).toBeDefined()
  })

  it('halts when maxIterations reached', async () => {
    const steer = vi.fn().mockResolvedValue(mockResult(1))
    const loop = new SelfPromptLoop({ steer, maxIterations: 2 })

    await loop.next('task 1')
    await loop.next('task 2')
    const result = await loop.next('task 3')

    expect(result.halted).toBe(true)
    expect(result.reason).toMatch(/max/i)
    // steer should NOT have been called on the 3rd attempt
    expect(steer).toHaveBeenCalledTimes(2)
  })

  it('resets iteration count on explicit reset()', async () => {
    const steer = vi.fn().mockResolvedValue(mockResult(1))
    const loop = new SelfPromptLoop({ steer, maxIterations: 2 })

    await loop.next('task 1')
    await loop.next('task 2')
    loop.reset()

    const result = await loop.next('task 3')
    expect(result.halted).toBe(false)
    expect(steer).toHaveBeenCalledTimes(3)
  })

  it('passes the instruction through unchanged', async () => {
    const steer = vi.fn().mockResolvedValue(mockResult(1))
    const loop = new SelfPromptLoop({ steer, maxIterations: 10 })

    await loop.next('run the unit tests for auth module')

    expect(steer).toHaveBeenCalledWith(
      expect.stringContaining('unit tests for auth module')
    )
  })

  it('returns the agentResult from steer in PromptResult', async () => {
    const expected = mockResult(7, 'agent completed the task')
    const steer = vi.fn().mockResolvedValue(expected)
    const loop = new SelfPromptLoop({ steer, maxIterations: 5 })

    const result = await loop.next('build auth module')

    expect(result.halted).toBe(false)
    expect(result.agentResult).toEqual(expected)
    expect(result.agentResult?.seq).toBe(7)
    expect(result.agentResult?.rawText).toBe('agent completed the task')
  })

  it('tracks iteration count correctly via getCount()', async () => {
    const steer = vi.fn().mockResolvedValue(mockResult(1))
    const loop = new SelfPromptLoop({ steer, maxIterations: 10 })

    expect(loop.getCount()).toBe(0)
    await loop.next('step 1')
    expect(loop.getCount()).toBe(1)
    await loop.next('step 2')
    expect(loop.getCount()).toBe(2)
  })
})
