// S2-M1: HostAgent — steering primitive for the pi long-host-session architecture.
//
// Correlation model: "one steer in-flight (mutex) → the next agent_end is mine."
// agent_end has no correlation ID in the pi API, so the mutex enforces the invariant:
// only one steer is ever in-flight, so the next agent_end that fires belongs to it.
//
// Usage (controller wires):
//   pi.on('agent_end', (e, _ctx) => hostAgent._onAgentEnd(e))
//   pi.on('turn_end',  (e, _ctx) => hostAgent._onTurnEnd(e))

import * as fs from 'fs/promises'
import type { AgentEndEvent, TurnEndEvent } from '@earendil-works/pi-coding-agent'
import type { AgentResult, SteerOptions, ToolResultEntry } from './types.js'
import { SteerInFlightError } from './types.js'

const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes

/** Minimal pi API surface used by HostAgent (injectable for tests) */
export interface HostAgentPi {
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void
}

interface PendingSteer {
  resolve: (result: AgentResult) => void
  reject: (err: Error) => void
  seq: number
  timer: ReturnType<typeof setTimeout>
  /** Accumulated turn-level tool results within the current agent loop */
  turnToolResults: ToolResultEntry[]
}

export class HostAgent {
  /** Monotonic sequence counter — incremented on every steer() call */
  private seq = 0

  /** Mutex: true while a steer is in-flight */
  private inFlight = false

  /** Pending promise resolver/rejecter for the currently-awaited single-steer */
  private pending: PendingSteer | null = null

  constructor(private pi: HostAgentPi) {}

  // ── Event handlers (wired by the controller) ──────────────────────────────

  /** Called by the controller: pi.on('turn_end', (e) => hostAgent._onTurnEnd(e)) */
  _onTurnEnd(event: TurnEndEvent): void {
    if (!this.pending) return
    // Accumulate tool results from each turn within the agent loop.
    // TurnEndEvent.toolResults is ToolResultMessage[] — structurally matches ToolResultEntry[].
    const results = event.toolResults as unknown as ToolResultEntry[]
    this.pending.turnToolResults.push(...results)
  }

  /** Called by the controller: pi.on('agent_end', (e) => hostAgent._onAgentEnd(e)) */
  _onAgentEnd(event: AgentEndEvent): void {
    if (!this.pending) {
      // No steer in-flight — ignore stale agent_end
      return
    }
    const { resolve, seq, timer, turnToolResults } = this.pending
    clearTimeout(timer)
    // Clear pending BEFORE resolving so retry in steer() can set a new pending
    this.pending = null

    const rawText = extractRawText(event.messages)
    resolve({ rawText, toolResults: turnToolResults, seq })
  }

  // ── steer() ───────────────────────────────────────────────────────────────

  /**
   * Steer the host agent with a prompt and await its response.
   *
   * - Increments monotonic seq.
   * - Acquires mutex — throws SteerInFlightError if already held.
   * - Calls pi.sendUserMessage (void / fire-and-forget).
   * - Resolves on the NEXT agent_end (correlation: one in-flight → next is mine).
   * - Validates expectFile / expectTool; retries up to 2 more times on failure.
   * - Rejects on timeout.
   */
  async steer(prompt: string, opts: SteerOptions = {}): Promise<AgentResult> {
    if (this.inFlight) {
      throw new SteerInFlightError()
    }

    this.inFlight = true
    const currentSeq = ++this.seq
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    try {
      // Up to 3 attempts total (initial + 2 retries)
      const maxAttempts = 3
      let lastError: Error | null = null

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await this._waitForAgentEnd(prompt, currentSeq, timeoutMs)
        const valid = await this._validate(result, opts)
        if (valid.ok) {
          return result
        }
        lastError = new Error(
          `Steer validation failed (attempt ${attempt + 1}/${maxAttempts}): ${valid.reason}`
        )
      }

      throw lastError ?? new Error('Steer validation failed after all attempts')
    } finally {
      this.inFlight = false
      this.pending = null
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Fire sendUserMessage and wait for the next agent_end to resolve/reject. */
  private _waitForAgentEnd(
    prompt: string,
    seq: number,
    timeoutMs: number
  ): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`Steer timed out after ${timeoutMs}ms (seq=${seq})`))
      }, timeoutMs)

      this.pending = {
        resolve,
        reject,
        seq,
        timer,
        turnToolResults: [],
      }

      // Fire-and-forget: pi.sendUserMessage returns void
      this.pi.sendUserMessage(prompt, { deliverAs: 'followUp' })
    })
  }

  private async _validate(
    result: AgentResult,
    opts: SteerOptions
  ): Promise<{ ok: boolean; reason?: string }> {
    if (opts.expectFile) {
      try {
        const content = await fs.readFile(opts.expectFile, 'utf-8')
        JSON.parse(content) // throws if invalid JSON
      } catch (err) {
        return {
          ok: false,
          reason: `expectFile '${opts.expectFile}' missing or invalid JSON: ${String(err)}`,
        }
      }
    }

    if (opts.expectTool) {
      const found = result.toolResults.some(
        (r) => r.toolName === opts.expectTool
      )
      if (!found) {
        return {
          ok: false,
          reason: `expectTool '${opts.expectTool}' not found in agent_end tool results`,
        }
      }
    }

    return { ok: true }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Extract concatenated text from all assistant messages in an agent_end event.
 * AgentMessage is from @earendil-works/pi-agent-core — we use structural typing.
 */
function extractRawText(messages: unknown[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue
    const m = msg as Record<string, unknown>
    if (m['role'] !== 'assistant') continue
    const content = m['content']
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>)['type'] === 'text'
        ) {
          const text = (block as Record<string, unknown>)['text']
          if (typeof text === 'string') parts.push(text)
        }
      }
    }
  }
  return parts.join('\n')
}
