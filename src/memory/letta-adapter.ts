// S2-M6 — Letta adapter implementing the MemoryStore port.
// Corrected real Letta v1 HTTP REST API (not the Stage-1 guesses).
// Real Letta v1 endpoints (verified against Letta OpenAPI spec, June 2026):
//   POST   /v1/agents/{agent_id}/archival          — insert a passage (store)
//   GET    /v1/agents/{agent_id}/archival           — search passages (recall)
//   GET    /v1/health                              — liveness probe
// Mock path: set LETTA_MOCK=1 env var OR pass { mock: true } to constructor.
import type { MemoryStore } from '../ports.js'

// ─── Letta v1 response shapes ───────────────────────────────────────────────

// POST /v1/agents/{id}/archival → Passage
interface LettaPassage {
  id: string
  text: string
  score?: number
  embedding?: number[]
  metadata_?: Record<string, unknown>
}

// GET /v1/agents/{id}/archival → Passage[]  (array, not wrapped object)
type LettaArchivalResponse = LettaPassage[]

// GET /v1/health → { status: "ok" | "degraded" }
interface LettaHealthResponse {
  status: string
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface LettaAdapterOptions {
  mock?: boolean
  baseUrl?: string
  agentId?: string
  /** Optional bearer token for Letta Cloud or authenticated deployments. */
  token?: string
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
  private readonly agentId: string
  private readonly token: string | undefined
  private mockStore: MockLettaStore | null = null

  constructor(opts: LettaAdapterOptions = {}) {
    this.mock = opts.mock ?? process.env['LETTA_MOCK'] === '1'
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8283'
    const agentId = opts.agentId ?? 'autodev-default'
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      throw new Error(`Invalid agentId "${agentId}": must match /^[a-zA-Z0-9_-]+$/`)
    }
    this.agentId = agentId
    this.token = opts.token
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
   * Store a fact under a key.
   * Real path: POST /v1/agents/{agent_id}/archival
   * Body: { text: "[key] value" }
   * Returns the created Passage object; we discard it.
   */
  async store(key: string, value: string, _metadata?: Record<string, unknown>): Promise<void> {
    if (this.mock && this.mockStore) {
      this.mockStore.store(key, value)
      return
    }
    const url = `${this.baseUrl}/v1/agents/${this.agentId}/archival`
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text: `[${key}] ${value}` }),
    })
    if (!response.ok) {
      throw new Error(`Letta store failed: ${response.status} ${await response.text()}`)
    }
  }

  /**
   * Retrieve facts matching a query.
   * Real path: GET /v1/agents/{agent_id}/archival?query=...&limit=N
   * Returns Passage[] (array directly, not wrapped).
   */
  async recall(
    query: string,
    limit = 10
  ): Promise<Array<{ key: string; value: string; score: number }>> {
    if (this.mock && this.mockStore) {
      return this.mockStore.recall(query, limit)
    }
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    })
    const url = `${this.baseUrl}/v1/agents/${this.agentId}/archival?${params.toString()}`
    const response = await fetch(url, { headers: this.headers() })
    if (!response.ok) {
      throw new Error(`Letta recall failed: ${response.status}`)
    }
    const passages = (await response.json()) as LettaArchivalResponse
    return passages.map(p => ({
      key: p.id,
      value: p.text,
      score: p.score ?? 0.5,
    }))
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
