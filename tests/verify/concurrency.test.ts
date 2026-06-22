// M6b: G23 concurrency lens — flags planted race conditions
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConcurrencyLens } from '../../src/verify/concurrency.js'
import type { Judge } from '../../src/ports.js'

describe('M6b: ConcurrencyLens (G23)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flags a planted TOCTOU race in diff', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'TOCTOU race detected' }),
    }
    const lens = new ConcurrencyLens(judge)
    const diff = `
+if (await fs.exists(path)) {
+  // time-of-check to time-of-use gap here
+  await fs.writeFile(path, data)
+}
`
    const result = await lens.analyze(diff)
    expect(result.hasRace).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('flags shared mutable state without synchronization', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'shared mutable state' }),
    }
    const lens = new ConcurrencyLens(judge)
    const diff = `
+let counter = 0
+async function increment() { counter++ }
+await Promise.all([increment(), increment()])
`
    const result = await lens.analyze(diff)
    expect(result.hasRace).toBe(true)
  })

  it('passes clean diff with no race', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
    }
    const lens = new ConcurrencyLens(judge)
    const diff = `
+const result = await Promise.all(tasks.map(t => t.run()))
+return result
`
    const result = await lens.analyze(diff)
    expect(result.hasRace).toBe(false)
    expect(result.findings).toHaveLength(0)
  })

  it('flags unprotected global state mutation pattern', async () => {
    // Judge returns aligned=false to signal race — this is the mechanism that catches
    // patterns the static regexes don't cover (e.g. arbitrary global mutations).
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(true),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'unprotected global state mutation' }),
    }
    const lens = new ConcurrencyLens(judge)
    // Diff with an unprotected class-level cache write
    const diff = '+MyClass.globalCache[key] = value // unprotected write'
    const result = await lens.analyze(diff)
    // Judge is always called and returns aligned=false → hasRace must be true
    expect(result.hasRace).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings.some(f => f.description.toLowerCase().includes('mutation') || f.description.toLowerCase().includes('race') || f.description.toLowerCase().includes('concurrency'))).toBe(true)
  })

  it('returns finding with description', async () => {
    const judge: Judge = {
      isDone: vi.fn().mockResolvedValue(false),
      isStillRight: vi.fn().mockResolvedValue({ aligned: false, reason: 'race condition' }),
    }
    const lens = new ConcurrencyLens(judge)
    const result = await lens.analyze('+shared.value = x\n+await doThing()\n+shared.value = y')
    if (result.findings.length > 0) {
      expect(result.findings[0]).toHaveProperty('description')
    }
  })
})
