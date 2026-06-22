// M6b: AI-slop humanizer — detects AI-slop patterns + LLM critic for prose
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Humanizer } from '../../src/verify/humanizer.js'
import type { Judge } from '../../src/ports.js'

describe('M6b: Humanizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flags known AI-slop phrases', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const h = new Humanizer(judge)
    const result = await h.analyze(
      'Certainly! As an AI language model, I would be happy to help you with that. ' +
        'In conclusion, leveraging synergies is paramount.'
    )
    expect(result.slopDetected).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('returns clean for normal prose', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const h = new Humanizer(judge)
    const result = await h.analyze('The login function validates the token and returns a session.')
    expect(result.slopDetected).toBe(false)
    expect(result.findings).toHaveLength(0)
  })

  it('calls LLM critic for prose quality check', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false), // critic says prose is poor
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const h = new Humanizer(judge)
    const result = await h.analyze('It is important to note that the implementation leverages cutting-edge technology.')
    // isDone used as critic: false = prose is AI-slop quality
    expect(judge.isDone).toHaveBeenCalled()
    expect(result.slopDetected).toBe(true)
  })

  it('folds into review findings list', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const h = new Humanizer(judge)
    const result = await h.analyze('Certainly! I would be happy to assist.')
    // findings should be ReviewFindings-compatible
    expect(Array.isArray(result.findings)).toBe(true)
    if (result.findings.length > 0) {
      expect(result.findings[0]).toHaveProperty('severity')
      expect(result.findings[0]).toHaveProperty('description')
    }
  })

  it('detects "as an AI" pattern', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const h = new Humanizer(judge)
    const result = await h.analyze('As an AI, I cannot perform that action.')
    expect(result.slopDetected).toBe(true)
  })
})
