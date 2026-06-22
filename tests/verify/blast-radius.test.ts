// M6b: G19 blast-radius — find_callers enumerates callers before a breaking change
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlastRadiusAnalyzer } from '../../src/verify/blast-radius.js'

describe('M6b: BlastRadiusAnalyzer (G19)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns callers for a changed symbol', async () => {
    const mockFindCallers = vi.fn().mockResolvedValue([
      { file: 'src/engine/fsm.ts', line: 42, snippet: 'verifier.runDeterministic(cmd, cwd)' },
      { file: 'src/lanes/runner.ts', line: 7, snippet: 'verifier.runDeterministic(cmd, "/tmp")' },
    ])
    const analyzer = new BlastRadiusAnalyzer(mockFindCallers)
    const result = await analyzer.analyze({
      symbol: 'runDeterministic',
      changeType: 'signature-change',
      cwd: '/tmp/repo',
    })
    expect(result.callers).toHaveLength(2)
    expect(result.callers[0].file).toContain('fsm.ts')
  })

  it('returns empty callers for a private/unexported symbol', async () => {
    const mockFindCallers = vi.fn().mockResolvedValue([])
    const analyzer = new BlastRadiusAnalyzer(mockFindCallers)
    const result = await analyzer.analyze({
      symbol: '_internalHelper',
      changeType: 'removal',
      cwd: '/tmp/repo',
    })
    expect(result.callers).toHaveLength(0)
    expect(result.safe).toBe(true)
  })

  it('marks blast as non-safe when callers > 0', async () => {
    const mockFindCallers = vi.fn().mockResolvedValue([
      { file: 'src/a.ts', line: 1, snippet: 'foo()' },
    ])
    const analyzer = new BlastRadiusAnalyzer(mockFindCallers)
    const result = await analyzer.analyze({
      symbol: 'foo',
      changeType: 'removal',
      cwd: '/tmp/repo',
    })
    expect(result.safe).toBe(false)
    expect(result.callerCount).toBe(1)
  })

  it('calls find_callers with the given symbol', async () => {
    const mockFindCallers = vi.fn().mockResolvedValue([])
    const analyzer = new BlastRadiusAnalyzer(mockFindCallers)
    await analyzer.analyze({ symbol: 'mySymbol', changeType: 'signature-change', cwd: '/tmp' })
    expect(mockFindCallers).toHaveBeenCalledWith('mySymbol', '/tmp')
  })

  it('includes summary with caller count in result', async () => {
    const mockFindCallers = vi.fn().mockResolvedValue([
      { file: 'a.ts', line: 1, snippet: '' },
      { file: 'b.ts', line: 2, snippet: '' },
      { file: 'c.ts', line: 3, snippet: '' },
    ])
    const analyzer = new BlastRadiusAnalyzer(mockFindCallers)
    const result = await analyzer.analyze({ symbol: 'x', changeType: 'removal', cwd: '/tmp' })
    expect(result.callerCount).toBe(3)
    expect(result.summary).toMatch(/3/)
  })
})
