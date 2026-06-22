// S2-M1: HostAgent types — shared across host-agent.ts and subagent-driver.ts

// Structural type for a tool result message (matches @earendil-works/pi-ai ToolResultMessage shape
// as seen in TurnEndEvent.toolResults — we avoid importing the internal package directly).
export interface ToolResultEntry {
  toolCallId?: string
  toolName?: string
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
  [key: string]: unknown
}

export interface AgentResult {
  /** Raw concatenated assistant text from agent_end messages */
  rawText: string
  /** Tool results collected from agent_end messages (structural match of ToolResultMessage) */
  toolResults: ToolResultEntry[]
  /** Monotonic sequence number of this steer */
  seq: number
}

export interface SteerOptions {
  /** If set, this file must exist and parse as valid JSON after the turn */
  expectFile?: string
  /** If set, this tool name must appear in the agent_end messages' tool calls */
  expectTool?: string
  /** Reject if agent_end does not arrive within this many ms. Default: 600000 (10 min) */
  timeoutMs?: number
}

export interface SubagentTask {
  agent: string
  task: string
}

export interface SubagentResult {
  /** Index into the input tasks array */
  index: number
  agent: string
  task: string
  /** Raw tool result content from the subagent tool call */
  output: string
}

export interface SubagentInvokeOptions {
  /** If true, auto-stash a dirty tree before running and pop after */
  worktree?: boolean
  /** Max concurrent subagent tasks */
  concurrency?: number
}

export class SteerInFlightError extends Error {
  constructor(message = 'A steer is already in-flight; concurrent steers are not allowed') {
    super(message)
    this.name = 'SteerInFlightError'
  }
}

export class DirtyTreeError extends Error {
  constructor(message = 'Working tree is dirty and git stash failed; cannot proceed with worktree isolation') {
    super(message)
    this.name = 'DirtyTreeError'
  }
}
