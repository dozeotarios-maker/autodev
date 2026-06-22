// M6b: G19 blast-radius — find_callers enumerates callers before a breaking change
export interface Caller {
  file: string
  line: number
  snippet: string
}

export interface BlastRadiusInput {
  symbol: string
  changeType: 'signature-change' | 'removal' | 'rename'
  cwd: string
}

export interface BlastRadiusResult {
  callers: Caller[]
  callerCount: number
  safe: boolean
  summary: string
}

export type FindCallersFn = (symbol: string, cwd: string) => Promise<Caller[]>

export class BlastRadiusAnalyzer {
  constructor(private readonly findCallers: FindCallersFn) {}

  async analyze(input: BlastRadiusInput): Promise<BlastRadiusResult> {
    const callers = await this.findCallers(input.symbol, input.cwd)
    const callerCount = callers.length
    const safe = callerCount === 0

    const summary = safe
      ? `Symbol "${input.symbol}" has no callers — safe to ${input.changeType}`
      : `Symbol "${input.symbol}" has ${callerCount} caller(s) — ${input.changeType} is breaking`

    return { callers, callerCount, safe, summary }
  }
}
