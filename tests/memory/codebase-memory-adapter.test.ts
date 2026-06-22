// M2 Layer-A codebase-memory adapter tests (D1: failing first)
// G12: real-or-mocked boundary — uses mock MCP client.
import { describe, it, expect, beforeEach } from 'vitest'
import { CodebaseMemoryAdapter } from '../../src/memory/codebase-memory-adapter.js'

describe('M2: CodebaseMemoryAdapter — Layer-A codebase graph', () => {
  let adapter: CodebaseMemoryAdapter

  beforeEach(() => {
    adapter = new CodebaseMemoryAdapter({ mock: true })
  })

  it('exposes findCallers method', () => {
    expect(typeof adapter.findCallers).toBe('function')
  })

  it('findCallers returns cross-file callers for a known symbol', async () => {
    // In mock mode, the adapter uses a pre-seeded in-memory call graph.
    const callers = await adapter.findCallers('processPayment')
    expect(Array.isArray(callers)).toBe(true)
    expect(callers.length).toBeGreaterThan(0)
    // Each caller entry has file + line
    expect(callers[0]).toHaveProperty('file')
    expect(callers[0]).toHaveProperty('line')
    // Cross-file: callers come from a different file than the definition
    const uniqueFiles = new Set(callers.map(c => c.file))
    expect(uniqueFiles.size).toBeGreaterThanOrEqual(1)
  })

  it('findCallers returns empty array for unknown symbol', async () => {
    const callers = await adapter.findCallers('__totally_unknown_symbol__')
    expect(callers).toEqual([])
  })

  it('healthCheck returns ok in mock mode', async () => {
    const health = await adapter.healthCheck()
    expect(health.ok).toBe(true)
  })

  it('healthCheck degrades gracefully if MCP is down (offline mode)', async () => {
    const offline = new CodebaseMemoryAdapter({ mock: false, baseUrl: 'http://localhost:19999' })
    const health = await offline.healthCheck()
    // Must NOT throw — must return ok:false with details
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
  })
})
