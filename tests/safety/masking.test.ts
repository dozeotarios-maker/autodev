// M1 masking test — written FIRST (D1)
import { describe, it, expect } from 'vitest'
import { ObservationMasker } from '../../src/safety/masking.js'

function makeToolResult(id: number) {
  return { role: 'tool', content: `result ${id}`, type: 'tool_result', toolName: 'bash' }
}

function makeUserMsg(id: number) {
  return { role: 'user', content: `user message ${id}` }
}

describe('M1: G9 observation masking', () => {
  it('returns messages unchanged when count <= maxToolResults', () => {
    const masker = new ObservationMasker(5)
    const msgs = [makeToolResult(1), makeToolResult(2), makeToolResult(3)]
    const out = masker.mask(msgs)
    expect(out).toHaveLength(3)
    expect(out[0].content).toBe('result 1')
    expect(out[1].content).toBe('result 2')
  })

  it('masks oldest tool results when count exceeds maxToolResults', () => {
    const masker = new ObservationMasker(2)
    const msgs = [makeToolResult(1), makeToolResult(2), makeToolResult(3)]
    const out = masker.mask(msgs)
    expect(out[0].content).toBe('[masked — observation window]')
    expect(out[1].content).toBe('result 2')
    expect(out[2].content).toBe('result 3')
  })

  it('preserves non-tool messages untouched', () => {
    const masker = new ObservationMasker(1)
    const msgs = [makeUserMsg(1), makeToolResult(1), makeUserMsg(2), makeToolResult(2)]
    const out = masker.mask(msgs)
    expect(out[0].content).toBe('user message 1')
    expect(out[2].content).toBe('user message 2')
    expect(out[1].content).toBe('[masked — observation window]')
    expect(out[3].content).toBe('result 2')
  })

  it('keeps last N tool results, masks earlier ones', () => {
    const masker = new ObservationMasker(3)
    const msgs = Array.from({ length: 6 }, (_, i) => makeToolResult(i + 1))
    const out = masker.mask(msgs)
    // First 3 masked, last 3 kept
    expect(out[0].content).toBe('[masked — observation window]')
    expect(out[1].content).toBe('[masked — observation window]')
    expect(out[2].content).toBe('[masked — observation window]')
    expect(out[3].content).toBe('result 4')
    expect(out[4].content).toBe('result 5')
    expect(out[5].content).toBe('result 6')
  })
})
