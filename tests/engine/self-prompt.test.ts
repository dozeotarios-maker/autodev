import { describe, it, expect, vi } from 'vitest'
import { SelfPromptLoop } from '../../src/engine/self-prompt.js'

describe('M3: self-prompt loop', () => {
  it('calls sendUserMessage with deliverAs followUp after turn_end', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const loop = new SelfPromptLoop({ sendUserMessage: send, maxIterations: 5 })

    await loop.next('implement the login form')

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('login form'),
      { deliverAs: 'followUp' }
    )
  })

  it('halts when maxIterations reached', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const loop = new SelfPromptLoop({ sendUserMessage: send, maxIterations: 2 })

    await loop.next('task 1')
    await loop.next('task 2')
    const result = await loop.next('task 3')

    expect(result.halted).toBe(true)
    expect(result.reason).toMatch(/max/i)
    // send should NOT have been called on the 3rd attempt
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('resets iteration count on explicit reset()', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const loop = new SelfPromptLoop({ sendUserMessage: send, maxIterations: 2 })

    await loop.next('task 1')
    await loop.next('task 2')
    loop.reset()

    const result = await loop.next('task 3')
    expect(result.halted).toBe(false)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('passes the instruction through unchanged', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const loop = new SelfPromptLoop({ sendUserMessage: send, maxIterations: 10 })

    await loop.next('run the unit tests for auth module')

    expect(send).toHaveBeenCalledWith(
      expect.stringContaining('unit tests for auth module'),
      expect.objectContaining({ deliverAs: 'followUp' })
    )
  })
})
