import { describe, it, expect, vi } from 'vitest'
import { SubagentDriver } from '../../src/host/subagent-driver.js'
import { DirtyTreeError } from '../../src/host/types.js'
import type { HostAgent } from '../../src/host/host-agent.js'
import type { AgentResult } from '../../src/host/types.js'
import type { GitExec } from '../../src/host/subagent-driver.js'

// ── Mock HostAgent ──────────────────────────────────────────────────────────

function mockAgentResult(
  toolResults: Array<{ toolName: string; content?: Array<{ text?: string }> }> = []
): AgentResult {
  return {
    rawText: 'subagent instruction dispatched',
    toolResults: toolResults.map((r) => ({
      toolName: r.toolName,
      toolCallId: 'tc-1',
      content: r.content ?? [],
      isError: false,
    })),
    seq: 1,
  }
}

function makeMockHostAgent(result?: AgentResult): HostAgent {
  return {
    steer: vi.fn().mockResolvedValue(
      result ??
        mockAgentResult([
          { toolName: 'subagent', content: [{ text: 'task 0 done' }] },
          { toolName: 'subagent', content: [{ text: 'task 1 done' }] },
        ])
    ),
    _onAgentEnd: vi.fn(),
    _onTurnEnd: vi.fn(),
  } as unknown as HostAgent
}

/** Clean-tree git exec stub (no output from status) */
function cleanTreeGitExec(): GitExec {
  return vi.fn().mockResolvedValue({ stdout: '' })
}

/** Dirty-tree git exec stub (status returns dirty output, stash+pop succeed) */
function dirtyTreeGitExec(gitCalls: string[][]): GitExec {
  return vi.fn((args: string[]) => {
    gitCalls.push(args)
    if (args[0] === 'status') {
      return Promise.resolve({ stdout: 'M src/foo.ts\n' })
    }
    // stash push / stash pop succeed
    return Promise.resolve({ stdout: '' })
  })
}

/** Git exec that fails on stash push */
function failingStashGitExec(): GitExec {
  return vi.fn((args: string[]) => {
    if (args[0] === 'status') {
      return Promise.resolve({ stdout: 'M src/dirty.ts\n' })
    }
    if (args[0] === 'stash' && args[1] === 'push') {
      return Promise.reject(new Error('stash conflict'))
    }
    return Promise.resolve({ stdout: '' })
  })
}

// ── Tests: invoke() ─────────────────────────────────────────────────────────

describe('S2-M1: SubagentDriver.invoke()', () => {
  it('steers a well-formed subagent instruction containing task details', async () => {
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent)

    await driver.invoke([
      { agent: 'coder', task: 'implement auth module' },
      { agent: 'tester', task: 'write auth tests' },
    ])

    expect(agent.steer).toHaveBeenCalledOnce()
    const [prompt, opts] = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(prompt).toContain('subagent')
    expect(prompt).toContain('implement auth module')
    expect(prompt).toContain('write auth tests')
    expect(opts?.expectTool).toBe('subagent')
  })

  it('filters toolResults to toolName===subagent and ignores other tools', async () => {
    const agent = makeMockHostAgent(
      mockAgentResult([
        { toolName: 'bash', content: [{ text: 'ignored' }] },
        { toolName: 'subagent', content: [{ text: 'task 0 result' }] },
        { toolName: 'read', content: [{ text: 'also ignored' }] },
        { toolName: 'subagent', content: [{ text: 'task 1 result' }] },
      ])
    )
    const driver = new SubagentDriver(agent)

    const results = await driver.invoke([
      { agent: 'a', task: 'task 0' },
      { agent: 'b', task: 'task 1' },
    ])

    expect(results).toHaveLength(2)
    expect(results[0].output).toContain('task 0 result')
    expect(results[1].output).toContain('task 1 result')
  })

  it('correlates results by task index', async () => {
    const agent = makeMockHostAgent(
      mockAgentResult([
        { toolName: 'subagent', content: [{ text: 'result for alpha' }] },
        { toolName: 'subagent', content: [{ text: 'result for beta' }] },
        { toolName: 'subagent', content: [{ text: 'result for gamma' }] },
      ])
    )
    const driver = new SubagentDriver(agent)

    const results = await driver.invoke([
      { agent: 'a1', task: 'alpha task' },
      { agent: 'b1', task: 'beta task' },
      { agent: 'c1', task: 'gamma task' },
    ])

    expect(results[0].index).toBe(0)
    expect(results[0].agent).toBe('a1')
    expect(results[0].output).toContain('result for alpha')

    expect(results[1].index).toBe(1)
    expect(results[1].agent).toBe('b1')
    expect(results[1].output).toContain('result for beta')

    expect(results[2].index).toBe(2)
    expect(results[2].agent).toBe('c1')
    expect(results[2].output).toContain('result for gamma')
  })

  it('includes concurrency in the instruction when provided', async () => {
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent)

    await driver.invoke([{ agent: 'a', task: 'do something' }], { concurrency: 4 })

    const [prompt] = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(prompt).toContain('"concurrency": 4')
  })

  it('includes worktree:true in the instruction when worktree option set', async () => {
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent, { gitExec: cleanTreeGitExec() })

    await driver.invoke([{ agent: 'a', task: 'do something' }], { worktree: true })

    const [prompt] = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(prompt).toContain('"worktree": true')
  })
})

// ── Tests: dirty-tree stash guard ───────────────────────────────────────────

describe('S2-M1: SubagentDriver dirty-tree stash guard', () => {
  it('stashes if tree is dirty, invokes, then pops', async () => {
    const gitCalls: string[][] = []
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent, { gitExec: dirtyTreeGitExec(gitCalls) })

    await driver.invoke([{ agent: 'a', task: 't' }], { worktree: true })

    const statusCall = gitCalls.find((a) => a[0] === 'status')
    const stashPushCall = gitCalls.find((a) => a[0] === 'stash' && a[1] === 'push')
    const stashPopCall = gitCalls.find((a) => a[0] === 'stash' && a[1] === 'pop')

    expect(statusCall).toBeTruthy()
    expect(stashPushCall).toBeTruthy()
    // stash push should include the preflight label
    expect(stashPushCall).toContain('autodev-subagent-preflight')
    expect(stashPopCall).toBeTruthy()
  })

  it('does NOT stash when tree is clean', async () => {
    const gitCalls: string[][] = []
    const gitExec: GitExec = vi.fn((args: string[]) => {
      gitCalls.push(args)
      return Promise.resolve({ stdout: '' }) // clean tree
    })

    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent, { gitExec })

    await driver.invoke([{ agent: 'a', task: 't' }], { worktree: true })

    const stashPushCall = gitCalls.find((a) => a[0] === 'stash' && a[1] === 'push')
    expect(stashPushCall).toBeUndefined()
  })

  it('throws DirtyTreeError when git stash push fails', async () => {
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent, { gitExec: failingStashGitExec() })

    await expect(
      driver.invoke([{ agent: 'a', task: 't' }], { worktree: true })
    ).rejects.toThrow(DirtyTreeError)
  })

  it('does NOT call gitExec at all when worktree is false (default)', async () => {
    const gitExec = vi.fn().mockResolvedValue({ stdout: '' })
    const agent = makeMockHostAgent()
    const driver = new SubagentDriver(agent, { gitExec })

    await driver.invoke([{ agent: 'a', task: 't' }])

    expect(gitExec).not.toHaveBeenCalled()
  })
})
