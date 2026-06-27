// C-0 Task 0.3: ControllerOptions.codebaseMemory.findCallers widening
import { describe, it, expect, vi } from 'vitest'
import type { ControllerOptions } from '../../src/host/controller.js'

// Verify the type accepts findCallers on codebaseMemory
describe('ControllerOptions.codebaseMemory.findCallers', () => {
  it('ControllerOptions accepts codebaseMemory with findCallers', () => {
    const callers: Array<{ file: string; symbol?: string }> = [
      { file: 'src/foo.ts', symbol: 'bar' },
    ]
    const mem: NonNullable<ControllerOptions['codebaseMemory']> = {
      healthCheck: async () => ({ ok: true }),
      findCallers: async (_sym: string) => callers,
    }
    expect(mem).toBeDefined()
    expect(typeof mem.findCallers).toBe('function')
  })

  it('codebaseMemory without findCallers still satisfies ControllerOptions (optional)', () => {
    const mem: NonNullable<ControllerOptions['codebaseMemory']> = {
      healthCheck: async () => ({ ok: true }),
    }
    expect(mem).toBeDefined()
    expect(mem.findCallers).toBeUndefined()
  })

  it('findCallers on mock resolves to caller list', async () => {
    const expected: Array<{ file: string; symbol?: string }> = [{ file: 'src/a.ts', symbol: 'doThing' }]
    const mem: NonNullable<ControllerOptions['codebaseMemory']> = {
      healthCheck: async () => ({ ok: true }),
      findCallers: vi.fn().mockResolvedValue(expected),
    }
    const result = await mem.findCallers?.('doThing')
    expect(result).toEqual(expected)
  })

  it('optional chaining on undefined findCallers short-circuits to undefined', () => {
    const mem: NonNullable<ControllerOptions['codebaseMemory']> = {
      healthCheck: async () => ({ ok: true }),
    }
    // Simulates: this.opts.codebaseMemory?.findCallers?.(sym)
    const result = mem.findCallers?.('whatever')
    expect(result).toBeUndefined()
  })
})
