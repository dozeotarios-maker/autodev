import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { HostAgent } from '../../src/host/host-agent.js'
import { SteerInFlightError } from '../../src/host/types.js'
import type { HostAgentPi } from '../../src/host/host-agent.js'

// ── Mock pi factory ─────────────────────────────────────────────────────────

/**
 * Builds a mock pi whose sendUserMessage records the prompt.
 * The test fires synthetic events by calling agent._onAgentEnd() / agent._onTurnEnd().
 */
function makeMockPi(): { pi: HostAgentPi; prompts: string[] } {
  const prompts: string[] = []
  const pi: HostAgentPi = {
    sendUserMessage: vi.fn((content: string) => {
      prompts.push(content)
    }),
  }
  return { pi, prompts }
}

/** Minimal AgentEndEvent shape (only messages field used) */
function makeAgentEndEvent(rawText = 'assistant response') {
  return {
    type: 'agent_end' as const,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: rawText }],
      },
    ],
  }
}

/** Minimal TurnEndEvent shape with optional tool results */
function makeTurnEndEvent(toolResults: Array<{ toolName: string; content?: Array<{ text?: string }> }> = []) {
  return {
    type: 'turn_end' as const,
    turnIndex: 0,
    message: { role: 'assistant', content: [] },
    toolResults: toolResults.map((r) => ({
      toolName: r.toolName,
      toolCallId: 'tc-1',
      content: r.content ?? [],
      isError: false,
    })),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('S2-M1: HostAgent.steer()', () => {
  it('resolves on the next agent_end with assistant text', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const steerPromise = agent.steer('do something')

    // Simulate agent_end arriving
    agent._onAgentEnd(makeAgentEndEvent('hello from assistant') as any)

    const result = await steerPromise
    expect(result.rawText).toBe('hello from assistant')
    expect(result.seq).toBe(1)
  })

  it('increments monotonic seq on each steer call', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const p1 = agent.steer('first')
    agent._onAgentEnd(makeAgentEndEvent('r1') as any)
    const r1 = await p1

    const p2 = agent.steer('second')
    agent._onAgentEnd(makeAgentEndEvent('r2') as any)
    const r2 = await p2

    expect(r1.seq).toBe(1)
    expect(r2.seq).toBe(2)
    expect(r2.seq).toBeGreaterThan(r1.seq)
  })

  it('ignores a stale agent_end when no steer is in-flight', () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    // Fire agent_end with no pending steer — should not throw
    expect(() => {
      agent._onAgentEnd(makeAgentEndEvent('stale') as any)
    }).not.toThrow()
  })

  it('throws SteerInFlightError on concurrent steer()', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    // Start first steer but don't resolve it yet
    const p1 = agent.steer('first')

    // Second steer attempt while first is in-flight
    await expect(agent.steer('second')).rejects.toThrow(SteerInFlightError)

    // Resolve first steer
    agent._onAgentEnd(makeAgentEndEvent() as any)
    await p1
  })

  it('rejects on timeout', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const steerPromise = agent.steer('timeout test', { timeoutMs: 50 })

    // Do NOT fire agent_end — let it time out
    await expect(steerPromise).rejects.toThrow(/timed out/)
  })

  it('allows a new steer after a timeout (mutex released)', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    // First steer times out
    const p1 = agent.steer('first', { timeoutMs: 30 })
    await expect(p1).rejects.toThrow(/timed out/)

    // After timeout, mutex is released — second steer should work
    const p2 = agent.steer('second')
    agent._onAgentEnd(makeAgentEndEvent('ok') as any)
    const r2 = await p2
    expect(r2.rawText).toBe('ok')
  })

  it('accumulates turn_end toolResults into AgentResult', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const p = agent.steer('with tools')

    // Simulate turn_end with tool results
    agent._onTurnEnd(makeTurnEndEvent([
      { toolName: 'bash', content: [{ text: 'output1' }] },
    ]) as any)
    agent._onTurnEnd(makeTurnEndEvent([
      { toolName: 'read', content: [{ text: 'output2' }] },
    ]) as any)

    agent._onAgentEnd(makeAgentEndEvent() as any)
    const result = await p

    expect(result.toolResults).toHaveLength(2)
    expect(result.toolResults[0].toolName).toBe('bash')
    expect(result.toolResults[1].toolName).toBe('read')
  })

  it('calls pi.sendUserMessage with deliverAs followUp', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const p = agent.steer('the prompt')
    agent._onAgentEnd(makeAgentEndEvent() as any)
    await p

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      'the prompt',
      { deliverAs: 'followUp' }
    )
  })
})

// ── expectFile validation ───────────────────────────────────────────────────

describe('S2-M1: HostAgent expectFile validation', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('resolves immediately when expectFile exists and is valid JSON', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)
    const file = path.join(tmpDir, 'p1-spec.json')

    await fs.writeFile(file, JSON.stringify({ spec: 'hello' }))

    const p = agent.steer('write file', { expectFile: file })
    agent._onAgentEnd(makeAgentEndEvent() as any)
    const result = await p

    expect(result.seq).toBe(1)
  })

  it('retries up to 2 times when expectFile is missing, then rejects', async () => {
    // Use sendUserMessage as the trigger to fire agent_end reactively.
    // Each time steer() calls pi.sendUserMessage for an attempt (initial + 2 retries),
    // we fire agent_end via setImmediate so pending is already set.
    let callCount = 0
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        callCount++
        setImmediate(() => {
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)
    const file = path.join(tmpDir, 'missing.json')

    // File never written — all 3 attempts fail validation
    await expect(
      agent.steer('write file', { expectFile: file, timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)

    // Should have called sendUserMessage 3 times (initial + 2 retries)
    expect(callCount).toBe(3)
  }, 10_000)

  it('retries once when file missing then succeeds on 2nd attempt', async () => {
    const file = path.join(tmpDir, 'late.json')
    let callCount = 0

    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        callCount++
        const attempt = callCount
        setImmediate(async () => {
          if (attempt === 2) {
            // Write the file before the second agent_end so validation passes
            await fs.writeFile(file, JSON.stringify({ done: true }))
          }
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    const result = await agent.steer('write file', { expectFile: file, timeoutMs: 5000 })
    expect(result.seq).toBe(1)
    expect(callCount).toBe(2) // initial attempt failed, retry succeeded
  }, 10_000)

  it('rejects when expectFile exists but is invalid JSON', async () => {
    const file = path.join(tmpDir, 'bad.json')
    await fs.writeFile(file, 'not json {{{')

    // Fire agent_end reactively on each sendUserMessage call
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        setImmediate(() => {
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    await expect(
      agent.steer('write file', { expectFile: file, timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)
  }, 10_000)
})

// ── expectTool validation ───────────────────────────────────────────────────

describe('S2-M1: HostAgent expectTool validation', () => {
  it('resolves when the expected tool appears in turn_end results', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const p = agent.steer('call the subagent tool', { expectTool: 'subagent' })

    agent._onTurnEnd(makeTurnEndEvent([
      { toolName: 'subagent', content: [{ text: '{"result":"ok"}' }] },
    ]) as any)
    agent._onAgentEnd(makeAgentEndEvent() as any)

    const result = await p
    expect(result.toolResults.some((r) => r.toolName === 'subagent')).toBe(true)
  })

  it('retries and rejects when expected tool never appears', async () => {
    // Fire agent_end reactively on each sendUserMessage call (no subagent tool ever)
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        setImmediate(() => {
          agent._onTurnEnd(makeTurnEndEvent([{ toolName: 'bash' }]) as any)
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    await expect(
      agent.steer('call subagent', { expectTool: 'subagent', timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)

    // 3 attempts (initial + 2 retries)
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3)
  }, 10_000)
})
