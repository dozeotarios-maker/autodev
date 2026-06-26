// S2-M6 — Codebase-memory adapter (MCP protocol rewrite).
//
// codebase-memory-mcp 0.10.0 is a JSON-RPC 2.0 MCP server on stdio.
// Protocol:
//   1. spawn("codebase-memory-mcp", [], { stdio: ['pipe','pipe','pipe'] })
//   2. Send { jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion, capabilities, clientInfo } }
//   3. Send { jsonrpc:"2.0", method:"notifications/initialized" }  (no id = notification)
//   4. Multiplex tools/call requests by JSON-RPC id over the kept-open stdio.
//   5. Results arrive in result.content (MCP content array); text items are JSON strings → parse.
//
// One long-lived child per adapter instance. Handshake once. close()/dispose() tears it down.
//
// Mock path: pass { mock: true } or set CODEBASE_MEMORY_MOCK=1 env var.
import { spawn, type ChildProcess } from 'child_process'

export interface CallerRef {
  file: string
  /** Source line number. Present in mock data; omitted for real MCP results
   *  where the server returns graph hop-distance, not a line number. */
  line?: number
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
  /**
   * Root of the repository to index. Defaults to process.cwd().
   * Passed to index_repository{repo_path} when the repo is not yet indexed.
   */
  repoRoot?: string
}

// ─── JSON-RPC 2.0 helpers ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
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

// MCP result.content item
interface McpContentItem {
  type: string
  text?: string
}

// MCP tools/call result shape
interface McpToolResult {
  content: McpContentItem[]
  isError?: boolean
}

// ─── In-memory mock data ──────────────────────────────────────────────────────

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
  execute: [
    { file: 'src/host/controller.ts', line: 1, symbol: '_runPhases' },
  ],
}

// ─── Persistent MCP client ───────────────────────────────────────────────────

type PendingResolver = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class McpClient {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingResolver>()
  private idCounter = 0
  private stdoutBuf = ''
  private initialized = false
  private initPromise: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly binaryPath: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Lazily spawn the process and perform the MCP initialize handshake once.
   * Subsequent calls return the cached promise.
   */
  ensureConnected(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new BackendUnavailableError('McpClient is closed'))
    }
    if (this.initialized) return Promise.resolve()
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      let proc: ChildProcess

      try {
        proc = spawn(this.binaryPath, [], {
          stdio: ['pipe', 'pipe', 'ignore'],
          shell: false,
        })
      } catch (err) {
        reject(new BackendUnavailableError(
          `codebase-memory-mcp binary could not be spawned: ${String(err)}`
        ))
        return
      }

      this.proc = proc

      // Route stdout through line buffer → dispatch to pending resolvers
      proc.stdout?.on('data', (chunk: Buffer) => {
        this.stdoutBuf += chunk.toString()
        this._drainLines()
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        const msg = err.code === 'ENOENT'
          ? `codebase-memory-mcp binary not found on PATH: "${this.binaryPath}"`
          : `codebase-memory-mcp spawn error: ${String(err)}`
        const bErr = new BackendUnavailableError(msg)

        if (!this.initialized) {
          this.initPromise = null
          reject(bErr)
        } else {
          // Post-init error: reset so next ensureConnected() re-spawns
          this.initialized = false
          this.initPromise = null
        }
        // Reject all pending calls
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(bErr)
        }
        this.pending.clear()
        this.proc = null
      })

      proc.on('close', (exitCode: number | null) => {
        const bErr = new BackendUnavailableError(
          `codebase-memory-mcp process exited with code ${exitCode}`
        )
        if (!this.initialized) {
          this.initPromise = null
          reject(bErr)
        } else {
          // Post-init close: reset so next ensureConnected() re-spawns
          this.initialized = false
          this.initPromise = null
        }
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(bErr)
        }
        this.pending.clear()
        this.proc = null
      })

      // Send initialize request
      const initId = ++this.idCounter
      const initReq: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pi-autodev', version: '1' },
        },
      }

      // Register resolver for the initialize response
      const initTimer = setTimeout(() => {
        // Remove the pending resolver so a late response doesn't run the success path
        this.pending.delete(initId)
        this.initPromise = null
        reject(new BackendUnavailableError(
          `codebase-memory-mcp initialize timed out after ${this.timeoutMs}ms`
        ))
        proc.kill()
      }, this.timeoutMs)

      this.pending.set(initId, {
        resolve: () => {
          clearTimeout(initTimer)
          // Send notifications/initialized (no id = notification)
          const notif: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }
          this._write(JSON.stringify(notif))
          this.initialized = true
          resolve()
        },
        reject: (err: Error) => {
          clearTimeout(initTimer)
          this.initPromise = null
          reject(err)
        },
        timer: initTimer,
      })

      this._write(JSON.stringify(initReq))
    })

    return this.initPromise
  }

  /**
   * Call a tool via tools/call and return the parsed first text content.
   */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureConnected()

    // Liveness check: if the proc died between ensureConnected() and here, fail fast
    if (!this.proc) {
      return Promise.reject(new BackendUnavailableError(
        `codebase-memory-mcp process is not running (died after initialization)`
      ))
    }

    return new Promise<T>((resolve, reject) => {
      const id = ++this.idCounter

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BackendUnavailableError(
          `codebase-memory-mcp tools/call "${name}" timed out after ${this.timeoutMs}ms`
        ))
      }, this.timeoutMs)

      this.pending.set(id, {
        resolve: (raw: unknown) => {
          clearTimeout(timer)
          try {
            const toolResult = raw as McpToolResult
            const textItem = toolResult.content?.find(
              (c: McpContentItem) => c.type === 'text' && typeof c.text === 'string'
            )
            if (!textItem?.text) {
              reject(new BackendUnavailableError(
                `codebase-memory-mcp tools/call "${name}" returned no text content`
              ))
              return
            }
            const parsed = JSON.parse(textItem.text) as T
            resolve(parsed)
          } catch (err) {
            reject(new BackendUnavailableError(
              `codebase-memory-mcp tools/call "${name}" content parse error: ${String(err)}`
            ))
          }
        },
        reject: (err: Error) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
      })

      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }
      this._write(JSON.stringify(req))
    })
  }

  /** Tear down the child process. */
  close(): void {
    this.closed = true
    this.initialized = false
    this.initPromise = null
    if (this.proc) {
      try { this.proc.stdin?.end() } catch { /* ignore */ }
      try { this.proc.kill() } catch { /* ignore */ }
      this.proc = null
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new BackendUnavailableError('McpClient closed'))
    }
    this.pending.clear()
  }

  // ── private ────────────────────────────────────────────────────────────────

  private _write(line: string): void {
    try {
      this.proc?.stdin?.write(line + '\n')
    } catch (err) {
      throw new BackendUnavailableError(
        `Failed to write to codebase-memory-mcp stdin: ${String(err)}`
      )
    }
  }

  private _drainLines(): void {
    const lines = this.stdoutBuf.split('\n')
    // Keep any incomplete trailing line in the buffer
    this.stdoutBuf = lines.pop() ?? ''

    for (const line of lines) {
      // Strip \r so CRLF-terminated lines don't break JSON.parse
      const trimmed = line.replace(/\r$/, '').trim()
      if (!trimmed) continue
      this._dispatch(trimmed)
    }
  }

  private _dispatch(line: string): void {
    let msg: JsonRpcResponse<unknown>
    try {
      msg = JSON.parse(line) as JsonRpcResponse<unknown>
    } catch {
      // Unparseable line — ignore (could be server log or stderr bleed)
      return
    }

    // Ignore notifications (no id)
    if (!('id' in msg) || msg.id == null) return

    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)

    if (isRpcError(msg)) {
      const dataStr = msg.error.data !== undefined
        ? ` data=${JSON.stringify(msg.error.data)}`
        : ''
      pending.reject(new BackendUnavailableError(
        `codebase-memory-mcp RPC error ${msg.error.code}: ${msg.error.message}${dataStr}`
      ))
    } else {
      pending.resolve((msg as JsonRpcSuccess<unknown>).result)
    }
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

// Probed trace_path result shape
interface TracePathResult {
  function: string
  direction: string
  callers?: Array<{ name: string; qualified_name: string; hop: number }>
  callees?: Array<{ name: string; qualified_name: string; hop: number }>
}

// index_status result
interface IndexStatusResult {
  project: string
  status: string
  nodes?: number
  edges?: number
}

// index_repository result
interface IndexRepositoryResult {
  project: string
  status: string
}

// list_projects result
interface ListProjectsResult {
  projects: string[]
  hint?: string
}

export class CodebaseMemoryAdapter {
  private readonly mock: boolean
  private repoRoot: string
  private client: McpClient | null = null
  private projectName: string | null = null

  constructor(opts: CodebaseMemoryOptions = {}) {
    this.mock = opts.mock ?? process.env['CODEBASE_MEMORY_MOCK'] === '1'
    this.repoRoot = opts.repoRoot ?? process.cwd()

    if (!this.mock) {
      this.client = new McpClient(
        opts.binaryPath ?? 'codebase-memory-mcp',
        opts.timeoutMs ?? 10_000,
      )
    }
  }

  /**
   * Re-root the adapter after a project re-root (controller chdir).
   * Resets the cached project name so the NEXT ensureIndexed() indexes the new
   * dir instead of returning early on the stale (old-dir) index name.
   */
  setRepoRoot(repoRoot: string): void {
    this.repoRoot = repoRoot
    this.projectName = null
  }

  /**
   * Ensure the repo is indexed. Calls list_projects to discover the real server
   * project name (avoiding slug-reconstruction mismatches), then index_status,
   * then index_repository if needed. Caches the project name on the adapter.
   */
  async ensureIndexed(): Promise<void> {
    if (this.mock) return
    if (this.projectName) return

    // Derive a candidate project name from the repo path (fallback convention)
    // e.g. /root/pi-autodev → root-pi-autodev
    const segments = this.repoRoot.replace(/^\//, '').split('/')
    const candidateProject = segments.join('-')

    // Prefer list_projects to discover the real server-assigned project name
    // (avoids slug-reconstruction mismatches between client and server).
    let resolvedProject = candidateProject
    try {
      const listed = await this.client!.callTool<ListProjectsResult>('list_projects', {})
      const found = listed.projects?.find((p) => p === candidateProject)
      if (found) {
        resolvedProject = found
      }
      // If not in the list, fall through to index_status / index_repository
    } catch {
      // list_projects failed — proceed with reconstructed name
    }

    // Try index_status first
    try {
      const status = await this.client!.callTool<IndexStatusResult>('index_status', {
        project: resolvedProject,
      })
      if (status.status === 'ready') {
        this.projectName = resolvedProject
        return
      }
    } catch {
      // Not indexed yet — fall through to index_repository
    }

    // Index the repository and capture the returned project name
    const indexed = await this.client!.callTool<IndexRepositoryResult>('index_repository', {
      repo_path: this.repoRoot,
    })
    if (!indexed.project) {
      throw new BackendUnavailableError(
        'codebase-memory-mcp index_repository returned no project name'
      )
    }
    this.projectName = indexed.project
  }

  /**
   * Get a compact structural summary of the repository architecture.
   */
  async getArchitecture(): Promise<string> {
    if (this.mock) {
      return '{"project":"mock","total_nodes":0,"packages":[]}'
    }
    await this.ensureIndexed()
    const result = await this.client!.callTool<Record<string, unknown>>('get_architecture', {
      project: this.projectName!,
    })
    return JSON.stringify(result)
  }

  /**
   * Find all call-sites for a symbol using trace_path (direction: inbound).
   * Mock: returns MOCK_CALL_GRAPH entries.
   */
  async findCallers(symbol: string): Promise<CallerRef[]> {
    if (this.mock) {
      return MOCK_CALL_GRAPH[symbol] ?? []
    }
    await this.ensureIndexed()

    const result = await this.client!.callTool<TracePathResult>('trace_path', {
      function_name: symbol,
      project: this.projectName!,
      direction: 'inbound',
      depth: 2,
    })

    // Map trace_path callers to CallerRef[].
    // The server returns {name, qualified_name, hop}; qualified_name encodes the file path:
    //   root-pi-autodev.src.host.controller.Controller._runPhases
    // We map qualified_name → file by replacing dots-after-project-prefix with slashes.
    const callers = result.callers ?? []
    return callers.map((c) => {
      const file = qualifiedNameToFile(c.qualified_name, this.projectName!)
      // hop is graph traversal distance, not a source line number — omit line
      return { file, symbol: c.name }
    })
  }

  /**
   * Health check: in mock mode always ok.
   * Real: perform handshake + list_projects. Returns {ok:true} if server responds.
   * Fail-conservative: any spawn/parse/timeout error → {ok:false, details}.
   */
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      // ensureConnected performs the handshake
      await this.client!.ensureConnected()
      // list_projects confirms the server is functional
      await this.client!.callTool<ListProjectsResult>('list_projects', {})
      return { ok: true }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }

  /**
   * Tear down the persistent MCP child process.
   */
  close(): void {
    this.client?.close()
  }

  /** Alias for close() to match dispose pattern. */
  dispose(): void {
    this.close()
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a qualified_name like "root-pi-autodev.src.host.controller.Controller._runPhases"
 * to a file path like "src/host/controller.ts".
 *
 * Heuristic: strip the project prefix, then walk dot-separated segments converting
 * to path segments. Stop when we find a .ts file-like segment (no uppercase first char
 * and not a class/method name). If derivation fails, return the qualified_name as-is.
 */
function qualifiedNameToFile(qualifiedName: string, projectName: string): string {
  const prefix = projectName + '.'
  const rest = qualifiedName.startsWith(prefix)
    ? qualifiedName.slice(prefix.length)
    : qualifiedName

  // Split on dots — segments that start with uppercase are class/method names, skip them
  const parts = rest.split('.')
  const fileParts: string[] = []
  for (const part of parts) {
    if (/^[A-Z_]/.test(part)) break  // reached a class/constructor/method
    fileParts.push(part)
  }

  if (fileParts.length === 0) return qualifiedName

  // Last file part: append .ts if it doesn't already have an extension
  const last = fileParts[fileParts.length - 1]!
  if (!last.includes('.')) {
    fileParts[fileParts.length - 1] = last + '.ts'
  }

  return fileParts.join('/')
}
