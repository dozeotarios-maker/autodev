// S2-M6 — CodebaseMemoryAdapter tests (MCP protocol rewrite).
//
// Architecture: codebase-memory-mcp is a persistent stdio MCP server.
// Handshake: initialize → notifications/initialized → then tools/call multiplexed by id.
// Results arrive in result.content[0].text (JSON string).
//
// Test strategy:
//   - Mock child_process.spawn to control the fake process.
//   - Feed responses line by line from the fake stdout.
//   - Assert the handshake + tools/call envelopes.
//   - Assert findCallers maps a recorded trace_path response to CallerRef[].
//   - Assert healthCheck is ok + fail-conservative on error.
//   - Mock path tests run without spawn mocking.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import {
  CodebaseMemoryAdapter,
  BackendUnavailableError,
} from '../../src/memory/codebase-memory-adapter.js'
import { spawn } from 'child_process'

const spawnMock = vi.mocked(spawn)

// ─── Fake child process ───────────────────────────────────────────────────────

interface FakeStdin {
  write: (data: string, cb?: (err?: Error | null) => void) => void
  end: () => void
  _lines: string[]
}

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: FakeStdin
  kill: ReturnType<typeof vi.fn>
}

function buildFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn(() => { proc.emit('close', null) })

  const lines: string[] = []
  proc.stdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => {
      lines.push(data)
      proc.stdin._lines = lines
      if (cb) cb(null)
    },
    end: () => { /* no-op by default */ },
    _lines: lines,
  }

  return proc
}

/**
 * Helper: emit a JSON-RPC response line to the fake proc's stdout.
 */
function emitLine(proc: FakeProc, obj: unknown): void {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
}

/**
 * Build a fake proc that auto-answers the initialize handshake, then queues
 * additional tool responses in order.
 *
 * autoResponses: array of result objects to return for tools/call in order.
 */
function buildAutoProc(autoResponses: unknown[] = []): FakeProc {
  const proc = buildFakeProc()
  const queue = [...autoResponses]
  let toolCallCount = 0

  const origWrite = proc.stdin.write.bind(proc.stdin)
  proc.stdin.write = (data: string, cb?: (err?: Error | null) => void) => {
    origWrite(data, cb)
    let msg: { jsonrpc: string; id?: number; method?: string }
    try { msg = JSON.parse(data.trim()) } catch { return }

    if (msg.method === 'initialize' && msg.id != null) {
      // Respond to initialize
      setImmediate(() => {
        emitLine(proc, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'codebase-memory-mcp', version: '0.10.0' },
            capabilities: { tools: {} },
          },
        })
      })
    } else if (msg.method === 'tools/call' && msg.id != null) {
      const response = queue[toolCallCount++]
      if (response !== undefined) {
        setImmediate(() => {
          emitLine(proc, {
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(response) }] },
          })
        })
      }
    }
    // notifications/initialized has no id → no response needed
  }

  return proc
}

// ─── Mock path tests ──────────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — mock path', () => {
  let adapter: CodebaseMemoryAdapter

  beforeEach(() => {
    adapter = new CodebaseMemoryAdapter({ mock: true })
  })

  afterEach(() => {
    adapter.close()
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
    const uniqueFiles = new Set(callers.map((c) => c.file))
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
      try {
        const health = await a.healthCheck()
        expect(health.ok).toBe(true)
      } finally {
        a.close()
      }
    } finally {
      if (orig === undefined) delete process.env['CODEBASE_MEMORY_MOCK']
      else process.env['CODEBASE_MEMORY_MOCK'] = orig
    }
  })

  it('ensureIndexed is a no-op in mock mode', async () => {
    await expect(adapter.ensureIndexed()).resolves.toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('getArchitecture returns stub JSON in mock mode', async () => {
    const arch = await adapter.getArchitecture()
    expect(typeof arch).toBe('string')
    const parsed = JSON.parse(arch) as { project: string }
    expect(parsed.project).toBe('mock')
  })
})

// ─── MCP handshake tests ──────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — MCP handshake (spawn mocked)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends initialize then notifications/initialized before tools/call', async () => {
    const proc = buildAutoProc([
      // list_projects response (for healthCheck)
      { projects: [] },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, binaryPath: 'codebase-memory-mcp' })
    await adapter.healthCheck()
    adapter.close()

    const lines = proc.stdin._lines.map((l) => {
      try { return JSON.parse(l.trim()) as Record<string, unknown> }
      catch { return null }
    }).filter(Boolean) as Array<Record<string, unknown>>

    // First message must be initialize
    expect(lines[0]?.method).toBe('initialize')
    expect(lines[0]?.id).toBeDefined()
    expect((lines[0]?.params as Record<string, unknown>)?.protocolVersion).toBe('2024-11-05')

    // Second must be notifications/initialized (no id)
    expect(lines[1]?.method).toBe('notifications/initialized')
    expect(lines[1]?.id).toBeUndefined()

    // Third must be tools/call
    expect(lines[2]?.method).toBe('tools/call')
  })

  it('only spawns once per adapter instance (persistent connection)', async () => {
    const proc = buildAutoProc([
      { projects: [] },        // healthCheck list_projects
      { projects: ['foo'] },   // second healthCheck
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await adapter.healthCheck()
    await adapter.healthCheck()
    adapter.close()

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

// ─── tools/call envelope tests ────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — tools/call envelope', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends correct tools/call envelope for list_projects in healthCheck', async () => {
    const proc = buildAutoProc([{ projects: [] }])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await adapter.healthCheck()
    adapter.close()

    const toolCalls = proc.stdin._lines
      .map((l) => { try { return JSON.parse(l.trim()) as Record<string, unknown> } catch { return null } })
      .filter((m) => m?.method === 'tools/call')

    expect(toolCalls).toHaveLength(1)
    const params = toolCalls[0]?.params as { name: string; arguments: Record<string, unknown> }
    expect(params.name).toBe('list_projects')
    expect(params.arguments).toEqual({})
  })

  it('sends tools/call for index_status before index_repository in ensureIndexed', async () => {
    const proc = buildAutoProc([
      // index_status → not ready (throws → falls through to index_repository)
      // Actually we test the already-indexed path here:
      { project: 'root-pi-autodev', status: 'ready', nodes: 100, edges: 200 },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({
      mock: false,
      repoRoot: '/root/pi-autodev',
    })
    await adapter.ensureIndexed()
    adapter.close()

    const toolCalls = proc.stdin._lines
      .map((l) => { try { return JSON.parse(l.trim()) as Record<string, unknown> } catch { return null } })
      .filter((m) => m?.method === 'tools/call')

    expect(toolCalls[0]).toBeDefined()
    const params0 = toolCalls[0]?.params as { name: string; arguments: Record<string, unknown> }
    expect(params0.name).toBe('index_status')
    expect(params0.arguments).toHaveProperty('project', 'root-pi-autodev')
  })

  it('calls index_repository when index_status is not ready', async () => {
    const proc = buildFakeProc()
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({
      mock: false,
      repoRoot: '/root/pi-autodev',
      timeoutMs: 2000,
    })

    // Intercept writes to control the conversation
    const sentMessages: Array<Record<string, unknown>> = []
    const origWrite = proc.stdin.write.bind(proc.stdin)
    proc.stdin.write = (data: string, cb?: (err?: Error | null) => void) => {
      origWrite(data, cb)
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.trim()) } catch { return }
      sentMessages.push(msg)

      setImmediate(() => {
        if (msg['method'] === 'initialize') {
          emitLine(proc, {
            jsonrpc: '2.0', id: msg['id'],
            result: { protocolVersion: '2024-11-05', serverInfo: {}, capabilities: { tools: {} } },
          })
        } else if (msg['method'] === 'tools/call') {
          const params = msg['params'] as { name: string }
          if (params.name === 'index_status') {
            // Return a non-ready status to trigger index_repository
            emitLine(proc, {
              jsonrpc: '2.0', id: msg['id'],
              result: { content: [{ type: 'text', text: JSON.stringify({ project: 'root-pi-autodev', status: 'not_indexed' }) }] },
            })
          } else if (params.name === 'index_repository') {
            emitLine(proc, {
              jsonrpc: '2.0', id: msg['id'],
              result: { content: [{ type: 'text', text: JSON.stringify({ project: 'root-pi-autodev', status: 'indexed' }) }] },
            })
          }
        }
      })
    }

    await adapter.ensureIndexed()
    adapter.close()

    const toolNames = sentMessages
      .filter((m) => m['method'] === 'tools/call')
      .map((m) => (m['params'] as { name: string }).name)

    expect(toolNames).toContain('index_status')
    expect(toolNames).toContain('index_repository')
    // index_status must come before index_repository
    expect(toolNames.indexOf('index_status')).toBeLessThan(toolNames.indexOf('index_repository'))
  })
})

// ─── findCallers tests ────────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — findCallers → trace_path', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends trace_path with direction:inbound and depth:2', async () => {
    const proc = buildAutoProc([
      // index_status
      { project: 'root-pi-autodev', status: 'ready' },
      // trace_path
      {
        function: 'execute',
        direction: 'inbound',
        callers: [
          { name: '_runPhases', qualified_name: 'root-pi-autodev.src.host.controller.Controller._runPhases', hop: 1 },
        ],
      },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    await adapter.findCallers('execute')
    adapter.close()

    const toolCalls = proc.stdin._lines
      .map((l) => { try { return JSON.parse(l.trim()) as Record<string, unknown> } catch { return null } })
      .filter((m) => m?.method === 'tools/call')

    const traceCall = toolCalls.find((m) => (m?.params as { name: string })?.name === 'trace_path')
    expect(traceCall).toBeDefined()
    const args = (traceCall!.params as { name: string; arguments: Record<string, unknown> }).arguments
    expect(args['direction']).toBe('inbound')
    expect(args['depth']).toBe(2)
    expect(args['function_name']).toBe('execute')
  })

  it('maps a recorded trace_path response to CallerRef[]', async () => {
    // Recorded live response from probe
    const traceResult = {
      function: 'execute',
      direction: 'inbound',
      callers: [
        { name: '_runPhases', qualified_name: 'root-pi-autodev.src.host.controller.Controller._runPhases', hop: 1 },
        { name: '_onInput', qualified_name: 'root-pi-autodev.src.host.controller.Controller._onInput', hop: 2 },
      ],
    }

    const proc = buildAutoProc([
      { project: 'root-pi-autodev', status: 'ready' },
      traceResult,
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    const callers = await adapter.findCallers('execute')
    adapter.close()

    expect(Array.isArray(callers)).toBe(true)
    expect(callers.length).toBe(2)

    // Each CallerRef must have file, line, symbol
    for (const c of callers) {
      expect(typeof c.file).toBe('string')
      expect(typeof c.line).toBe('number')
      expect(typeof c.symbol).toBe('string')
    }

    // Symbol names come from the name field
    expect(callers[0]!.symbol).toBe('_runPhases')
    expect(callers[1]!.symbol).toBe('_onInput')

    // File should be derived from qualified_name
    expect(callers[0]!.file).toContain('controller')
    expect(callers[1]!.file).toContain('controller')
  })

  it('returns empty array when trace_path returns no callers', async () => {
    const proc = buildAutoProc([
      { project: 'root-pi-autodev', status: 'ready' },
      { function: 'unknown', direction: 'inbound', callers: [] },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    const callers = await adapter.findCallers('unknown_symbol')
    adapter.close()

    expect(callers).toEqual([])
  })

  it('returns empty array when trace_path result has no callers field', async () => {
    const proc = buildAutoProc([
      { project: 'root-pi-autodev', status: 'ready' },
      { function: 'noop', direction: 'inbound' },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    const callers = await adapter.findCallers('noop')
    adapter.close()

    expect(callers).toEqual([])
  })

  it('project is cached after first ensureIndexed — only one index_status call', async () => {
    const proc = buildAutoProc([
      // First ensureIndexed: index_status
      { project: 'root-pi-autodev', status: 'ready' },
      // First findCallers: trace_path
      { function: 'execute', direction: 'inbound', callers: [] },
      // Second findCallers: trace_path (no index_status again)
      { function: 'execute', direction: 'inbound', callers: [] },
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    await adapter.findCallers('execute')
    await adapter.findCallers('execute')
    adapter.close()

    const toolCalls = proc.stdin._lines
      .map((l) => { try { return JSON.parse(l.trim()) as Record<string, unknown> } catch { return null } })
      .filter((m) => m?.method === 'tools/call')
      .map((m) => (m!.params as { name: string }).name)

    // Only one index_status call (cached after first)
    expect(toolCalls.filter((n) => n === 'index_status')).toHaveLength(1)
    // Two trace_path calls
    expect(toolCalls.filter((n) => n === 'trace_path')).toHaveLength(2)
  })
})

// ─── healthCheck tests ────────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — healthCheck', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok:true when server responds to list_projects', async () => {
    const proc = buildAutoProc([{ projects: [] }])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    const health = await adapter.healthCheck()
    adapter.close()

    expect(health.ok).toBe(true)
    expect(health.details).toBeUndefined()
  })

  it('returns ok:false (no throw) when binary not found (ENOENT)', async () => {
    const proc = buildFakeProc()
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    const healthPromise = adapter.healthCheck()

    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException
    proc.emit('error', enoent)

    const health = await healthPromise
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
    expect(health.details).toMatch(/not found on PATH|ENOENT|spawn/)
    adapter.close()
  })

  it('returns ok:false (no throw) on RPC error response', async () => {
    const proc = buildFakeProc()
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, timeoutMs: 2000 })

    const origWrite = proc.stdin.write.bind(proc.stdin)
    proc.stdin.write = (data: string, cb?: (err?: Error | null) => void) => {
      origWrite(data, cb)
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.trim()) } catch { return }

      setImmediate(() => {
        if (msg['method'] === 'initialize') {
          emitLine(proc, {
            jsonrpc: '2.0', id: msg['id'],
            result: { protocolVersion: '2024-11-05', serverInfo: {}, capabilities: { tools: {} } },
          })
        } else if (msg['method'] === 'tools/call') {
          emitLine(proc, {
            jsonrpc: '2.0', id: msg['id'],
            error: { code: -32601, message: 'Method not found' },
          })
        }
      })
    }

    const health = await adapter.healthCheck()
    adapter.close()

    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
  })

  it('returns ok:false (no throw) on process close before response', async () => {
    const proc = buildFakeProc()
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, timeoutMs: 2000 })
    const healthPromise = adapter.healthCheck()

    // Simulate process dying immediately
    proc.emit('close', 1)

    const health = await healthPromise
    expect(health.ok).toBe(false)
    expect(typeof health.details).toBe('string')
    adapter.close()
  })
})

// ─── getArchitecture tests ────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — getArchitecture', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls get_architecture tool and returns JSON string', async () => {
    const archPayload = { project: 'root-pi-autodev', total_nodes: 894, packages: [] }
    const proc = buildAutoProc([
      { project: 'root-pi-autodev', status: 'ready' },
      archPayload,
    ])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false, repoRoot: '/root/pi-autodev' })
    const arch = await adapter.getArchitecture()
    adapter.close()

    const parsed = JSON.parse(arch) as { project: string; total_nodes: number }
    expect(parsed.project).toBe('root-pi-autodev')
    expect(parsed.total_nodes).toBe(894)
  })
})

// ─── close / dispose tests ────────────────────────────────────────────────────

describe('S2-M6: CodebaseMemoryAdapter — close/dispose', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('close() tears down the client without throwing', async () => {
    const proc = buildAutoProc([{ projects: [] }])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await adapter.healthCheck()
    expect(() => adapter.close()).not.toThrow()
  })

  it('dispose() is an alias for close()', async () => {
    const proc = buildAutoProc([{ projects: [] }])
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

    const adapter = new CodebaseMemoryAdapter({ mock: false })
    await adapter.healthCheck()
    expect(() => adapter.dispose()).not.toThrow()
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
