// M2 — Ollama local embedding adapter — offline/private fallback for the Embedder port.
// Default model: qwen3-embedding:0.6b (local Ollama, no cloud egress).
// G12: mock mode returns deterministic pseudo-vectors; real boundary is Ollama REST API.
// Real dep at integration: Ollama running locally (ollama.ai, MIT licence).
import type { Embedder } from '../ports.js'

interface OllamaEmbedderOptions {
  mock?: boolean
  baseUrl?: string
  model?: string
  dimensions?: number
}

// Same deterministic hash-based mock as GeminiEmbedder (consistent across adapters).
function mockEmbed(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += (text.charCodeAt(i) / 255) * 0.1
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / mag)
}

export class OllamaEmbedder implements Embedder {
  private readonly mock: boolean
  private readonly baseUrl: string
  private readonly model: string
  private readonly dimensions: number

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.mock = opts.mock ?? false
    this.baseUrl = opts.baseUrl ?? 'http://localhost:11434'
    this.model = opts.model ?? 'qwen3-embedding:0.6b'
    // qwen3-embedding:0.6b outputs 1024-dimensional vectors.
    this.dimensions = opts.dimensions ?? 1024
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.mock) {
      return texts.map(t => mockEmbed(t, this.dimensions))
    }
    // Production: Ollama /api/embed endpoint (batch-capable from Ollama 0.2+).
    const url = `${this.baseUrl}/api/embed`
    const results: number[][] = []
    for (const text of texts) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`)
      }
      const data = (await response.json()) as { embeddings: number[][] }
      results.push(data.embeddings[0])
    }
    return results
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      const url = `${this.baseUrl}/api/tags`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) {
        return { ok: false, details: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { models?: Array<{ name: string }> }
      const hasModel = data.models?.some(m => m.name.startsWith(this.model.split(':')[0])) ?? false
      if (!hasModel) {
        return {
          ok: false,
          details: `Model ${this.model} not found in Ollama. Run: ollama pull ${this.model}`,
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }
}
