// S2-M6 — Letta adapter implementing the MemoryStore port.
// Real Letta v1 endpoints (verified live against localhost:8283, June 2026):
//   POST   /v1/agents/                             — create agent
//   GET    /v1/agents/                             — list agents
//   POST   /v1/agents/{agent_id}/archival-memory   — insert a passage (store)
//   GET    /v1/agents/{agent_id}/archival-memory/search?query=&limit=  — search (recall)
//   GET    /v1/health                              — liveness probe
// Mock path: set LETTA_MOCK=1 env var OR pass { mock: true } to constructor.
import type { MemoryStore } from '../ports.js'

// ─── Letta v1 response shapes ───────────────────────────────────────────────

// POST /v1/agents/{id}/archival-memory → Passage[] (array)
interface LettaPassage {
  id: string
  text?: string
  content?: string
  score?: number
  embedding?: number[]
  metadata_?: Record<string, unknown>
}

// GET /v1/agents/{id}/archival-memory/search → { results: SearchPassage[], count: number }
interface LettaSearchPassage {
  id: string
  content: string
  timestamp?: string
  tags?: string[]
}

interface LettaArchivalSearchResponse {
  results: LettaSearchPassage[]
  count: number
}

// GET /v1/agents/ → AgentState[]
interface LettaAgentState {
  id: string
  name: string
}

// POST /v1/agents/ → AgentState
// (same shape, we only need id + name)

// GET /v1/health → { status: "ok" | "degraded" }
interface LettaHealthResponse {
  status: string
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface LettaAdapterOptions {
  mock?: boolean
  baseUrl?: string
  /**
   * When provided, used directly as the Letta agent id (must be a valid
   * server-issued id or alphanumeric name).  When omitted in real mode,
   * ensureAgent() resolves/creates the stable 'pi-autodev-memory' agent.
   */
  agentId?: string
  /** Optional bearer token for Letta Cloud or authenticated deployments. */
  token?: string
  /** Agent name to resolve/create via ensureAgent(). Default: 'pi-autodev-memory'. */
  agentName?: string
}

// ─── Contradiction detection (shared by mock + real paths) ──────────────────

function detectConflict(
  values: string[]
): Array<{ a: string; b: string; conflictFlag: boolean }> {
  if (values.length < 2) return []
  const conflicts: Array<{ a: string; b: string; conflictFlag: boolean }> = []
  for (let i = 0; i < values.length - 1; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[i] !== values[j]) {
        conflicts.push({ a: values[i], b: values[j], conflictFlag: true })
      }
    }
  }
  return conflicts
}

// ─── In-memory mock store ────────────────────────────────────────────────────

interface StoredFact {
  key: string
  value: string
  storedAt: number
}

class MockLettaStore {
  private facts: StoredFact[] = []

  store(key: string, value: string): void {
    this.facts.push({ key, value, storedAt: Date.now() })
  }

  recall(query: string, limit: number): Array<{ key: string; value: string; score: number }> {
    const matched = this.facts.filter(
      f => f.key.includes(query) || f.value.includes(query) || query.includes(f.key)
    )
    const scored = matched.map(f => ({
      key: f.key,
      value: f.value,
      score: f.key === query ? 1.0 : 0.7,
    }))
    return scored.slice(0, limit)
  }

  detectContradictions(key: string): Array<{ a: string; b: string; conflictFlag: boolean }> {
    const values = this.facts.filter(f => f.key === key).map(f => f.value)
    return detectConflict(values)
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class LettaAdapter implements MemoryStore {
  private readonly mock: boolean
  private readonly baseUrl: string
  private readonly staticAgentId: string | null
  private readonly token: string | undefined
  private readonly agentName: string
  private mockStore: MockLettaStore | null = null
  /** Cached resolved agent id (real mode only). */
  private resolvedAgentId: string | null = null
  /** In-flight ensureAgent promise (prevents double-create race). */
  private agentPromise: Promise<string> | null = null

  constructor(opts: LettaAdapterOptions = {}) {
    this.mock = opts.mock ?? process.env['LETTA_MOCK'] === '1'
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8283'
    this.token = opts.token
    this.agentName = opts.agentName ?? 'pi-autodev-memory'

    if (opts.agentId !== undefined) {
      if (!/^[a-zA-Z0-9_-]+$/.test(opts.agentId)) {
        throw new Error(`Invalid agentId "${opts.agentId}": must match /^[a-zA-Z0-9_-]+$/`)
      }
      this.staticAgentId = opts.agentId
    } else {
      this.staticAgentId = null
    }

    if (this.mock) {
      this.mockStore = new MockLettaStore()
    }
  }

  /** Build common request headers. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`
    }
    return h
  }

  /**
   * Resolve the Letta agent id to use for all archival operations.
   * - If a static agentId was provided to the constructor, use it directly.
   * - Otherwise GET /v1/agents/ to find an agent named this.agentName.
   *   If found, cache and return its id.
   *   If not found, POST /v1/agents/ to create it, cache and return the new id.
   * Result is cached; subsequent calls are free.
   * The in-flight promise is also cached to prevent concurrent first-calls from
   * creating duplicate agents (double-create race condition fix).
   *
   * Note: mock mode ignores agentId/ensureAgent entirely — the MockLettaStore
   * is keyed by key/value directly, not by Letta agent id.
   */
  async ensureAgent(): Promise<string> {
    if (this.staticAgentId !== null) {
      return this.staticAgentId
    }
    if (this.resolvedAgentId !== null) {
      return this.resolvedAgentId
    }
    // Cache the in-flight promise so concurrent callers await the same operation
    // instead of each issuing their own list+create, which would create duplicate agents.
    if (this.agentPromise !== null) {
      return this.agentPromise
    }

    const p = (async () => {
      // List existing agents — use name filter if available, with Array.isArray guard
      // for servers that wrap the list in { agents: [...] }.
      const listUrl = `${this.baseUrl}/v1/agents/?name=${encodeURIComponent(this.agentName)}`
      const listResp = await fetch(listUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      })
      if (!listResp.ok) {
        throw new Error(`Letta ensureAgent list failed: ${listResp.status} ${await listResp.text()}`)
      }
      const rawAgents = await listResp.json()
      // Handle both bare-array and { agents: [...] } response shapes
      const agentList: LettaAgentState[] = Array.isArray(rawAgents)
        ? rawAgents as LettaAgentState[]
        : Array.isArray((rawAgents as { agents?: unknown }).agents)
          ? (rawAgents as { agents: LettaAgentState[] }).agents
          : []
      const existing = agentList.find(a => a.name === this.agentName)
      if (existing) {
        this.resolvedAgentId = existing.id
        return existing.id
      }

      // Create the agent
      const createUrl = `${this.baseUrl}/v1/agents/`
      const createResp = await fetch(createUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: this.agentName, model: 'letta/letta-free' }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!createResp.ok) {
        throw new Error(
          `Letta ensureAgent create failed: ${createResp.status} ${await createResp.text()}`
        )
      }
      const created = (await createResp.json()) as LettaAgentState
      this.resolvedAgentId = created.id
      return created.id
    })()
    // Fix: clear the cached promise on rejection so the next call retries fresh.
    // On success, leave it cached (resolvedAgentId also short-circuits future calls).
    p.catch(() => { this.agentPromise = null })
    this.agentPromise = p
    return p
  }

  /**
   * Store a fact under a key.
   * Real path: POST /v1/agents/{agent_id}/archival-memory
   * Body: { text: "[key] value" }
   * Returns the created Passage array; we discard it.
   */
  async store(key: string, value: string, _metadata?: Record<string, unknown>): Promise<void> {
    if (this.mock && this.mockStore) {
      this.mockStore.store(key, value)
      return
    }
    const agentId = await this.ensureAgent()
    const url = `${this.baseUrl}/v1/agents/${agentId}/archival-memory`
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text: `[${key}] ${value}` }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Letta store failed: ${response.status} ${await response.text()}`)
    }
  }

  /**
   * Retrieve facts matching a query.
   * Real path: GET /v1/agents/{agent_id}/archival-memory/search?query=...&limit=N
   * Returns { results: [{ id, content, timestamp, tags }], count: N }
   */
  async recall(
    query: string,
    limit = 10
  ): Promise<Array<{ key: string; value: string; score: number }>> {
    if (this.mock && this.mockStore) {
      return this.mockStore.recall(query, limit)
    }
    const agentId = await this.ensureAgent()
    // Clamp limit to a sane max and truncate overly-long queries
    const clampedLimit = Math.min(limit, 50)
    const clampedQuery = query.length > 1000 ? query.slice(0, 1000) : query
    const params = new URLSearchParams({
      query: clampedQuery,
      limit: String(clampedLimit),
    })
    const url = `${this.baseUrl}/v1/agents/${agentId}/archival-memory/search?${params.toString()}`
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Letta recall failed: ${response.status}`)
    }
    const body = (await response.json()) as LettaArchivalSearchResponse
    const passages = body.results ?? []
    return passages
      .map(p => ({
        key: p.id,
        // Passages may carry text or content depending on server version
        value: (p as unknown as LettaPassage).content ?? (p as unknown as LettaPassage).text ?? '',
        // Use server-provided score if present; fall back to 0.5
        score: (p as unknown as LettaPassage).score ?? 0.5,
      }))
      .filter(r => r.value !== '')
  }

  /**
   * Detect contradictions for a given key by recalling all stored passages
   * and running local conflict detection.
   */
  async detectContradictions(
    key: string
  ): Promise<Array<{ a: string; b: string; conflictFlag: boolean }>> {
    if (this.mock && this.mockStore) {
      return this.mockStore.detectContradictions(key)
    }
    const results = await this.recall(key, 50)
    const values = results.map(r => r.value)
    return detectConflict(values)
  }

  /**
   * Liveness probe.
   * Real path: GET /v1/health  → { status: "ok" | "degraded" }
   */
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      const url = `${this.baseUrl}/v1/health`
      const response = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) {
        return { ok: false, details: `HTTP ${response.status}` }
      }
      const body = (await response.json()) as LettaHealthResponse
      const ok = body.status === 'ok'
      return { ok, details: ok ? undefined : `status=${body.status}` }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }
}
