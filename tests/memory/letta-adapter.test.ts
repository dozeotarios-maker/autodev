// M2 MemoryStore port — Letta adapter tests (D1: written FIRST)
// Uses in-memory mock for Letta per G12 real-or-mocked boundary rule.
import { describe, it, expect, beforeEach } from 'vitest'
import { LettaAdapter } from '../../src/memory/letta-adapter.js'
import type { MemoryStore } from '../../src/ports.js'

describe('M2: LettaAdapter — MemoryStore port', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new LettaAdapter({ mock: true })
  })

  it('satisfies the MemoryStore port shape', () => {
    expect(typeof store.store).toBe('function')
    expect(typeof store.recall).toBe('function')
    expect(typeof store.detectContradictions).toBe('function')
    expect(typeof store.healthCheck).toBe('function')
  })

  it('store → recall round-trip returns the stored value', async () => {
    await store.store('auth-method', 'service X uses REST')
    const results = await store.recall('auth-method')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].value).toBe('service X uses REST')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('recall with limit caps the result count', async () => {
    await store.store('fact-a', 'alpha')
    await store.store('fact-b', 'beta')
    await store.store('fact-c', 'gamma')
    const results = await store.recall('fact', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('recall returns empty array when nothing stored', async () => {
    const results = await store.recall('totally-unknown-query-xyz')
    expect(results).toEqual([])
  })

  it('contradiction-detect: same key stored with conflicting values flags conflict', async () => {
    await store.store('auth-method', 'service X uses REST')
    await store.store('auth-method', 'service X uses gRPC')
    const conflicts = await store.detectContradictions('auth-method')
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0].conflictFlag).toBe(true)
    expect(conflicts[0].a).toBeTruthy()
    expect(conflicts[0].b).toBeTruthy()
  })

  it('detectContradictions returns empty when only one value stored', async () => {
    await store.store('single-fact', 'just one value')
    const conflicts = await store.detectContradictions('single-fact')
    expect(conflicts.every(c => !c.conflictFlag)).toBe(true)
  })

  it('healthCheck returns ok:true in mock mode', async () => {
    const health = await store.healthCheck()
    expect(health.ok).toBe(true)
  })
})
