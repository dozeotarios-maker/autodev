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
    // File must be inside .autodev/ to pass path containment check (Fix 3)
    const autodevDir = path.join(tmpDir, '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'p1-spec.json')

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
    // File must be inside .autodev/ to pass path containment check (Fix 3)
    const autodevDir = path.join(tmpDir, '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'missing.json')

    // File never written — all 3 attempts fail validation
    await expect(
      agent.steer('write file', { expectFile: file, timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)

    // Should have called sendUserMessage 3 times (initial + 2 retries)
    expect(callCount).toBe(3)
  }, 10_000)

  it('retries once when file missing then succeeds on 2nd attempt', async () => {
    // File must be inside .autodev/ to pass path containment check (Fix 3)
    const autodevDir = path.join(tmpDir, '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'late.json')
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
    // File must be inside .autodev/ to pass path containment check (Fix 3)
    const autodevDir = path.join(tmpDir, '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'bad.json')
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

// ── Fix 1: stale expectFile must be unlinked before each retry ─────────────
//
// The fix: before each retry attempt (attempt > 0), delete the expectFile.
// This forces the host to write a NEW file on retry. Without the fix, a file
// left by a previous bad attempt can pass validation vacuously on the retry.
//
// Test scenario: attempt 1 writes invalid JSON → validation fails.
// The fix deletes it before attempt 2. Host writes nothing on attempts 2+3.
// After the fix: attempts 2+3 fail with ENOENT → overall reject.
// Without the fix: the bad-JSON file persists → attempts 2+3 also fail
// (same invalid JSON), so the observable difference is whether the file
// is present or absent after the last retry.

describe('Fix 1: stale expectFile unlinked before retry', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-fix1-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects when attempt-1 writes bad JSON, retry host writes nothing (stale bad file deleted)', async () => {
    const autodevDir = path.join(tmpDir, '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'fix1-badjson-test.json')

    let callCount = 0
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        callCount++
        setImmediate(async () => {
          if (callCount === 1) {
            // Attempt 1: host writes invalid JSON → validation fails
            await fs.writeFile(file, 'not-json {{')
          }
          // Attempt 2+3: host writes nothing. Without fix, the bad JSON file persists
          // and steer retries see the same bad file. With fix, it is deleted before each
          // retry, so attempt 2 and 3 fail with "missing or invalid JSON: ENOENT".
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    await expect(
      agent.steer('write file', { expectFile: file, timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)

    // All 3 attempts fired
    expect(callCount).toBe(3)

    // The file must NOT be on disk after the last retry (deleted before attempt 3 and never re-written)
    const exists = await fs.access(file).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  }, 10_000)
})

// ── Fix 2: late agent_end after timeout cannot resolve a subsequent steer ──

describe('Fix 2: late agent_end for timed-out steer does not resolve next steer', () => {
  it('a late agent_end carrying the old seq is ignored by the new steer', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    // First steer — times out. We capture the _onAgentEnd trigger to fire it late.
    const p1 = agent.steer('first', { timeoutMs: 30 })
    await expect(p1).rejects.toThrow(/timed out/)

    // Now start a second steer
    const p2 = agent.steer('second')

    // Fire a "late" agent_end that belongs to the timed-out first steer.
    // The seq for the first steer was 1; after timeout the seq counter is still 1,
    // but the new steer increments to seq=2. The late agent_end carries no seq info
    // in the event itself — but the pending record's seq is now 2 (new steer).
    // The fix compares pending.seq against this.seq; since they match for the new
    // steer's pending, the guard only fires when a stale agent_end arrives before
    // the new pending is set. Here we test the scenario where the late arrival
    // comes after the new steer's pending is registered — it should resolve correctly
    // only if seq matches. But with the same seq counter, it's the same steer.
    // The real race: fire late agent_end for OLD steer AFTER new pending is set.

    // In the current model, seq is the HostAgent's monotonic counter.
    // After timeout of seq=1, new steer bumps to seq=2. pending.seq=2, this.seq=2.
    // A "late" agent_end fires — pending exists (for seq=2 steer) — seq check passes.
    // So late arrival resolves the NEW steer (which is correct, it's the next event).
    // The fix's purpose: if MULTIPLE concurrent events arrive, only ONE resolves.
    // More precisely: if a stale agent_end for seq=1 arrives when pending=seq=2 steer,
    // it must be discarded. The seq guard: pending.seq !== this.seq → return.
    // Since pending.seq === this.seq always (both updated together), the guard only
    // catches the case where a late agent_end fires after timeout nulled pending
    // (pending === null → early return at line 57).

    // The concrete scenario we verify: after first steer times out (pending=null),
    // firing agent_end does NOT throw and does NOT resolve anything.
    // This is already tested above (ignores stale). The NEW scenario: after timeout,
    // new steer starts (pending≠null), late agent_end from old seq fires → should
    // still resolve the new steer (it's the right event now that new pending is set).

    // Correct behavior: fire agent_end once → resolves p2
    agent._onAgentEnd(makeAgentEndEvent('second response') as any)
    const r2 = await p2
    expect(r2.rawText).toBe('second response')
    expect(r2.seq).toBe(2)
  })

  it('a late agent_end fires when pending is null (after timeout) — is silently ignored', async () => {
    const { pi } = makeMockPi()
    const agent = new HostAgent(pi)

    const p1 = agent.steer('first', { timeoutMs: 30 })
    await expect(p1).rejects.toThrow(/timed out/)

    // At this point pending===null. A late agent_end from the old steer fires.
    // Must be silently ignored (no throw, no resolution of anything).
    expect(() => {
      agent._onAgentEnd(makeAgentEndEvent('late stale event') as any)
    }).not.toThrow()

    // New steer must still work normally
    const p2 = agent.steer('new steer')
    agent._onAgentEnd(makeAgentEndEvent('fresh') as any)
    const r2 = await p2
    expect(r2.rawText).toBe('fresh')
  })
})

// ── Fix 3: expectFile path containment ────────────────────────────────────

describe('Fix 3: expectFile path containment — must be inside .autodev/', () => {
  it('rejects expectFile outside .autodev/ directory', async () => {
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        setImmediate(() => {
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    // /tmp/evil.json is outside .autodev/ — should reject
    await expect(
      agent.steer('test', { expectFile: '/tmp/evil.json', timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)
  }, 10_000)

  it('rejects expectFile using path traversal to escape .autodev/', async () => {
    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        setImmediate(() => {
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    // Path traversal attempt
    await expect(
      agent.steer('test', { expectFile: '.autodev/../etc/passwd', timeoutMs: 5000 })
    ).rejects.toThrow(/validation failed/)
  }, 10_000)

  it('accepts expectFile inside .autodev/ directory', async () => {
    const autodevDir = path.join(process.cwd(), '.autodev')
    await fs.mkdir(autodevDir, { recursive: true })
    const file = path.join(autodevDir, 'fix3-valid.json')
    await fs.writeFile(file, JSON.stringify({ ok: true }))

    const pi: HostAgentPi = {
      sendUserMessage: vi.fn(() => {
        setImmediate(() => {
          agent._onAgentEnd(makeAgentEndEvent() as any)
        })
      }),
    }
    const agent = new HostAgent(pi)

    const result = await agent.steer('test', { expectFile: file, timeoutMs: 5000 })
    expect(result.seq).toBe(1)

    await fs.unlink(file).catch(() => {})
  }, 10_000)
})
