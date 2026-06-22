// M2 — Letta adapter implementing the MemoryStore port.
// G12: In production, calls the Letta HTTP API (Apache-2.0, SQLite default).
//      In mock mode, uses an in-memory store for tests — real-or-mocked boundary.
// Real dep at integration: letta-client (official Letta JS SDK) or plain fetch to localhost:8283.
import type { MemoryStore } from '../ports.js'

interface LettaAdapterOptions {
  mock?: boolean
  baseUrl?: string
  agentId?: string
}

interface StoredFact {
  key: string
  value: string
  storedAt: number
}

// Minimal in-memory contradiction detection: two or more distinct values for the same key = conflict.
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

class MockLettaStore {
  private facts: StoredFact[] = []

  store(key: string, value: string): void {
    this.facts.push({ key, value, storedAt: Date.now() })
  }

  recall(query: string, limit: number): Array<{ key: string; value: string; score: number }> {
    // Simple substring match on key or value; score based on match quality.
    const matched = this.facts.filter(
      f => f.key.includes(query) || f.value.includes(query) || query.includes(f.key)
    )
    // Deduplicate by keeping all but score higher for exact key matches.
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

export class LettaAdapter implements MemoryStore {
  private readonly mock: boolean
  private readonly baseUrl: string
  private readonly agentId: string
  private mockStore: MockLettaStore | null = null

  constructor(opts: LettaAdapterOptions = {}) {
    this.mock = opts.mock ?? false
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8283'
    this.agentId = opts.agentId ?? 'autodev-default'
    if (this.mock) {
      this.mockStore = new MockLettaStore()
    }
  }

  async store(key: string, value: string, _metadata?: Record<string, unknown>): Promise<void> {
    if (this.mock && this.mockStore) {
      this.mockStore.store(key, value)
      return
    }
    // Production: POST to Letta agent memory endpoint.
    // NOTE: real dep = letta HTTP API at this.baseUrl
    const url = `${this.baseUrl}/v1/agents/${this.agentId}/memory/messages`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: `[${key}] ${value}` }),
    })
    if (!response.ok) {
      throw new Error(`Letta store failed: ${response.status} ${await response.text()}`)
    }
  }

  async recall(
    query: string,
    limit = 10
  ): Promise<Array<{ key: string; value: string; score: number }>> {
    if (this.mock && this.mockStore) {
      return this.mockStore.recall(query, limit)
    }
    // Production: GET Letta archival memory search.
    const url = `${this.baseUrl}/v1/agents/${this.agentId}/archival?query=${encodeURIComponent(query)}&limit=${limit}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Letta recall failed: ${response.status}`)
    }
    const data = (await response.json()) as Array<{ id: string; text: string; score?: number }>
    return data.map(d => ({
      key: d.id,
      value: d.text,
      score: d.score ?? 0.5,
    }))
  }

  async detectContradictions(
    key: string
  ): Promise<Array<{ a: string; b: string; conflictFlag: boolean }>> {
    if (this.mock && this.mockStore) {
      return this.mockStore.detectContradictions(key)
    }
    // Production: recall all facts for key, then run local conflict detection.
    const results = await this.recall(key, 50)
    const values = results.map(r => r.value)
    return detectConflict(values)
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      const url = `${this.baseUrl}/v1/health`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return { ok: true }
      return { ok: false, details: `HTTP ${response.status}` }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }
}
