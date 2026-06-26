// S2-M6 — LettaAdapter contract + unit tests (D1: test-first).
// Covers: mock path (store/recall/contradiction/health) + real-HTTP contract
// (correct Letta v1 endpoints verified live against the real API, June 2026).
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { LettaAdapter } from '../../src/memory/letta-adapter.js'
import type { MemoryStore } from '../../src/ports.js'

// ─── Mock path tests ──────────────────────────────────────────────────────────

describe('S2-M6: LettaAdapter — mock path (MemoryStore port)', () => {
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

  it('contradiction-detect: same key with conflicting values flags conflict', async () => {
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
    expect(health.details).toBe('mock mode')
  })

  it('LETTA_MOCK=1 env var activates mock mode without explicit option', async () => {
    const orig = process.env['LETTA_MOCK']
    process.env['LETTA_MOCK'] = '1'
    try {
      const adapter = new LettaAdapter()
      // If mock is active, healthCheck won't hit the network.
      await expect(adapter.healthCheck()).resolves.toMatchObject({ ok: true })
    } finally {
      if (orig === undefined) delete process.env['LETTA_MOCK']
      else process.env['LETTA_MOCK'] = orig
    }
  })
})

// ─── agentId validation (path-injection / SSRF guard) ────────────────────────

describe('S2-M6: LettaAdapter — agentId validation', () => {
  it('accepts a valid alphanumeric agentId', () => {
    expect(() => new LettaAdapter({ mock: true, agentId: 'agent-test-001' })).not.toThrow()
    expect(() => new LettaAdapter({ mock: true, agentId: 'autodev_default' })).not.toThrow()
    expect(() => new LettaAdapter({ mock: true, agentId: 'ABC123' })).not.toThrow()
  })

  it('rejects agentId containing path traversal (../)', () => {
    expect(() => new LettaAdapter({ mock: true, agentId: '../etc/passwd' })).toThrow(/Invalid agentId/)
  })

  it('rejects agentId containing a slash', () => {
    expect(() => new LettaAdapter({ mock: true, agentId: 'foo/bar' })).toThrow(/Invalid agentId/)
  })

  it('rejects agentId containing a space', () => {
    expect(() => new LettaAdapter({ mock: true, agentId: 'bad id' })).toThrow(/Invalid agentId/)
  })

  it('rejects agentId containing special chars (%20, @)', () => {
    expect(() => new LettaAdapter({ mock: true, agentId: 'id%20evil' })).toThrow(/Invalid agentId/)
    expect(() => new LettaAdapter({ mock: true, agentId: 'id@host' })).toThrow(/Invalid agentId/)
  })
})

// ─── Contract tests — correct real Letta v1 HTTP endpoints ──────────────────
//
// These tests intercept `fetch` to verify the adapter hits EXACTLY the right
// Letta v1 REST endpoints with the right method + body shape.
// They do NOT need a real Letta server; they use a fetch mock that records calls
// and returns a realistic recorded response shape.

describe('S2-M6: LettaAdapter — contract tests (real HTTP endpoint shape)', () => {
  const BASE = 'http://localhost:8283'
  const AGENT_ID = 'agent-test-001'

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('store hits POST /v1/agents/{id}/archival-memory with body { text: "[key] value" }', async () => {
    // Recorded real Letta v1 response shape for archival-memory insert (array)
    const passage = {
      id: 'passage-abc123',
      text: '[mykey] myvalue',
      score: null,
      embedding: [],
      metadata_: {},
    }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [passage],
      text: async () => JSON.stringify([passage]),
    })

    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    await adapter.store('mykey', 'myvalue')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]

    // Correct endpoint: archival-memory (not archival)
    expect(url).toBe(`${BASE}/v1/agents/${AGENT_ID}/archival-memory`)
    expect(options.method).toBe('POST')

    // Body must be JSON with { text: "[key] value" }
    const body = JSON.parse(options.body as string) as { text: string }
    expect(body.text).toBe('[mykey] myvalue')

    // Content-Type header
    const headers = options.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('recall hits GET /v1/agents/{id}/archival-memory/search?query=...&limit=N', async () => {
    // Recorded real Letta v1 search response shape
    const searchResponse = {
      results: [
        { id: 'p1', content: 'result one', timestamp: '2026-06-26T07:00:00Z', tags: [] },
        { id: 'p2', content: 'result two', timestamp: '2026-06-26T07:01:00Z', tags: [] },
      ],
      count: 2,
    }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => searchResponse,
    })

    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const results = await adapter.recall('test-query', 5)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]

    // Correct endpoint: archival-memory/search (not archival)
    expect(url).toContain(`${BASE}/v1/agents/${AGENT_ID}/archival-memory/search`)
    expect(url).toContain('query=test-query')
    expect(url).toContain('limit=5')

    // Response mapping: id→key, content→value, score defaults to 0.5
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ key: 'p1', value: 'result one', score: 0.5 })
    expect(results[1]).toEqual({ key: 'p2', value: 'result two', score: 0.5 })
  })

  it('recall defaults score to 0.5 (search endpoint has no score field)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: 'p1', content: 'some text' }], count: 1 }),
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const results = await adapter.recall('q')
    expect(results[0].score).toBe(0.5)
  })

  it('healthCheck hits GET /v1/health and maps status=ok → ok:true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    })

    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const health = await adapter.healthCheck()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/v1/health`)
    expect(health.ok).toBe(true)
  })

  it('healthCheck maps status=degraded → ok:false with details', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'degraded' }),
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const health = await adapter.healthCheck()
    expect(health.ok).toBe(false)
    expect(health.details).toContain('degraded')
  })

  it('healthCheck returns ok:false on HTTP error (no throw)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'Service Unavailable',
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const health = await adapter.healthCheck()
    expect(health.ok).toBe(false)
    expect(health.details).toContain('503')
  })

  it('healthCheck returns ok:false on network error (no throw)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const health = await adapter.healthCheck()
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
  })

  it('store throws on non-ok HTTP response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    await expect(adapter.store('k', 'v')).rejects.toThrow('Letta store failed')
  })

  it('Authorization header sent when token provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID, token: 'tok-secret' })
    await adapter.healthCheck()

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = options.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok-secret')
  })

  it('contradiction detection works on real recalled passages', async () => {
    // Search returns two passages with different content → conflict
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: 'p1', content: 'service X uses REST' },
          { id: 'p2', content: 'service X uses gRPC' },
        ],
        count: 2,
      }),
    })
    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: AGENT_ID })
    const conflicts = await adapter.detectContradictions('auth-method')
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0].conflictFlag).toBe(true)
  })
})

// ─── ensureAgent tests (stubbed fetch, no live server) ───────────────────────

describe('S2-M6: LettaAdapter — ensureAgent (stubbed fetch)', () => {
  const BASE = 'http://localhost:8283'

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ensureAgent finds existing agent by name and caches its id', async () => {
    // GET /v1/agents/ returns a list including our named agent
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'agent-existing-001', name: 'pi-autodev-memory' },
        { id: 'agent-other-002', name: 'other-agent' },
      ],
    })
    // GET /v1/agents/{id}/archival-memory/search for recall
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [], count: 0 }),
    })

    const adapter = new LettaAdapter({ baseUrl: BASE })
    await adapter.recall('anything')

    // First call: list agents
    const [listUrl] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(listUrl).toBe(`${BASE}/v1/agents/`)

    // Second call: search uses the resolved id
    const [searchUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(searchUrl).toContain('agent-existing-001')
  })

  it('ensureAgent creates agent when none found by name', async () => {
    // GET /v1/agents/ returns empty list
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    })
    // POST /v1/agents/ creates agent
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'agent-newly-created-999', name: 'pi-autodev-memory' }),
    })
    // store POST to archival-memory
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 'p1', text: '[k] v' }],
      text: async () => '',
    })

    const adapter = new LettaAdapter({ baseUrl: BASE })
    await adapter.store('k', 'v')

    // list, create, store
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const [createUrl, createOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(createUrl).toBe(`${BASE}/v1/agents/`)
    const createBody = JSON.parse(createOpts.body as string) as { name: string; model: string }
    expect(createBody.name).toBe('pi-autodev-memory')
    expect(createBody.model).toBe('letta/letta-free')

    // store uses the newly-created id
    const [storeUrl] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(storeUrl).toContain('agent-newly-created-999')
  })

  it('ensureAgent caches resolved id — second call does not re-list', async () => {
    // First ensureAgent: list → found
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 'agent-cached-123', name: 'pi-autodev-memory' }],
    })
    // store call 1
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    })
    // store call 2 (no extra ensureAgent list call)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    })

    const adapter = new LettaAdapter({ baseUrl: BASE })
    await adapter.store('k1', 'v1')
    await adapter.store('k2', 'v2')

    // Only 3 calls total: 1 list + 2 stores (not 2 lists)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ensureAgent is bypassed when static agentId is provided', async () => {
    // store hits archival-memory directly, no list/create calls
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    })

    const adapter = new LettaAdapter({ baseUrl: BASE, agentId: 'static-agent-id' })
    await adapter.store('k', 'v')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('static-agent-id')
    // Must go straight to archival-memory, not to the agent list/create endpoint
    expect(url).toContain('/archival-memory')
    expect(url).not.toBe(`${BASE}/v1/agents/`)
  })
})
