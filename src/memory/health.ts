// M2 — Two-plane memory health aggregator.
// Checks Letta (Layer-B), codebase-memory-mcp (Layer-A), and the active Embedder.
// Degrades gracefully: each backend fails independently; never throws.
import type { MemoryStore, Embedder } from '../ports.js'
import type { CodebaseMemoryAdapter } from './codebase-memory-adapter.js'

export interface HealthReport {
  ok: boolean
  letta: { ok: boolean; details?: string }
  codebase: { ok: boolean; details?: string }
  embedder: { ok: boolean; details?: string }
}

export interface MemoryHealthDeps {
  store: MemoryStore
  codebase: CodebaseMemoryAdapter
  embedder: Embedder
}

export class MemoryHealth {
  private readonly deps: MemoryHealthDeps

  constructor(deps: MemoryHealthDeps) {
    this.deps = deps
  }

  async check(): Promise<HealthReport> {
    // Run all three checks in parallel; never let one throw propagate.
    const [letta, codebase, embedder] = await Promise.all([
      this.deps.store.healthCheck().catch((err: unknown) => ({
        ok: false,
        details: String(err),
      })),
      this.deps.codebase.healthCheck().catch((err: unknown) => ({
        ok: false,
        details: String(err),
      })),
      this.deps.embedder.healthCheck().catch((err: unknown) => ({
        ok: false,
        details: String(err),
      })),
    ])

    const ok = letta.ok && codebase.ok && embedder.ok
    return { ok, letta, codebase, embedder }
  }
}
