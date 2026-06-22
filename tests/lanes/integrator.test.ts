import { describe, it, expect } from 'vitest'
import { Integrator, LaneOutput } from '../../src/lanes/integrator.js'
import { ContractRegistry } from '../../src/lanes/contract-registry.js'

describe('M4: G7 single integrator', () => {
  it('reconciles two non-conflicting lane outputs', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const lane1: LaneOutput = {
      laneId: 'lane-1',
      files: ['src/auth.ts'],
      output: 'auth module implemented',
      sharedBoundaryChanges: [],
    }
    const lane2: LaneOutput = {
      laneId: 'lane-2',
      files: ['src/db.ts'],
      output: 'db module implemented',
      sharedBoundaryChanges: [],
    }

    const result = await integrator.reconcile([lane1, lane2])
    expect(result.ok).toBe(true)
    expect(result.merged).toHaveLength(2)
  })

  it('G18: blocks merge when lane mutates shared boundary without brokering', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    const lane1: LaneOutput = {
      laneId: 'lane-1',
      files: ['src/auth.ts'],
      output: 'changed User interface',
      sharedBoundaryChanges: [{ symbol: 'User', type: 'interface' }],
    }

    const result = await integrator.reconcile([lane1])
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/registry|broker|G18/i)
  })

  it('G18: allows merge when shared boundary change is published to registry', async () => {
    const registry = new ContractRegistry()
    const integrator = new Integrator(registry)

    registry.publish({
      symbol: 'User',
      type: 'interface',
      laneId: 'lane-1',
      description: 'Added email field',
    })

    const lane1: LaneOutput = {
      laneId: 'lane-1',
      files: ['src/auth.ts'],
      output: 'changed User interface',
      sharedBoundaryChanges: [{ symbol: 'User', type: 'interface' }],
    }

    const result = await integrator.reconcile([lane1])
    expect(result.ok).toBe(true)
  })
})

describe('M4: contract registry', () => {
  it('publishes and retrieves a contract entry', () => {
    const registry = new ContractRegistry()
    registry.publish({
      symbol: 'ApiResponse',
      type: 'type',
      laneId: 'lane-2',
      description: 'Added pagination fields',
    })
    const entries = registry.getAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].symbol).toBe('ApiResponse')
  })

  it('isBrokered returns true for published symbol', () => {
    const registry = new ContractRegistry()
    registry.publish({
      symbol: 'Config',
      type: 'interface',
      laneId: 'lane-1',
      description: 'New field',
    })
    expect(registry.isBrokered('Config')).toBe(true)
  })

  it('isBrokered returns false for unpublished symbol', () => {
    const registry = new ContractRegistry()
    expect(registry.isBrokered('UnknownType')).toBe(false)
  })
})
