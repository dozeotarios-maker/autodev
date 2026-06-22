// M2 Embedder port tests — Gemini default + Ollama qwen3 fallback (D1: failing first)
// G12: uses mock HTTP client; no real Gemini/Ollama calls.
import { describe, it, expect, beforeEach } from 'vitest'
import { GeminiEmbedder } from '../../src/memory/gemini-embedder.js'
import { OllamaEmbedder } from '../../src/memory/ollama-embedder.js'
import type { Embedder } from '../../src/ports.js'

describe('M2: GeminiEmbedder — cloud default', () => {
  let embedder: Embedder

  beforeEach(() => {
    embedder = new GeminiEmbedder({ mock: true, apiKey: 'mock-key' })
  })

  it('satisfies Embedder port shape', () => {
    expect(typeof embedder.embed).toBe('function')
    expect(typeof embedder.healthCheck).toBe('function')
  })

  it('embed returns a vector per input text', async () => {
    const vecs = await embedder.embed(['hello world', 'foo bar'])
    expect(vecs.length).toBe(2)
    expect(vecs[0].length).toBeGreaterThan(0)
    expect(vecs[1].length).toBeGreaterThan(0)
  })

  it('embed returns consistent dimension across texts', async () => {
    const vecs = await embedder.embed(['text one', 'text two', 'text three'])
    const dim = vecs[0].length
    expect(vecs.every(v => v.length === dim)).toBe(true)
  })

  it('embed values are numbers (not NaN)', async () => {
    const vecs = await embedder.embed(['test'])
    expect(vecs[0].every(n => typeof n === 'number' && !Number.isNaN(n))).toBe(true)
  })

  it('healthCheck returns ok:true in mock mode', async () => {
    const health = await embedder.healthCheck()
    expect(health.ok).toBe(true)
  })

  it('healthCheck degrades gracefully if Gemini unreachable', async () => {
    const broken = new GeminiEmbedder({ mock: false, apiKey: 'bad-key', baseUrl: 'http://localhost:19998' })
    const health = await broken.healthCheck()
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
  })
})

describe('M2: OllamaEmbedder — local qwen3 fallback', () => {
  let embedder: Embedder

  beforeEach(() => {
    embedder = new OllamaEmbedder({ mock: true, model: 'qwen3-embedding:0.6b' })
  })

  it('satisfies Embedder port shape', () => {
    expect(typeof embedder.embed).toBe('function')
    expect(typeof embedder.healthCheck).toBe('function')
  })

  it('embed returns vectors in offline/mock mode', async () => {
    const vecs = await embedder.embed(['offline text'])
    expect(vecs.length).toBe(1)
    expect(vecs[0].length).toBeGreaterThan(0)
  })

  it('healthCheck returns ok:true in mock mode', async () => {
    const h = await embedder.healthCheck()
    expect(h.ok).toBe(true)
  })

  it('healthCheck returns ok:false + details if Ollama unreachable (graceful degrade)', async () => {
    const broken = new OllamaEmbedder({ mock: false, baseUrl: 'http://localhost:19997' })
    const h = await broken.healthCheck()
    expect(h.ok).toBe(false)
    expect(typeof h.details).toBe('string')
  })
})
