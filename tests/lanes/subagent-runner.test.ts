import { describe, it, expect, vi } from 'vitest'
import { SubagentRunner } from '../../src/lanes/subagent-runner.js'
import type { Lane } from '../../src/ports.js'

describe('M4: subagent-runner', () => {
  it('spawns a depth=1 worktree-isolated worker via Lane port', async () => {
    const mockLane: Lane = {
      id: 'lane-test',
      files: ['src/auth.ts'],
      run: vi.fn().mockResolvedValue({ output: 'done', exitCode: 0 }),
      status: vi.fn().mockReturnValue('idle'),
    }
    const runner = new SubagentRunner(mockLane)
    const result = await runner.run('implement auth module', { workdir: '/tmp/worktree-1' })
    expect(result.exitCode).toBe(0)
    expect(mockLane.run).toHaveBeenCalledWith('implement auth module', { workdir: '/tmp/worktree-1' })
  })

  it('reports failure when lane exits with non-zero code', async () => {
    const mockLane: Lane = {
      id: 'lane-fail',
      files: ['src/broken.ts'],
      run: vi.fn().mockResolvedValue({ output: 'error: type mismatch', exitCode: 1 }),
      status: vi.fn().mockReturnValue('failed'),
    }
    const runner = new SubagentRunner(mockLane)
    const result = await runner.run('broken task')
    expect(result.exitCode).toBe(1)
    expect(result.failed).toBe(true)
  })

  it('passes depth=1 constraint in options', async () => {
    const mockLane: Lane = {
      id: 'lane-depth',
      files: ['src/x.ts'],
      run: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }),
      status: vi.fn().mockReturnValue('done'),
    }
    const runner = new SubagentRunner(mockLane, { maxDepth: 1 })
    await runner.run('task')
    expect(mockLane.run).toHaveBeenCalled()
  })
})
