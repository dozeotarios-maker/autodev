// S2-M6 — CodebaseMemoryAdapter tests (D1: test-first).
// Architecture correction: codebase-memory-mcp is a stdio JSON-RPC binary, NOT HTTP.
// These tests mock child_process.spawn (hoisted vi.mock for ESM) to verify:
//   - writes a well-formed JSON-RPC 2.0 request to stdin
//   - parses the JSON-RPC response from stdout
//   - throws BackendUnavailableError on ENOENT / non-zero exit / bad JSON / RPC error
// Mock path tests run without any spawn mocking.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Hoist the mock so it is set up before the ESM module graph resolves.
// vi.mock is automatically hoisted to the top of the file by vitest.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

// Import AFTER vi.mock so the module sees the mocked spawn.
import { CodebaseMemoryAdapter, BackendUnavailableError } from '../../src/memory/codebase-memory-adapter.js'
import { spawn } from 'child_process'

const spawnMock = vi.mocked(spawn)

// ─── Fake child_process helper ────────────────────────────────────────────────

interface FakeStdin {
  write: (data: string, cb?: (err?: Error | null) => void) => void
  end: () => void
  _writtenData: string
}

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: FakeStdin
  kill: ReturnType<typeof vi.fn>
}

function buildFakeProc(options: {
  stdoutData?: string
  exitCode?: number
  delayMs?: number
} = {}): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()

  const state = { written: '' }

  proc.stdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => {
      state.written += data
      proc.stdin._writtenData = state.written
      if (cb) cb(null)
    },
    end: () => {
      const delay = options.delayMs ?? 0
      setTimeout(() => {
        if (options.stdoutData !== undefined) {
          proc.stdout.emit('data', Buffer.from(options.stdoutData))
        }
        proc.emit('close', options.exitCode ?? 0)
      }, delay)
    },
    _writtenData: '',
  }
  return proc
}

// ─── Mock path tests ──────────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — mock path', () => {
  let adapter: CodebaseMemoryAdapter

  beforeEach(() => {
    adapter = new CodebaseMemoryAdapter({ mock: true })
  })

  it('exposes findCallers method', () => {
    expect(typeof adapter.findCallers).toBe('function')
  })

  it('findCallers returns cross-file callers for a known symbol', async () => {
    const callers = await adapter.findCallers('processPayment')
    expect(Array.isArray(callers)).toBe(true)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers[0]).toHaveProperty('file')
    expect(callers[0]).toHaveProperty('line')
    const uniqueFiles = new Set(callers.map(c => c.file))
    expect(uniqueFiles.size).toBeGreaterThanOrEqual(1)
  })

  it('findCallers returns empty array for unknown symbol', async () => {
    const callers = await adapter.findCallers('__totally_unknown_symbol__')
    expect(callers).toEqual([])
  })

  it('healthCheck returns ok:true in mock mode', async () => {
    const health = await adapter.healthCheck()
    expect(health.ok).toBe(true)
    expect(health.details).toBe('mock mode')
  })

  it('CODEBASE_MEMORY_MOCK=1 activates mock mode', async () => {
    const orig = process.env['CODEBASE_MEMORY_MOCK']
    process.env['CODEBASE_MEMORY_MOCK'] = '1'
    try {
      const a = new CodebaseMemoryAdapter()
      const health = await a.healthCheck()
      expect(health.ok).toBe(true)
    } finally {
      if (orig === undefined) delete process.env['CODEBASE_MEMORY_MOCK']
      else process.env['CODEBASE_MEMORY_MOCK'] = orig
    }
  })
})

// ─── Real path (stdio JSON-RPC) tests ────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — stdio JSON-RPC (spawn mocked)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('findCallers sends a well-formed JSON-RPC 2.0 request to stdin', async () => {
    const callers = [{ file: 'src/foo.ts', line: 10, symbol: 'bar' }]
    const response = { jsonrpc: '2.0', id: 1, result: { callers } }
    const fakeProc = buildFakeProc({ stdoutData: JSON.stringify(response) + '\n' })
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, binaryPath: 'codebase-memory-mcp' })
    const result = await adapter.findCallers('mySymbol')

    // spawn called with the binary name and correct options
    expect(spawnMock).toHaveBeenCalledWith(
      'codebase-memory-mcp',
      [],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    )

    // stdin received a valid JSON-RPC 2.0 request
    const written = fakeProc.stdin._writtenData.trim()
    const req = JSON.parse(written) as { jsonrpc: string; id: number; method: string; params: { symbol: string } }
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('find_callers')
    expect(req.params.symbol).toBe('mySymbol')
    expect(typeof req.id).toBe('number')

    // Result parsed correctly from JSON-RPC response
    expect(result).toEqual(callers)
  })

  it('findCallers parses JSON-RPC result.callers array from stdout', async () => {
    const callers = [
      { file: 'a.ts', line: 1 },
      { file: 'b.ts', line: 2 },
    ]
    const fakeProc = buildFakeProc({
      stdoutData: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { callers } }) + '\n',
    })
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    const result = await adapter.findCallers('someFunc')
    expect(result).toEqual(callers)
  })

  it('throws BackendUnavailableError on ENOENT (binary not found)', async () => {
    const fakeProc = buildFakeProc()
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException

    const adapter = new CodebaseMemoryAdapter({ mock: false, binaryPath: 'codebase-memory-mcp' })
    const findPromise = adapter.findCallers('sym')

    // Emit error to simulate binary not found
    fakeProc.emit('error', enoent)

    await expect(findPromise).rejects.toBeInstanceOf(BackendUnavailableError)
    await expect(findPromise.catch(e => (e as Error).message)).resolves.toMatch(/not found on PATH/)
  })

  it('throws BackendUnavailableError when process exits non-zero with no output', async () => {
    const fakeProc = buildFakeProc({ exitCode: 1, stdoutData: '' })
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await expect(adapter.findCallers('sym')).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('throws BackendUnavailableError when stdout is not valid JSON', async () => {
    const fakeProc = buildFakeProc({ stdoutData: 'not-json\n' })
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await expect(adapter.findCallers('sym')).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('throws BackendUnavailableError on JSON-RPC error response', async () => {
    const errorResp = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    }
    const fakeProc = buildFakeProc({ stdoutData: JSON.stringify(errorResp) + '\n' })
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await expect(adapter.findCallers('sym')).rejects.toBeInstanceOf(BackendUnavailableError)
    await expect(adapter.findCallers('sym')).rejects.toThrow(/Method not found/)
  })

  it('healthCheck returns ok:false (no throw) when binary absent', async () => {
    const fakeProc = buildFakeProc()
    spawnMock.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>)

    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    const healthPromise = adapter.healthCheck()

    fakeProc.emit('error', enoent)

    const health = await healthPromise
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
  })

  it('monotonic RPC id increments per call', async () => {
    const capturedBodies: string[] = []

    const makeProc = () => {
      const proc = buildFakeProc({
        stdoutData: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { callers: [] } }) + '\n',
      })
      const origWrite = proc.stdin.write.bind(proc.stdin)
      proc.stdin.write = (data: string, cb?: (err?: Error | null) => void) => {
        capturedBodies.push(data)
        origWrite(data, cb)
      }
      return proc
    }

    spawnMock.mockImplementation(() => makeProc() as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await adapter.findCallers('a')
    await adapter.findCallers('b')

    expect(capturedBodies).toHaveLength(2)
    const req1 = JSON.parse(capturedBodies[0].trim()) as { id: number }
    const req2 = JSON.parse(capturedBodies[1].trim()) as { id: number }
    expect(req2.id).toBeGreaterThan(req1.id)
  })
})

// ─── BackendUnavailableError shape ───────────────────────────────────────────

describe('S2-M6: BackendUnavailableError', () => {
  it('has correct name and message', () => {
    const err = new BackendUnavailableError('test message')
    expect(err.name).toBe('BackendUnavailableError')
    expect(err.message).toBe('test message')
    expect(err).toBeInstanceOf(Error)
  })
})
