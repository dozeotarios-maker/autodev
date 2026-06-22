// M2 — Gemini embedding adapter implementing the Embedder port.
// Default cloud embedder: Google Gemini embedding-001 (strong free tier, high limits).
// G12: mock mode returns deterministic pseudo-vectors; real boundary is Gemini REST API.
// Real dep at integration: @google/generative-ai SDK or plain fetch to generativelanguage.googleapis.com.
import type { Embedder } from '../ports.js'

interface GeminiEmbedderOptions {
  mock?: boolean
  apiKey?: string
  baseUrl?: string
  model?: string
  dimensions?: number
}

// Deterministic mock vector: hash-based pseudo-embedding, consistent across calls.
function mockEmbed(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += (text.charCodeAt(i) / 255) * 0.1
  }
  // Normalise to unit length.
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / mag)
}

export class GeminiEmbedder implements Embedder {
  private readonly mock: boolean
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly dimensions: number

  constructor(opts: GeminiEmbedderOptions = {}) {
    this.mock = opts.mock ?? false
    this.apiKey = opts.apiKey ?? ''
    // Official Gemini REST endpoint (verified June 2026: generativelanguage.googleapis.com/v1beta)
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com'
    this.model = opts.model ?? 'text-embedding-004'
    // gemini-embedding-001 / text-embedding-004 outputs 768-dimensional vectors.
    this.dimensions = opts.dimensions ?? 768
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.mock) {
      return texts.map(t => mockEmbed(t, this.dimensions))
    }
    // Production: Gemini batchEmbedContents endpoint.
    const url = `${this.baseUrl}/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`
    const body = {
      requests: texts.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      })),
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      throw new Error(`Gemini embed failed: ${response.status} ${await response.text()}`)
    }
    const data = (await response.json()) as {
      embeddings: Array<{ values: number[] }>
    }
    return data.embeddings.map(e => e.values)
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      // Probe with a minimal single-text embedding.
      await this.embed(['health-check'])
      return { ok: true }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }
}
