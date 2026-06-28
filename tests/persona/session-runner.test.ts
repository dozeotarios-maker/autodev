import { describe, it, expect } from 'vitest'
import { extractAssistantText, classifyFailure } from '../../src/persona/session-runner.js'

describe('extractAssistantText', () => {
  it('joins text parts and ignores thinking parts', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm let me consider' },
          { type: 'text', text: '["objection one"' },
          { type: 'text', text: ', "objection two"]' },
        ],
      },
    ]
    expect(extractAssistantText(messages).text).toBe('["objection one", "objection two"]')
  })

  it('returns the LAST assistant message when several exist', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]
    expect(extractAssistantText(messages).text).toBe('second')
  })

  it('surfaces stopReason and errorMessage', () => {
    const messages = [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom 429' }]
    const r = extractAssistantText(messages)
    expect(r.text).toBe('')
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toBe('boom 429')
  })

  it('returns empty when no assistant message', () => {
    expect(extractAssistantText([{ role: 'user', content: [] }]).text).toBe('')
    expect(extractAssistantText([]).text).toBe('')
  })
})

describe('classifyFailure', () => {
  it('maps quota/429 to rate_limit', () => {
    expect(classifyFailure('error', '{"error":{"code":429,"message":"quota exceeded"}}')).toBe('rate_limit')
    expect(classifyFailure(undefined, 'RESOURCE_EXHAUSTED')).toBe('rate_limit')
  })

  it('maps network errors to unavailable', () => {
    expect(classifyFailure(undefined, 'fetch failed')).toBe('unavailable')
    expect(classifyFailure(undefined, 'ETIMEDOUT')).toBe('unavailable')
  })

  it('maps a bare error stopReason to error', () => {
    expect(classifyFailure('error', 'something odd')).toBe('error')
  })

  it('returns undefined for a clean stop', () => {
    expect(classifyFailure('stop', undefined)).toBeUndefined()
    expect(classifyFailure(undefined, undefined)).toBeUndefined()
  })
})
