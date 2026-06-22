// M2 two-plane health aggregator tests (D1: failing first)
import { describe, it, expect } from 'vitest'
import { MemoryHealth } from '../../src/memory/health.js'
import { LettaAdapter } from '../../src/memory/letta-adapter.js'
import { CodebaseMemoryAdapter } from '../../src/memory/codebase-memory-adapter.js'
import { GeminiEmbedder } from '../../src/memory/gemini-embedder.js'

describe('M2: MemoryHealth — graceful degradation', () => {
  it('all healthy: reports ok:true for every backend', async () => {
    const health = new MemoryHealth({
      store: new LettaAdapter({ mock: true }),
      codebase: new CodebaseMemoryAdapter({ mock: true }),
      embedder: new GeminiEmbedder({ mock: true, apiKey: 'mock' }),
    })
    const report = await health.check()
    expect(report.ok).toBe(true)
    expect(report.letta.ok).toBe(true)
    expect(report.codebase.ok).toBe(true)
    expect(report.embedder.ok).toBe(true)
  })

  it('letta down: overall ok:false, no crash', async () => {
    const brokenStore = new LettaAdapter({ mock: false, baseUrl: 'http://localhost:19996' })
    const health = new MemoryHealth({
      store: brokenStore,
      codebase: new CodebaseMemoryAdapter({ mock: true }),
      embedder: new GeminiEmbedder({ mock: true, apiKey: 'mock' }),
    })
    const report = await health.check()
    expect(report.ok).toBe(false)
    expect(report.letta.ok).toBe(false)
    // codebase + embedder still report individually
    expect(report.codebase.ok).toBe(true)
    expect(report.embedder.ok).toBe(true)
  })

  it('embedder down: overall ok:false, no crash', async () => {
    const brokenEmbed = new GeminiEmbedder({ mock: false, apiKey: 'x', baseUrl: 'http://localhost:19995' })
    const health = new MemoryHealth({
      store: new LettaAdapter({ mock: true }),
      codebase: new CodebaseMemoryAdapter({ mock: true }),
      embedder: brokenEmbed,
    })
    const report = await health.check()
    expect(report.ok).toBe(false)
    expect(report.embedder.ok).toBe(false)
  })

  it('codebase-memory MCP down: overall ok:false, no crash', async () => {
    const brokenCB = new CodebaseMemoryAdapter({ mock: false, baseUrl: 'http://localhost:19994' })
    const health = new MemoryHealth({
      store: new LettaAdapter({ mock: true }),
      codebase: brokenCB,
      embedder: new GeminiEmbedder({ mock: true, apiKey: 'mock' }),
    })
    const report = await health.check()
    expect(report.ok).toBe(false)
    expect(report.codebase.ok).toBe(false)
  })

  it('all down: reports ok:false but does not throw', async () => {
    const health = new MemoryHealth({
      store: new LettaAdapter({ mock: false, baseUrl: 'http://localhost:19993' }),
      codebase: new CodebaseMemoryAdapter({ mock: false, baseUrl: 'http://localhost:19992' }),
      embedder: new GeminiEmbedder({ mock: false, apiKey: 'x', baseUrl: 'http://localhost:19991' }),
    })
    // Must not throw
    const report = await health.check()
    expect(report.ok).toBe(false)
  })
})
