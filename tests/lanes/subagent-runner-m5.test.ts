// S2-M5: LaneSubagentRunner — real pi-subagents build lane tests.
// Mocks SubagentDriver so no real subagents are spawned.
// Covers every S2-M5 default-FAIL criterion:
//   ☐ lanes → well-formed worktree subagent instruction
//   ☐ results parsed per lane
//   ☐ integrator reconciles + blocks unbrokered G18 shared-boundary change
//   ☐ clean-tree precondition enforced (DirtyTreeError propagated from driver)

import { describe, it, expect, vi } from 'vitest'
import { LaneSubagentRunner } from '../../src/lanes/subagent-runner.js'
import { Integrator } from '../../src/lanes/integrator.js'
import { ContractRegistry } from '../../src/lanes/contract-registry.js'
import type { SubagentDriver } from '../../src/host/subagent-driver.js'
import type { SubagentResult } from '../../src/host/types.js'
import type { LaneAssignment } from '../../src/lanes/partitioner.js'
import { DirtyTreeError } from '../../src/host/types.js'

// ── Mock SubagentDriver factory ───────────────────────────────────────────────

function makeDriver(results: SubagentResult[]): SubagentDriver {
  return {
    invoke: vi.fn().mockResolvedValue(results),
  } as unknown as SubagentDriver
}

function makeSubagentResult(index: number, output: string): SubagentResult {
  return { index, agent: 'worker', task: `task-${index}`, output }
}

// ── Tests: lane → well-formed subagent instruction ────────────────────────────

describe('S2-M5: LaneSubagentRunner.run() — dispatch', () => {
  it('calls SubagentDriver.invoke with worktree:true', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
    ]
    const driver = makeDriver([makeSubagentResult(0, 'auth done')])
    const runner = new LaneSubagentRunner(driver)

    await runner.run(lanes)

    expect(driver.invoke).toHaveBeenCalledOnce()
    const [, opts] = (driver.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts.worktree).toBe(true)
  })

  it('passes concurrency cap to SubagentDriver', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/a.ts'] },
      { id: 'lane-2', files: ['src/b.ts'] },
    ]
    const driver = makeDriver([
      makeSubagentResult(0, 'a done'),
      makeSubagentResult(1, 'b done'),
    ])
    const runner = new LaneSubagentRunner(driver, { concurrency: 3 })

    await runner.run(lanes)

    const [, opts] = (driver.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts.concurrency).toBe(3)
  })

  it('maps each LaneAssignment to a SubagentTask containing the lane id and files', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts', 'src/db.ts'] },
      { id: 'lane-2', files: ['src/api.ts'] },
    ]
    const driver = makeDriver([
      makeSubagentResult(0, 'auth+db done'),
      makeSubagentResult(1, 'api done'),
    ])
    const runner = new LaneSubagentRunner(driver)

    await runner.run(lanes)

    const [tasks] = (driver.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(tasks).toHaveLength(2)

    // Each task must reference the lane id and files in its description.
    expect(tasks[0].task).toContain('lane-1')
    expect(tasks[0].task).toContain('src/auth.ts')
    expect(tasks[0].task).toContain('src/db.ts')

    expect(tasks[1].task).toContain('lane-2')
    expect(tasks[1].task).toContain('src/api.ts')
  })

  it('returns an empty array for zero lanes (no invoke called)', async () => {
    const driver = makeDriver([])
    const runner = new LaneSubagentRunner(driver)

    const result = await runner.run([])

    expect(result).toHaveLength(0)
    expect(driver.invoke).not.toHaveBeenCalled()
  })
})

// ── Tests: results parsed per lane ───────────────────────────────────────────

describe('S2-M5: LaneSubagentRunner.run() — result correlation', () => {
  it('correlates each result to its originating lane by index', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
      { id: 'lane-2', files: ['src/db.ts'] },
      { id: 'lane-3', files: ['src/api.ts'] },
    ]
    const driver = makeDriver([
      makeSubagentResult(0, 'auth module done'),
      makeSubagentResult(1, 'db module done'),
      makeSubagentResult(2, 'api module done'),
    ])
    const runner = new LaneSubagentRunner(driver)

    const results = await runner.run(lanes)

    expect(results).toHaveLength(3)
    expect(results[0].laneId).toBe('lane-1')
    expect(results[0].output).toBe('auth module done')
    expect(results[0].files).toEqual(['src/auth.ts'])

    expect(results[1].laneId).toBe('lane-2')
    expect(results[1].output).toBe('db module done')

    expect(results[2].laneId).toBe('lane-3')
    expect(results[2].output).toBe('api module done')
  })

  it('marks a lane as failed when output contains error marker', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
    ]
    const driver = makeDriver([makeSubagentResult(0, 'error: type mismatch in src/auth.ts')])
    const runner = new LaneSubagentRunner(driver)

    const results = await runner.run(lanes)

    expect(results[0].failed).toBe(true)
  })

  it('marks a lane as succeeded for normal output', async () => {
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
    ]
    const driver = makeDriver([makeSubagentResult(0, 'auth module implemented')])
    const runner = new LaneSubagentRunner(driver)

    const results = await runner.run(lanes)

    expect(results[0].failed).toBe(false)
  })
})

// ── Tests: clean-tree precondition (DirtyTreeError surfaces from driver) ──────

describe('S2-M5: clean-tree precondition', () => {
  it('propagates DirtyTreeError from SubagentDriver when tree is dirty and stash fails', async () => {
    const driver = {
      invoke: vi.fn().mockRejectedValue(new DirtyTreeError('stash conflict')),
    } as unknown as SubagentDriver

    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/x.ts'] }]

    await expect(runner.run(lanes)).rejects.toThrow(DirtyTreeError)
  })
})

// ── Tests: integrator reconciliation with subagent results ────────────────────

describe('S2-M5: Integrator.fromSubagentResults() + reconcile()', () => {
  it('converts LaneRunResults to LaneOutput[] with empty sharedBoundaryChanges', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const driver = makeDriver([
      makeSubagentResult(0, 'auth done'),
      makeSubagentResult(1, 'db done'),
    ])
    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
      { id: 'lane-2', files: ['src/db.ts'] },
    ]

    const runResults = await runner.run(lanes)
    const laneOutputs = integrator.fromSubagentResults(runResults)

    expect(laneOutputs).toHaveLength(2)
    expect(laneOutputs[0].laneId).toBe('lane-1')
    expect(laneOutputs[0].files).toEqual(['src/auth.ts'])
    expect(laneOutputs[0].sharedBoundaryChanges).toEqual([])
    expect(laneOutputs[1].laneId).toBe('lane-2')
  })

  it('reconcile() succeeds when no shared boundary changes', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const driver = makeDriver([makeSubagentResult(0, 'done')])
    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/a.ts'] }]

    const runResults = await runner.run(lanes)
    const laneOutputs = integrator.fromSubagentResults(runResults)
    const result = await integrator.reconcile(laneOutputs, runResults)

    expect(result.ok).toBe(true)
    expect(result.merged).toHaveLength(1)
  })

  it('reconcile() blocks when a lane failed during subagent execution', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const driver = makeDriver([
      makeSubagentResult(0, 'error: compilation failed'),
    ])
    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/broken.ts'] }]

    const runResults = await runner.run(lanes)
    const laneOutputs = integrator.fromSubagentResults(runResults)
    const result = await integrator.reconcile(laneOutputs, runResults)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/failed/)
  })

  it('G18: blocks unbrokered shared-boundary change via integrator', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const driver = makeDriver([makeSubagentResult(0, 'User interface changed')])
    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/user.ts'] }]

    const runResults = await runner.run(lanes)
    const laneOutputs = integrator.fromSubagentResults(runResults)

    // Manually mark a shared boundary change to simulate a lane that mutated User.
    laneOutputs[0].sharedBoundaryChanges.push({ symbol: 'User', type: 'interface' })

    const result = await integrator.reconcile(laneOutputs)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/G18|broker|registry/i)
  })

  it('G18: allows merge when shared boundary change is published to registry', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    // Publish before reconcile — lane brokered the change.
    registry.publish({
      symbol: 'User',
      type: 'interface',
      laneId: 'lane-1',
      description: 'Added email field',
    })

    const driver = makeDriver([makeSubagentResult(0, 'User interface updated')])
    const runner = new LaneSubagentRunner(driver)
    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/user.ts'] }]

    const runResults = await runner.run(lanes)
    const laneOutputs = integrator.fromSubagentResults(runResults)
    laneOutputs[0].sharedBoundaryChanges.push({ symbol: 'User', type: 'interface' })

    const result = await integrator.reconcile(laneOutputs)

    expect(result.ok).toBe(true)
  })
})

// ── Fix (round-2): SUBAGENT_MISSING sentinel → lane marked failed:true ────────

describe('Fix: SUBAGENT_MISSING sentinel → lane is marked failed', () => {
  it('a lane whose subagent result is missing (SUBAGENT_MISSING output) is marked failed:true', async () => {
    // Simulate SubagentDriver returning SUBAGENT_MISSING for a task where the
    // host returned fewer results than tasks.
    const { SUBAGENT_MISSING } = await import('../../src/host/subagent-driver.js')

    const lanes: LaneAssignment[] = [
      { id: 'lane-1', files: ['src/auth.ts'] },
      { id: 'lane-2', files: ['src/db.ts'] },
    ]

    // Driver returns only one result — lane-2 is missing → driver sets SUBAGENT_MISSING
    const driver = makeDriver([
      makeSubagentResult(0, 'auth done'),
      makeSubagentResult(1, SUBAGENT_MISSING),  // sentinel for missing result
    ])
    const runner = new LaneSubagentRunner(driver)

    const results = await runner.run(lanes)

    expect(results).toHaveLength(2)
    expect(results[0].failed).toBe(false)  // auth lane succeeded
    expect(results[1].failed).toBe(true)   // missing result → must be failed
  })

  it('SUBAGENT_MISSING does not match normal-success heuristics (empty-string guard)', async () => {
    // Verify that SUBAGENT_MISSING is not treated as success by the lower
    // heuristics (it doesn't contain 'error:' / 'fatal:' / start with 'failed',
    // so only the explicit sentinel check catches it).
    const { SUBAGENT_MISSING } = await import('../../src/host/subagent-driver.js')

    const lanes: LaneAssignment[] = [{ id: 'lane-1', files: ['src/x.ts'] }]
    const driver = makeDriver([makeSubagentResult(0, SUBAGENT_MISSING)])
    const runner = new LaneSubagentRunner(driver)

    const results = await runner.run(lanes)
    expect(results[0].failed).toBe(true)
    expect(results[0].output).toBe(SUBAGENT_MISSING)
  })
})

// ── Tests: backward compat — existing reconcile() signature unchanged ─────────

describe('S2-M5: Integrator.reconcile() backward compatibility', () => {
  it('works without rawResults argument (original M4 signature)', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const result = await integrator.reconcile([
      {
        laneId: 'lane-1',
        files: ['src/x.ts'],
        output: 'done',
        sharedBoundaryChanges: [],
      },
    ])

    expect(result.ok).toBe(true)
    expect(result.merged).toHaveLength(1)
  })
})
