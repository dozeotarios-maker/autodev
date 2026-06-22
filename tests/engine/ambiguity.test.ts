import { describe, it, expect } from 'vitest'
import { AmbiguityGate } from '../../src/engine/ambiguity.js'

describe('M3: H7 ambiguity gate', () => {
  it('asks exactly one question on an ambiguous idea', async () => {
    const gate = new AmbiguityGate()
    const result = await gate.evaluate('build something for users')
    expect(result.ambiguous).toBe(true)
    expect(result.questions).toHaveLength(1)
    expect(typeof result.questions[0]).toBe('string')
  })

  it('asks zero questions on a clear, specific idea', async () => {
    const gate = new AmbiguityGate()
    const result = await gate.evaluate(
      'add a /health GET endpoint to src/server.ts that returns { status: "ok", uptime: process.uptime() }'
    )
    expect(result.ambiguous).toBe(false)
    expect(result.questions).toHaveLength(0)
  })

  it('ambiguity threshold: very short ideas are ambiguous', async () => {
    const gate = new AmbiguityGate()
    const result = await gate.evaluate('fix it')
    expect(result.ambiguous).toBe(true)
  })

  it('ambiguity threshold: ideas with 3+ specifics are clear', async () => {
    const gate = new AmbiguityGate()
    // Has: what (endpoint), where (server.ts), how (JSON), expected output
    const result = await gate.evaluate(
      'add a POST /login endpoint in src/auth/server.ts that validates username+password against users table and returns a JWT'
    )
    expect(result.ambiguous).toBe(false)
  })

  it('never batches more than 1 question even on highly ambiguous input', async () => {
    const gate = new AmbiguityGate()
    const result = await gate.evaluate('do something')
    expect(result.questions.length).toBeLessThanOrEqual(1)
  })
})
