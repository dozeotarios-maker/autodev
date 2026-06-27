// E2E StubHost — replaces the real Claude steer for end-to-end test scenarios.
//
// Architecture:
//   The controller drives the host via hostAgent.steer(prompt, { expectFile }).
//   HostAgent calls pi.sendUserMessage(prompt) and awaits the next agent_end.
//   StubHost intercepts pi.sendUserMessage (via mockImplementation), writes a
//   canned SCHEMA-VALID JSON to the expectFile extracted from the prompt, and
//   fires agent_end so the steer resolves immediately.
//
// Key design choices:
//   - StubHost.install() calls mockImplementation() which replaces the original
//     vi.fn() impl. Callers that want to track prompt strings must pass a
//     `onSteer` callback — the stub records internally via `steeredPrompts`.
//   - waitForLockRelease: waits for the lock to APPEAR then DISAPPEAR (the
//     B1 teardown-settle pattern). Returns immediately if lock never appeared.
//   - All canned outputs are schema-valid (pass the real phase validators).
//   - Outputs CHAIN: P1 spec is injected into P3, P3 feeds P4, P4 feeds P5.

import * as fs from 'fs/promises'
import * as path from 'path'
import { vi } from 'vitest'
import type { AgentEndEvent, TurnEndEvent } from '@earendil-works/pi-coding-agent'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  InputEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency } from '../../src/ports.js'

// ── Canned phase outputs (schema-valid, chaining) ─────────────────────────────
//
// Validators and gates (from the real phase source):
//   P1: spec.trim().length >= 20, stackAdr.trim().length >= 10
//   P2: domainModel.trim().length >= 20 (persona gate relaxed for XS)
//   P3: goal.trim().length >= 10, successCriteria.length >= 1,
//       fileDAG.length >= 1, examplesTable.length >= 1, panelObjCount === 0
//   P4: laneResults has at least one { status: 'success' }
//   P5: reviewFindings has no CRITICAL/HIGH
//   P6: commitSha + pushResult are strings

export const CANNED_P1 = {
  phase: 'P1',
  spec: 'Add a greet(name) function to src/utils.ts that returns "Hello, <name>!". ' +
        'This function is used by the CLI greeting command and tested via unit tests. ' +
        'Success criteria: returns correct greeting string, handles edge cases.',
  stackAdr: 'TypeScript + Node.js. No new dependencies required. Standard exports.',
  webResearch: [
    { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript Handbook', summary: 'Standard TS function syntax and exports.' },
  ],
  complexity: {
    files: 1,
    novelty: 'low',
    blastRadius: 1,
    irreversibility: 'low',
    rationale: 'Small isolated utility function — single file, no schema changes.',
  },
}

export const CANNED_P2 = {
  phase: 'P2',
  domainModel: 'Greeter entity: accepts name string, returns greeting string. ' +
               'Invariant: output always starts with "Hello, ". No side effects.',
  personaDebate: [
    { persona: 'end-user', stance: 'approve', objections: [] },
  ],
}

export const CANNED_P3 = {
  phase: 'P3',
  fileDAG: [
    { file: 'src/utils.ts', lane: 0, deps: [] },
  ],
  panelObjCount: 0,
  sprintContract: {
    goal: 'Implement greet(name) utility function in src/utils.ts',
    successCriteria: ['Function greet(name) returns "Hello, <name>!"', 'Exported correctly'],
    outOfScope: ['CLI integration', 'i18n'],
  },
  examplesTable: [
    { scenario: 'greet Alice', input: 'Alice', expectedOutput: 'Hello, Alice!' },
  ],
}

export const CANNED_P4 = {
  phase: 'P4',
  laneResults: [
    { laneId: 0, status: 'success', files: ['src/utils.ts'], output: 'greet() written' },
  ],
  artifacts: ['src/utils.ts'],
}

export const CANNED_P5 = {
  phase: 'P5',
  verifyReport: {
    deterministicPassed: true,
    holdoutPassed: true,
    mutationScore: 0.95,
    securityClean: true,
  },
  reviewFindings: [],
}

export const CANNED_P6 = {
  phase: 'P6',
  commitSha: 'e2e-stub-abc1234',
  pushResult: 'pushed to origin/main',
}

// Quick gear: combined seed file
export const CANNED_QUICK_SEED = {
  spec: 'Add a greet(name) function that returns "Hello, <name>!". ' +
        'Used by the CLI greeting command. Success: returns correct string.',
  stackAdr: 'TypeScript, no new deps.',
  plan: {
    goal: 'Implement greet(name) quickly in src/utils.ts',
    successCriteria: ['greet() exists and returns greeting'],
    fileDAG: [{ file: 'src/utils.ts', lane: 0, deps: [] }],
    examplesTable: [{ scenario: 'greet Alice', input: 'Alice', expectedOutput: 'Hello, Alice!' }],
  },
}

// ── Phase detection from steer prompt ────────────────────────────────────────

export type PhaseKey =
  | 'QUICK-SEED'
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'
  | 'D1' | 'D2' | 'D3'

export function detectPhase(prompt: string): PhaseKey | null {
  // Quick-gear seed: role header is "Quick-Gear Seed Agent"
  if (prompt.includes('Quick-Gear Seed Agent') || prompt.includes('quick gear') || prompt.includes('quick-seed.json')) return 'QUICK-SEED'
  if (prompt.includes('Discovery Agent (P1)') || prompt.includes('P1 DISCOVER')) return 'P1'
  if (prompt.includes('Elaboration Agent (P2)') || prompt.includes('P2 ELABORATE')) return 'P2'
  if (prompt.includes('Planning Agent (P3)') || prompt.includes('P3 PLAN')) return 'P3'
  if (prompt.includes('Build Agent (P4)') || prompt.includes('P4 BUILD')) return 'P4'
  if (prompt.includes('Verifier Agent (P5)') || prompt.includes('P5 VERIFY')) return 'P5'
  if (prompt.includes('Release Agent (P6)') || prompt.includes('P6 RELEASE')) return 'P6'
  if (prompt.includes('d1-reproduce') || prompt.includes('D1 REPRODUCE')) return 'D1'
  if (prompt.includes('d2-root-cause') || prompt.includes('D2 ROOT')) return 'D2'
  if (prompt.includes('d3-fix') || prompt.includes('D3 FIX')) return 'D3'
  return null
}

export function defaultCannedData(phase: PhaseKey): unknown {
  switch (phase) {
    case 'QUICK-SEED': return CANNED_QUICK_SEED
    case 'P1': return CANNED_P1
    case 'P2': return CANNED_P2
    case 'P3': return CANNED_P3
    case 'P4': return CANNED_P4
    case 'P5': return CANNED_P5
    case 'P6': return CANNED_P6
    default: return {}
  }
}

export function extractExpectFile(prompt: string): string | null {
  // Standard format: "Write your result as valid JSON to: <path>"
  const stdMatch = prompt.match(/Write your result as valid JSON to:\s*(\S+)/)
  if (stdMatch?.[1]) return stdMatch[1].trim()

  // Quick-seed format: "**`<path>`** (combined seed):"
  // The controller writes:  `**\`${seedFile}\`** (combined seed):`
  const seedMatch = prompt.match(/\*\*`([^`]+)`\*\*\s*\(combined seed\)/)
  if (seedMatch?.[1]) return seedMatch[1].trim()

  return null
}

// ── StubHost ──────────────────────────────────────────────────────────────────

export interface StubHostOptions {
  /** Called before writing each canned file — useful for side effects. */
  beforeWrite?: (phase: PhaseKey | null, expectFile: string, data: unknown) => Promise<void>
}

export interface StubHostInstallTarget {
  sendUserMessage: ReturnType<typeof vi.fn>
}

/** The mock pi shape that StubHost needs for installation. */
export type MockPiForStub = {
  sendUserMessage: ReturnType<typeof vi.fn>
}

export class StubHost {
  /** All prompts received by the stub (populated by mockImplementation). */
  readonly steeredPrompts: string[] = []
  private steerCount = 0
  private _fire!: (event: string, e: unknown, ctx?: unknown) => unknown
  private _ctx!: unknown

  constructor(private opts: StubHostOptions = {}) {}

  /**
   * Install the stub on a mock pi object.
   * Replaces pi.sendUserMessage with an impl that writes canned files + fires agent_end.
   * NOTE: replaces the original mockImplementation — callers who need prompt capture
   * should use `stub.steeredPrompts` rather than tracking via the original array.
   */
  install(
    pi: MockPiForStub,
    fire: (event: string, e: unknown, ctx?: unknown) => unknown,
    ctx: unknown
  ): void {
    this._fire = fire
    this._ctx = ctx

    pi.sendUserMessage.mockImplementation((prompt: string) => {
      // Record the prompt for test assertions
      this.steeredPrompts.push(prompt)
      // Handle async without blocking sendUserMessage (which is void)
      void this._handleSteer(prompt)
    })
  }

  private async _handleSteer(prompt: string): Promise<void> {
    this.steerCount++
    const expectFile = extractExpectFile(prompt)
    const phase = detectPhase(prompt)
    const data = phase !== null ? defaultCannedData(phase) : {}

    if (expectFile) {
      if (this.opts.beforeWrite) {
        await this.opts.beforeWrite(phase, expectFile, data)
      }
      await fs.mkdir(path.dirname(expectFile), { recursive: true })
      await fs.writeFile(expectFile, JSON.stringify(data, null, 2))
    }

    // Give the file write a tick to flush
    await new Promise(r => setImmediate(r))

    // Fire turn_end then agent_end to resolve the steer promise
    this._fire('turn_end', makeTurnEndEvent(), this._ctx)
    this._fire('agent_end', makeAgentEndEvent(`stub: ${phase ?? 'unknown'} #${this.steerCount}`), this._ctx)
  }

  get steersHandled(): number {
    return this.steerCount
  }
}

// ── Event factories ───────────────────────────────────────────────────────────

export function makeAgentEndEvent(rawText = 'stub done'): AgentEndEvent {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: rawText }] }],
  } as unknown as AgentEndEvent
}

export function makeTurnEndEvent(): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 0,
    message: { role: 'assistant', content: [] },
    toolResults: [],
  } as unknown as TurnEndEvent
}

// ── Shared mock factories ─────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: unknown) => unknown

export function makeMockPi(): {
  pi: ExtensionAPI
  handlers: Record<string, EventHandler>
  /** Prompts recorded by the ORIGINAL impl — emptied when stub.install() replaces it.
   *  Use stub.steeredPrompts after stub.install() for accurate recording. */
  steerPrompts: string[]
  fire(event: string, e: unknown, ctx?: unknown): unknown
} {
  const handlers: Record<string, EventHandler> = {}
  const steerPrompts: string[] = []

  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => { handlers[event] = handler }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn((content: string) => { steerPrompts.push(content) }),
  } as unknown as ExtensionAPI

  const fire = (event: string, e: unknown, ctx: unknown = makeExtCtx()) =>
    handlers[event]?.(e, ctx)

  return { pi, handlers, steerPrompts, fire }
}

export function makeExtCtx(): ExtensionContext {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    compact: vi.fn(({ onComplete }: { onComplete: () => void }) => { setImmediate(onComplete) }),
  } as unknown as ExtensionContext
}

export function makeInputEvent(
  text: string,
  source: 'interactive' | 'rpc' | 'extension' = 'interactive'
): InputEvent {
  return { type: 'input', text, source } as unknown as InputEvent
}

export function makeSessionStartEvent(): SessionStartEvent {
  return { type: 'session_start' } as unknown as SessionStartEvent
}

export function makeNullTransparency(): Transparency {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    setHudStatus: vi.fn(),
    recordMetric: vi.fn().mockResolvedValue(undefined),
  }
}

export function makeNullVerifier(): Verifier {
  return {
    runDeterministic: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, output: 'suite ok' }),
    runMutation: vi.fn().mockResolvedValue({ score: 1.0, passed: true }),
    runHoldout: vi.fn().mockResolvedValue({ passed: true, output: '' }),
    runSecurityScan: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
  }
}

export function makeNullJudge(): Judge {
  return {
    isDone: vi.fn().mockResolvedValue(true),
    isStillRight: vi.fn().mockResolvedValue({ aligned: true }),
  }
}

export function makeNullGitOps(): GitOps & { capturedSha: string; capturedMessage: string } {
  const ops = {
    capturedSha: '',
    capturedMessage: '',
    scopedCommit: vi.fn().mockImplementation(async (msg: string, _paths: string[]) => {
      ops.capturedMessage = msg
      ops.capturedSha = 'e2e-commit-' + Date.now()
      return { sha: ops.capturedSha }
    }),
    perPhasePush: vi.fn().mockResolvedValue(undefined),
    tierDGate: vi.fn().mockResolvedValue(true),
    scanSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [] }),
    changedFiles: vi.fn().mockResolvedValue(['src/utils.ts']),
  }
  return ops
}

// ── B1 teardown-settle: wait for lock to appear then disappear ────────────────
//
// Pattern from controller-debug-track.test.ts:
//   Phase 1: poll until lock EXISTS (run acquired it).
//   Phase 2: poll until lock GONE (run released it).
//   Small final settle for async log writes.
//
// If lock never appears within the first 2s, that means either:
//   (a) the run completed synchronously before we checked, OR
//   (b) the run never started (bug). Either way we fall through.

export async function waitForLockRelease(repoDir: string, timeoutMs = 8_000): Promise<void> {
  const lockPath = path.join(repoDir, '.autodev', 'running.lock')
  const deadline = Date.now() + timeoutMs

  // Phase 1: wait for lock to appear (up to 2s)
  const appearDeadline = Date.now() + 2_000
  let lockSeen = false
  while (Date.now() < appearDeadline) {
    const exists = await fs.access(lockPath).then(() => true).catch(() => false)
    if (exists) { lockSeen = true; break }
    await new Promise(r => setTimeout(r, 10))
  }

  if (!lockSeen) {
    // Lock never appeared — run may have completed before we got here.
    // Give a brief extra settle for async writes to flush.
    await new Promise(r => setTimeout(r, 50))
    return
  }

  // Phase 2: wait for lock to disappear (run released it)
  while (Date.now() < deadline) {
    const exists = await fs.access(lockPath).then(() => true).catch(() => false)
    if (!exists) break
    await new Promise(r => setTimeout(r, 15))
  }

  // Final settle for async journal/log writes
  await new Promise(r => setTimeout(r, 30))
}
