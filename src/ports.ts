// 10 dependency-inversion port interfaces for pi-autodev.
// Concrete implementations live in M2–M9; only no-op stubs needed here for M1 compile gate.

export interface MemoryStore {
  store(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>
  recall(query: string, limit?: number): Promise<Array<{ key: string; value: string; score: number }>>
  detectContradictions(key: string): Promise<Array<{ a: string; b: string; conflictFlag: boolean }>>
  healthCheck(): Promise<{ ok: boolean; details?: string }>
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  healthCheck(): Promise<{ ok: boolean; details?: string }>
}

export type LaneStatus = 'idle' | 'running' | 'done' | 'failed'

export interface Lane {
  id: string
  files: string[]
  run(task: string, options?: { workdir?: string }): Promise<{ output: string; exitCode: number }>
  status(): LaneStatus
}

export interface Verifier {
  runDeterministic(testCmd: string, cwd: string): Promise<{ passed: boolean; exitCode: number; output: string }>
  runMutation(cwd: string, threshold?: number): Promise<{ score: number; passed: boolean }>
  runHoldout(testCmd: string, cwd: string): Promise<{ passed: boolean; output: string }>
  runSecurityScan(cwd: string): Promise<{ clean: boolean; findings: string[] }>
}

export interface GitOps {
  scopedCommit(message: string, allowedPaths: string[]): Promise<{ sha: string }>
  perPhasePush(branch: string): Promise<void>
  tierDGate(
    action: string,
    brief: { change: string; why: string; risk: string; rollback: string }
  ): Promise<boolean>
  scanSecrets(staged: boolean): Promise<{ clean: boolean; findings: string[] }>
  changedFiles(cwd: string): Promise<string[]>
}

export interface MetricEntry {
  role: string
  task: string
  metric_name: string
  value: number
  timestamp: string
}

export interface Transparency {
  log(action: string): Promise<void>
  appendEntry(type: string, data?: unknown): Promise<void>
  setHudStatus(phase: string, task: string, laneStatus: string, model: string): void
  recordMetric(metric: MetricEntry): Promise<void>
}

export interface Judge {
  isDone(goal: string, evidence: string): Promise<boolean>
  isStillRight(spec: string, currentDiff: string): Promise<{ aligned: boolean; reason?: string }>
}

export interface TokenVault {
  getToken(projectId: string): Promise<string>
  storeToken(projectId: string, token: string): Promise<void>
  revokeToken(projectId: string): Promise<void>
  hasToken(projectId: string): Promise<boolean>
  injectIntoEnv(projectId: string, env: Record<string, string>, envKey: string): Promise<void>
}

export interface SecurityFinding {
  severity: string
  description: string
  line?: number
}

export interface SecurityLane {
  reviewDiff(diff: string): Promise<{ clean: boolean; findings: SecurityFinding[] }>
  screenContent(content: string, source: 'repo' | 'web'): Promise<{ safe: boolean; threats: string[] }>
}

export interface ResurrectionState {
  phase: string
  lastGoodCommit: string
  halfDone: string[]
}

export interface Resurrection {
  reconstruct(journalPath: string, checkpointPath: string): Promise<ResurrectionState>
  resume(
    state: ResurrectionState,
    options?: { dryRun?: boolean }
  ): Promise<{ resumed: boolean; report: string }>
  isIdempotentSafe(action: string, ledgerPath: string): Promise<boolean>
}

export interface BoundedExecResult {
  passed: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  blocked: boolean
}

export interface BoundedExec {
  run(cmd: string, cwd: string, opts: { timeoutMs: number }): Promise<BoundedExecResult>
  /** Re-root the confinement boundary to a new project dir (call after process.chdir). */
  setRepoRoot?(dir: string): void
}
