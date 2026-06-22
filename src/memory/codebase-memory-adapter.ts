// M2 — Layer-A codebase-memory adapter.
// Wraps codebase-memory-mcp (DeusData/Martin Vogel, single static C binary) via MCP HTTP.
// G12: mock mode uses a seeded in-memory call graph; real boundary is the MCP server.
// Real dep at integration: pi-mcp-adapter (wraps MCP protocol) + codebase-memory-mcp binary.

interface CodebaseMemoryOptions {
  mock?: boolean
  baseUrl?: string
}

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

// Seeded mock call graph — represents realistic cross-file caller relationships.
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

export class CodebaseMemoryAdapter {
  private readonly mock: boolean
  private readonly baseUrl: string

  constructor(opts: CodebaseMemoryOptions = {}) {
    this.mock = opts.mock ?? false
    this.baseUrl = opts.baseUrl ?? 'http://localhost:7777'
  }

  async findCallers(symbol: string): Promise<CallerRef[]> {
    if (this.mock) {
      return MOCK_CALL_GRAPH[symbol] ?? []
    }
    // Production: call the MCP tool via pi-mcp-adapter.
    // Tool: find_callers(symbol) → CallerRef[]
    // Throws BackendUnavailableError on HTTP error or network failure so callers
    // can distinguish "backend down" from a legitimate empty-caller result.
    const url = `${this.baseUrl}/mcp/tools/find_callers`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      throw new BackendUnavailableError(`codebase-memory MCP unreachable: ${String(err)}`)
    }
    if (!response.ok) {
      throw new BackendUnavailableError(
        `codebase-memory MCP returned HTTP ${response.status} for symbol "${symbol}"`
      )
    }
    const data = (await response.json()) as { callers?: CallerRef[] }
    return data.callers ?? []
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.mock) {
      return { ok: true, details: 'mock mode' }
    }
    try {
      const url = `${this.baseUrl}/health`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return { ok: true }
      return { ok: false, details: `HTTP ${response.status}` }
    } catch (err) {
      return { ok: false, details: String(err) }
    }
  }
}
