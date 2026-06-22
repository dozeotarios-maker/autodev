// S2-M6 — Codebase-memory adapter.
// ARCHITECTURE CORRECTION: codebase-memory-mcp is a binary that speaks JSON-RPC 2.0
// over stdio (not HTTP). The Stage-1 implementation wrongly assumed an HTTP MCP server.
//
// Real access pattern:
//   1. spawn("codebase-memory-mcp", [], { stdio: ['pipe','pipe','pipe'] })
//   2. write JSON-RPC 2.0 request to stdin
//   3. read one newline-terminated JSON-RPC response from stdout
//   4. parse and return the result
//
// BackendUnavailableError is thrown if:
//   - the binary is not found (ENOENT)
//   - the process exits non-zero before responding
//   - the response cannot be parsed
//
// Mock path: pass { mock: true } or set CODEBASE_MEMORY_MOCK=1 env var.
import { spawn } from 'child_process'

export interface CallerRef {
  file: string
  line: number
  symbol?: string
}

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface CodebaseMemoryOptions {
  mock?: boolean
  /**
   * Name or full path of the codebase-memory-mcp binary.
   * Defaults to "codebase-memory-mcp" (must be on PATH).
   */
  binaryPath?: string
  /** Timeout for a single RPC call, in ms. Defaults to 10_000. */
  timeoutMs?: number
}

// ─── JSON-RPC 2.0 helpers ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0'
  id: number
  result: T
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError

function isRpcError<T>(r: JsonRpcResponse<T>): r is JsonRpcError {
  return 'error' in r
}

// ─── In-memory mock call graph ───────────────────────────────────────────────

const MOCK_CALL_GRAPH: Record<string, CallerRef[]> = {
  processPayment: [
    { file: 'src/checkout/handler.ts', line: 42, symbol: 'handleCheckout' },
    { file: 'src/billing/invoice.ts', line: 17, symbol: 'generateInvoice' },
    { file: 'src/api/routes.ts', line: 88, symbol: 'paymentRoute' },
  ],
  createUser: [
    { file: 'src/auth/registration.ts', line: 23, symbol: 'registerUser' },
    { file: 'src/admin/users.ts', line: 55, symbol: 'adminCreateUser' },
  ],
  sendEmail: [
    { file: 'src/notifications/email.ts', line: 11, symbol: 'notifyUser' },
  ],
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CodebaseMemoryAdapter {
  private readonly mock: boolean
  private readonly binaryPath: string
  private readonly timeoutMs: number
  private _rpcIdCounter = 0

  constructor(opts: CodebaseMemoryOptions = {}) {
    this.mock = opts.mock ?? process.env['CODEBASE_MEMORY_MOCK'] === '1'
    this.binaryPath = opts.binaryPath ?? 'codebase-memory-mcp'
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /**
   * Find all call-sites for a symbol.
   * Mock: returns MOCK_CALL_GRAPH entries.
   * Real: spawns codebase-memory-mcp, sends find_callers JSON-RPC request,
   *       reads the JSON-RPC response from stdout.
   */
  async findCallers(symbol: string): Promise<CallerRef[]> {
    if (this.mock) {
      return MOCK_CALL_GRAPH[symbol] ?? []
    }
    const result = await this._rpc<{ callers: CallerRef[] }>('find_callers', { symbol })
    return result.callers ?? []
  }

  /**
   * Health check: in mock mode always ok.
   * In real mode, sends a JSON-RPC "ping" (method: health_check) and checks the
   * process exits cleanly.  If the binary is absent → ok:false (no throw).
   */
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      await this._rpc<{ status: string }>('health_check', {})
      return { ok: true }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }

  /**
   * Invoke a JSON-RPC method against the codebase-memory-mcp binary over stdio.
   * Spawns the process, writes the request to stdin, reads the first newline-
   * terminated line from stdout, then closes stdin to let the process exit.
   */
  private _rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let proc: ReturnType<typeof spawn>

      try {
        proc = spawn(this.binaryPath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        })
      } catch (err) {
        // spawn() itself may throw synchronously on very bad paths
        reject(new BackendUnavailableError(
          `codebase-memory-mcp binary not found or could not be spawned: ${String(err)}`
        ))
        return
      }

      const id = ++this._rpcIdCounter
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

      let stdout = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
        reject(new BackendUnavailableError(
          `codebase-memory-mcp RPC "${method}" timed out after ${this.timeoutMs}ms`
        ))
      }, this.timeoutMs)

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (timedOut) return
        if (err.code === 'ENOENT') {
          reject(new BackendUnavailableError(
            `codebase-memory-mcp binary not found on PATH: "${this.binaryPath}"`
          ))
        } else {
          reject(new BackendUnavailableError(
            `codebase-memory-mcp spawn error: ${String(err)}`
          ))
        }
      })

      proc.on('close', (exitCode: number | null) => {
        clearTimeout(timer)
        if (timedOut) return

        if (exitCode !== 0 && stdout.trim() === '') {
          reject(new BackendUnavailableError(
            `codebase-memory-mcp exited with code ${exitCode} and no output`
          ))
          return
        }

        // Parse the first complete JSON line from stdout.
        const firstLine = stdout.split('\n').find(l => l.trim().length > 0)
        if (!firstLine) {
          reject(new BackendUnavailableError(
            'codebase-memory-mcp returned no JSON output'
          ))
          return
        }

        let parsed: JsonRpcResponse<T>
        try {
          parsed = JSON.parse(firstLine) as JsonRpcResponse<T>
        } catch {
          reject(new BackendUnavailableError(
            `codebase-memory-mcp returned invalid JSON: ${firstLine.slice(0, 200)}`
          ))
          return
        }

        if (isRpcError(parsed)) {
          reject(new BackendUnavailableError(
            `codebase-memory-mcp RPC error ${parsed.error.code}: ${parsed.error.message}`
          ))
          return
        }

        resolve(parsed.result)
      })

      // Write request + close stdin to signal end-of-input.
      try {
        proc.stdin?.write(JSON.stringify(request) + '\n', (err) => {
          if (err) {
            clearTimeout(timer)
            reject(new BackendUnavailableError(
              `Failed to write to codebase-memory-mcp stdin: ${String(err)}`
            ))
            return
          }
          proc.stdin?.end()
        })
      } catch (err) {
        clearTimeout(timer)
        reject(new BackendUnavailableError(
          `Failed to write to codebase-memory-mcp stdin: ${String(err)}`
        ))
      }
    })
  }
}
