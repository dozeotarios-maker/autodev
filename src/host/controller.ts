// S2-M2: Controller — event-loop orchestrator for the pi long-host-session.
//
// Architecture:
//   session_start → ARMED
//   input (idea)  → ARMED→RUNNING + run-lock + start P1
//   agent_end     → hand to active phase executor → read file → gate → advance
//   At each phase boundary: compactAsync(ctx) must resolve before next steer.
//   context event → mask stale phase messages (ObservationMasker extended).
//   tool_call     → H1 contract + action-monitor.
//
// Port interfaces only for Verifier, GitOps, Judge — no concrete imports from src/verify, src/git.

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  SessionStartEvent,
  InputEvent,
  AgentEndEvent,
  TurnEndEvent,
  ContextEvent,
  ToolCallEvent,
  ToolCallEventResult,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent'
import type { Verifier, GitOps, Judge, Transparency, MemoryStore, Embedder, SecurityLane, BoundedExec } from '../ports.js'
import { HostAgent } from './host-agent.js'
import { SubagentDriver } from './subagent-driver.js'
import { FSM } from '../engine/fsm.js'
import { Lifecycle } from '../engine/lifecycle.js'
import { Journal } from '../engine/journal.js'
import { ActionMonitor } from '../safety/action-monitor.js'
import { ObservationMasker } from '../safety/masking.js'
import type { Message } from '../safety/masking.js'
import { P1Discover } from '../phases/p1-discover.js'
import { P2Elaborate } from '../phases/p2-elaborate.js'
import { P3Plan } from '../phases/p3-plan.js'
import { P4Build } from '../phases/p4-build.js'
import { P5Verify } from '../phases/p5-verify.js'
import { P6Release } from '../phases/p6-release.js'
import type { P1Output, P2Output, P3Output, P4Output, P5Output } from '../phases/phase-output.js'
import { validateP1Output, validateP3Output } from '../phases/phase-output.js'
import { D1Reproduce } from '../debug/d1-reproduce.js'
import { D2RootCause } from '../debug/d2-root-cause.js'
import { D3Fix } from '../debug/d3-fix.js'
import { runD4Gate } from '../debug/d4-verify.js'
import { runD5Ship } from '../debug/d5-ship.js'
import { checkReproFaithfulness } from '../debug/faithfulness-check.js'
import { isHarnessError } from '../debug/harness-error.js'
import type { D1Output, D2Output, D3Output } from '../debug/debug-output.js'
import { MAX_DEBUG_ROUNDS } from '../debug/debug-output.js'
import { R1Characterize } from '../refactor/r1-characterize.js'
import { R2Transform } from '../refactor/r2-transform.js'
import { runR3Gate } from '../refactor/r3-verify.js'
import { runR4Ship } from '../refactor/r4-ship.js'
import type { R1Output, R2Output } from '../refactor/refactor-output.js'
import { MAX_REFACTOR_ROUNDS } from '../refactor/refactor-output.js'
import { scoreComplexity, tierSizing, DEFAULT_SIZING, isValidComplexityInput, tierFromOverride, gearFromForced } from '../engine/complexity.js'
import type { Sizing, ComplexityInput, ComplexityTier, Gear } from '../engine/complexity.js'
import { MINIMALISM_DIRECTIVE, CRAFTSMANSHIP_DIRECTIVE } from '../principles.js'
import type { RetroWriter } from '../engine/retro.js'
import { resolveProjectDir } from '../project/resolver.js'
import type { ProjectRegistry } from '../project/registry.js'

// ── compactAsync ─────────────────────────────────────────────────────────────

/** Default compaction timeout (ms). Overridable for tests. */
export const COMPACT_TIMEOUT_MS = 45_000

/** Context-usage threshold above which compaction is triggered (0–100 scale, matching ContextUsage.percent). */
const COMPACT_USAGE_THRESHOLD = 70

/**
 * Decide whether the context actually needs compaction.
 *
 * Strategy: use ctx.getContextUsage() (available on ExtensionContext since pi
 * updated its API). If usage.percent is available, skip unless >= threshold.
 * If usage is unknown (returns undefined / null percent), allow compaction —
 * i.e. fail-open so we don't skip when we can't tell.
 *
 * ContextUsage.percent is 0–100 (NOT 0–1). COMPACT_USAGE_THRESHOLD=70 means
 * "compact when context is 70% or more full".
 *
 * getContextUsage() can throw (e.g. assertActive on a stale instance). Wrap in
 * try/catch and fail-open (return true) so a throw never silently skips compaction.
 */
export function shouldCompact(ctx: ExtensionContext): boolean {
  try {
    const usage = (ctx as unknown as { getContextUsage?: () => { percent: number | null } | undefined }).getContextUsage?.()
    if (!usage) return true // unknown — allow
    if (usage.percent === null || usage.percent === undefined) return true // unknown — allow
    return usage.percent >= COMPACT_USAGE_THRESHOLD
  } catch {
    return true // getContextUsage threw (stale instance etc.) — fail-open
  }
}

/**
 * Promise wrapper over ctx.compact({ onComplete, onError }) with:
 *   - Conditional: skips unless shouldCompact() says the context is near-full.
 *   - Timeout: races compact against timeoutMs (default COMPACT_TIMEOUT_MS).
 *     On timeout → resolves (skip, log via onTimeout callback), never hangs.
 *   - Double-settle guard: late onComplete/onError after timeout are no-ops.
 *
 * The controller MUST await this before the next steer — otherwise the next
 * message lands in a pre-compaction context.
 *
 * @param onTimeout - optional callback invoked when the timeout path fires,
 *   so callers (the controller) can journal the skip without needing a
 *   journal reference here.
 */
export function compactAsync(
  ctx: ExtensionContext,
  timeoutMs: number = COMPACT_TIMEOUT_MS,
  onTimeout?: () => void
): Promise<void> {
  // Conditional: skip when context is not near the limit
  if (!shouldCompact(ctx)) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return // double-settle guard
      settled = true
      fn()
    }

    // Timeout race: resolve (skip) after timeoutMs — never escalate, never hang
    const timer = setTimeout(() => {
      settle(() => {
        console.warn('[pi-autodev] compaction skipped: timeout')
        onTimeout?.()
        resolve()
      })
    }, timeoutMs)

    ctx.compact({
      onComplete: () => {
        clearTimeout(timer)
        settle(() => resolve())
      },
      onError: (err: Error) => {
        clearTimeout(timer)
        // "Nothing to compact" on a small session at a phase boundary is benign — skip it.
        // "Already compacted" fires on back-to-back zero-work compaction at phase boundaries
        // (the session hasn't grown since the last compaction). Also benign — skip it.
        if (/nothing to compact|too small|already compacted/i.test(err.message)) {
          settle(() => resolve())
        } else {
          settle(() => reject(err))
        }
      },
    })
  })
}

// ── PhaseContextStore — accumulates typed outputs across phases ───────────────

interface PhaseStore {
  p1?: P1Output
  p2?: P2Output
  p3?: P3Output
  p4?: P4Output
  p5?: P5Output
}

// ── Controller options ────────────────────────────────────────────────────────

export interface ControllerOptions {
  repoRoot: string
  verifier: Verifier
  gitOps: GitOps
  judge: Judge
  transparency: Transparency
  /** Mid-steer timeout ms. Default: 600000 (10 min) */
  steerTimeoutMs?: number
  /** Pause-file path; default .autodev/PAUSE */
  pauseFilePath?: string
  /** B3a: timeout ms for ctx.ui.select / ctx.ui.input dialogues. Default: 300000 (5 min). */
  dialogueTimeoutMs?: number
  /** Optional RetroWriter for post-run retro (injected for test isolation) */
  retroWriter?: RetroWriter
  /** Optional memory backends — wired at entry; consumed by P1 and retro. */
  memoryStore?: MemoryStore
  embedder?: Embedder
  codebaseMemory?: {
    healthCheck(): Promise<{ ok: boolean; details?: string }>
    ensureIndexed?(): Promise<void>
    /** Re-root the indexer to the resolved dir (resets cached index). */
    setRepoRoot?(dir: string): void
    /** Find call-sites for a symbol. Optional — degrades gracefully via ?. chaining. */
    findCallers?(symbol: string): Promise<Array<{ file: string; symbol?: string }>>
  }
  /** Optional security lane — used to screen recalled memory before injecting into instructions. */
  securityLane?: SecurityLane
  /** Optional project registry — when injected, _resolveRepoRoot re-roots the build dir from the idea. */
  registry?: ProjectRegistry
  /** Optional bounded executor — runs untrusted repro commands with timeout + action-monitor gate. */
  boundedExec?: BoundedExec
}

// ── B1: Override-prefix parser ────────────────────────────────────────────────

const TASK_TYPE_PREFIXES = new Set(['build', 'debug', 'refactor'])

export interface ParsedOverrides {
  idea: string
  forcedTier?: ComplexityTier
  taskType: string
  /** B3a: true when a `step:` prefix was present — enables phase-by-phase gate. */
  phaseByPhase: boolean
}

/**
 * Strip up to three known leading prefixes from a raw idea string.
 * quick/mid/full → sets forcedTier; build/debug/refactor → sets taskType (default 'build').
 * step: → sets phaseByPhase=true (does NOT set taskType or forcedTier).
 * Only KNOWN leading tokens matched by the regex
 * `^(quick|mid|full|build|debug|refactor|step)\s*:\s*` (case-insensitive) are stripped.
 * Mid-sentence colons are untouched.
 */
export function parseOverrides(raw: string): ParsedOverrides {
  let idea = raw
  let forcedTier: ComplexityTier | undefined
  let taskType = 'build'
  let phaseByPhase = false
  const PREFIX_RE = /^(quick|mid|full|build|debug|refactor|step)\s*:\s*/i

  for (let i = 0; i < 3; i++) {
    const m = PREFIX_RE.exec(idea)
    if (!m) break
    const token = m[1].toLowerCase()
    idea = idea.slice(m[0].length)
    if (token === 'step') {
      phaseByPhase = true
    } else {
      const tier = tierFromOverride(token)
      if (tier !== null) {
        forcedTier = tier
      } else if (TASK_TYPE_PREFIXES.has(token)) {
        taskType = token
      }
    }
  }

  return { idea, forcedTier, taskType, phaseByPhase }
}

// ── Controller ────────────────────────────────────────────────────────────────

export class Controller {
  private readonly hostAgent: HostAgent
  private readonly subagentDriver: SubagentDriver
  private readonly fsm: FSM
  private readonly lifecycle: Lifecycle
  private journal: Journal
  private actionMonitor: ActionMonitor
  private readonly masker: ObservationMasker
  private outputDir: string
  private pauseFilePath: string
  private repoRoot: string
  /**
   * Original process.cwd() captured immediately before the registry-injected
   * re-root chdir's into the resolved dir. Restored when the run terminates so a
   * later non-autodev pi command isn't surprised by a moved cwd. Undefined means
   * no chdir happened (no-registry path, or chdir failed), so restore is a no-op.
   */
  private originalCwd: string | undefined

  private phaseStore: PhaseStore = {}
  private currentIdea = ''
  private startedAt = Date.now()
  private currentSizing: Sizing = DEFAULT_SIZING
  private currentTier: ComplexityTier = 'M'
  /** B1: forced tier from override prefix (quick:/mid:/full:). Undefined = no override. */
  private currentForcedTier: ComplexityTier | undefined
  /** B1: task type from prefix (build/debug/refactor). Default 'build'. */
  private currentTaskType = 'build' // B2-consumed: Stage B2 routing reads this; do not remove as "unused".
  /** B2: gear derived from forced tier (quick/middle/full). Undefined = no prefix → full path. */
  private currentGear: Gear | undefined
  private currentRunId = ''
  /** Fix #1: set true after the first terminal store so _escalate cannot double-store. */
  private _terminalStored = false
  /** B3a: true when a `step:` prefix was seen — enables phase-by-phase gate in _runPhases. */
  private phaseByPhase = false
  /** B3b: true when the most-recent _resolveRepoRoot resolved a brand-new project. */
  private resolvedIsNew = false
  /** B3b: intent gathered from the intent gate; undefined when gate skipped or no input given. */
  private currentIntent: { useCase?: string; scale?: string; audience?: string } | undefined
  /** C-1: active debug-track step label (e.g. 'D1', 'D2', 'D3', 'D4', 'D5'). Undefined when not in debug track. */
  private currentDebugStep: string | undefined
  /** Stage D: active refactor-track step label (e.g. 'R1', 'R2', 'R3', 'R4'). Undefined when not in refactor track. */
  private currentRefactorStep: string | undefined

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly opts: ControllerOptions
  ) {
    this.repoRoot = opts.repoRoot
    this.hostAgent = new HostAgent(pi)
    this.subagentDriver = new SubagentDriver(this.hostAgent)
    this.fsm = new FSM({
      onJournal: (entry) => {
        void this.journal.write({
          type: 'transition',
          phase: entry.phase,
          action: `FSM → ${entry.phase}${entry.backedge ? ' (backedge)' : ''}`,
        })
      },
    })
    this.lifecycle = new Lifecycle({
      cwd: opts.repoRoot,
      onArmed: async () => {
        await opts.transparency.log('lifecycle: ARMED')
        opts.transparency.setHudStatus('ARMED', '', 'idle', 'none')
      },
      onRunning: async () => {
        await opts.transparency.log('lifecycle: RUNNING')
        opts.transparency.setHudStatus('P1', this.currentIdea.slice(0, 60), 'running', 'opus')
      },
    })
    this.journal = new Journal(path.join(opts.repoRoot, '.autodev', 'journal.jsonl'))
    this.actionMonitor = new ActionMonitor([opts.repoRoot])
    this.masker = new ObservationMasker(20)
    this.outputDir = path.join(opts.repoRoot, '.autodev', 'phase-output')
    this.pauseFilePath = opts.pauseFilePath ?? path.join(opts.repoRoot, '.autodev', 'PAUSE')
  }

  // ── Wire all pi events ────────────────────────────────────────────────────

  wire(): void {
    this.pi.on('session_start', (_e: SessionStartEvent, ctx: ExtensionContext) => {
      return this._onSessionStart(ctx)
    })

    this.pi.on('input', (e: InputEvent, ctx: ExtensionContext) => {
      return this._onInput(e, ctx)
    })

    this.pi.on('agent_end', (e: AgentEndEvent, _ctx: ExtensionContext) => {
      this.hostAgent._onAgentEnd(e)
    })

    this.pi.on('turn_end', (e: TurnEndEvent, _ctx: ExtensionContext) => {
      this.hostAgent._onTurnEnd(e)
    })

    this.pi.on('context', (e: ContextEvent, _ctx: ExtensionContext) => {
      // Mask stale tool results to keep context clean (G9).
      // Return ContextEventResult shape: { messages? } — pi reads this to rewrite the array.
      const masked = this.masker.mask(e.messages as unknown as Message[])
      return { messages: masked } as { messages: typeof e.messages }
    })

    this.pi.on('tool_call', (e: ToolCallEvent, _ctx: ExtensionContext): ToolCallEventResult => {
      return this._onToolCall(e)
    })

    this.pi.on('session_before_compact', (_e: SessionBeforeCompactEvent, _ctx: ExtensionContext) => {
      return this._onBeforeCompact()
    })
  }

  // ── registerCommands ──────────────────────────────────────────────────────

  registerCommands(): void {
    this.pi.registerCommand('/autodev-status', {
      description: 'Show current autodev phase, task, and uptime',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const uptime = Math.floor((Date.now() - this.startedAt) / 1000)
        let activeProject: string | undefined
        if (this.opts.registry) {
          try { activeProject = await this.opts.registry.getActive() } catch { /* degrade */ }
        }
        const status = {
          phase: this.fsm.getPhase(),
          task: this.currentIdea.slice(0, 80),
          laneStatus: this.lifecycle.getState(),
          model: 'opus',
          uptime: `${uptime}s`,
          repoRoot: this.repoRoot,
          activeProject: activeProject ?? '(none)',
          gear: this.currentGear ?? 'full',
          phaseByPhase: this.phaseByPhase,
          intentCaptured: this.currentIntent !== undefined,
          debugStep: this.currentDebugStep ?? null,
          refactorStep: this.currentRefactorStep ?? null,
        }
        ctx.ui.notify(JSON.stringify(status, null, 2), 'info')
      },
    })

    this.pi.registerCommand('/autodev-config', {
      description: 'Show autodev configuration',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify(`[pi-autodev] repoRoot=${this.repoRoot}`, 'info')
      },
    })

    this.pi.registerCommand('/autodev-project', {
      description: 'Set or list registered projects. Usage: /autodev-project [name]',
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const name = args.trim()
        if (!this.opts.registry) {
          ctx.ui.notify('[pi-autodev] No registry configured', 'warning')
          return
        }
        if (name) {
          // Fix 3: validate name charset/length.
          // Item 5: also reject '.', '..', and all-dot names ('...' etc.) — they pass
          // the charset regex but are filesystem-relative path components, never valid
          // project identifiers.
          const isAllDots = /^\.+$/.test(name)
          if (name.length > 64 || !/^[a-zA-Z0-9_\-\.]+$/.test(name) || isAllDots) {
            ctx.ui.notify(
              `[pi-autodev] Invalid project name "${name.slice(0, 40)}": must be ≤64 chars, [a-zA-Z0-9_\\-.] only, and not an all-dot name (. .. ...)`,
              'warning'
            )
            return
          }

          const cwd = process.cwd()

          // Fix 3: reject if cwd is $HOME or an ancestor of $HOME
          const home = os.homedir()
          const cwdReal = (() => { try { return path.resolve(cwd) } catch { return cwd } })()
          const homeReal = (() => { try { return path.resolve(home) } catch { return home } })()
          const cwdIsHome = cwdReal === homeReal || homeReal.startsWith(cwdReal + path.sep)
          // Fix 3: reject if cwd lacks both .git and package.json
          const hasDotGit = await fs.access(path.join(cwd, '.git')).then(() => true).catch(() => false)
          const hasPkgJson = await fs.access(path.join(cwd, 'package.json')).then(() => true).catch(() => false)

          if (cwdIsHome) {
            ctx.ui.notify(
              `[pi-autodev] Cannot register project at $HOME or an ancestor — navigate to a project dir first`,
              'warning'
            )
            return
          }
          if (!hasDotGit && !hasPkgJson) {
            ctx.ui.notify(
              `[pi-autodev] cwd "${cwd}" lacks both .git and package.json — navigate to a project dir first`,
              'warning'
            )
            return
          }

          // Fix 3: if name already maps to a DIFFERENT dir, refuse to silently repoint
          const existing = await this.opts.registry.get(name)
          if (existing && path.resolve(existing.dir) !== path.resolve(cwd)) {
            ctx.ui.notify(
              `[pi-autodev] Project "${name}" already registered at "${existing.dir}" — refusing to repoint to "${cwd}". Use a different name.`,
              'warning'
            )
            return
          }

          if (!existing) {
            await this.opts.registry.register(name, cwd)
          }
          await this.opts.registry.setActive(name)
          const meta = await this.opts.registry.get(name)
          ctx.ui.notify(`[pi-autodev] Active project: ${name} -> ${meta?.dir ?? cwd}`, 'info')
        } else {
          // List all registered projects + active
          const projects = await this.opts.registry.list()
          const active = await this.opts.registry.getActive()
          const lines = projects.map(p => `${p.name === active ? '* ' : '  '}${p.name} -> ${p.dir}`)
          const msg = lines.length > 0
            ? `[pi-autodev] Projects (active=*):\n${lines.join('\n')}`
            : '[pi-autodev] No projects registered'
          ctx.ui.notify(msg, 'info')
        }
      },
    })

    this.pi.registerCommand('/autodev-tokens', {
      description: 'Show token usage location',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify('[pi-autodev] token usage: see .autodev/metrics.jsonl', 'info')
      },
    })

    this.pi.registerCommand('/autodev-pause', {
      description: 'Pause autodev between phases',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        await fs.mkdir(path.dirname(this.pauseFilePath), { recursive: true })
        await fs.writeFile(this.pauseFilePath, new Date().toISOString())
        ctx.ui.notify('[pi-autodev] Paused — use /autodev-resume to continue', 'info')
      },
    })

    this.pi.registerCommand('/autodev-resume', {
      description: 'Resume autodev after pause',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        try { await fs.unlink(this.pauseFilePath) } catch { /* not paused */ }
        ctx.ui.notify('[pi-autodev] Resumed', 'info')
      },
    })

    this.pi.registerCommand('/autodev-doctor', {
      description: 'Health-check autodev backends',
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const checks: string[] = []
        try {
          await fs.access(this.opts.repoRoot)
          checks.push('repoRoot: OK')
        } catch {
          checks.push('repoRoot: MISSING')
        }
        try {
          await fs.access(this.outputDir)
          checks.push('outputDir: OK')
        } catch {
          checks.push('outputDir: not yet created (normal before first run)')
        }
        const probe = async (name: string, hc?: { healthCheck(): Promise<{ ok: boolean; details?: string }> }) => {
          if (!hc) { checks.push(`${name}: not wired`); return }
          try {
            const r = await hc.healthCheck()
            checks.push(`${name}: ${r.ok ? 'OK' : 'DOWN'}${r.details ? ' (' + r.details + ')' : ''}`)
          } catch (e) {
            checks.push(`${name}: ERROR (${e instanceof Error ? e.message : String(e)})`)
          }
        }
        await probe('letta (memory)', this.opts.memoryStore)
        await probe('embedder', this.opts.embedder)
        await probe('codebase-memory', this.opts.codebaseMemory)
        ctx.ui.notify(`[pi-autodev doctor]\n${checks.join('\n')}`, 'info')
      },
    })
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private async _onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.startedAt = Date.now()
    await this.lifecycle.arm()
    await this.opts.transparency.log('session_start: ARMED')
    ctx.ui.setStatus('autodev', 'ARMED')
  }

  private async _onInput(e: InputEvent, ctx: ExtensionContext): Promise<void> {
    // Filter self-originated steers: pi echoes sendUserMessage back through the `input`
    // event with source='extension'. These are autodev's own steer messages — the host LLM
    // acts on them; the controller observes the result via agent_end, NOT via the input event.
    if (e.source === 'extension') {
      await this.opts.transparency.log('input ignored (self-steer, source=extension)')
      return
    }

    const text = e.text ?? ''

    // Detect idea vs question: ideas are statements, not questions or commands
    const isIdea = text.trim().length > 10 && !text.trim().endsWith('?') && !text.startsWith('/')
    if (!isIdea) {
      await this.opts.transparency.log(`input: question/command, stays ARMED`)
      return
    }

    // B1: parse override prefixes (quick:/mid:/full:/build:/debug:/refactor:) before
    // lock acquisition — strips the idea to its bare form, captures forcedTier/taskType locally.
    const parsed = parseOverrides(text.trim())
    const idea = parsed.idea

    // B1 review: guard against inputs that pass isIdea (>10 chars raw) but reduce to an empty
    // idea after prefix stripping (e.g. "quick: mid:", "build: quick:"). Running lifecycle.run('')
    // on an empty idea wastes a P1 spec-gen turn; bail early and stay ARMED.
    if (idea.trim().length === 0) {
      await this.opts.transparency.log('input: empty after prefix strip, stays ARMED')
      return
    }

    // Fix 6 (TOCTOU): lifecycle.run() is the SINGLE atomic source of truth.
    // It sets internal state to RUNNING synchronously before any async I/O, so
    // a second concurrent input() calling run() concurrently will see RUNNING
    // and get { ok: false } — no racy pre-check needed.
    //
    // We kick off run() and set the eager UI status concurrently so tests can
    // observe the RUNNING transition after a single tick (lifecycle flips state
    // synchronously inside run() before awaiting I/O).
    const runPromise = this.lifecycle.run(idea)

    // Eagerly set RUNNING status (lifecycle already flipped state synchronously).
    // Use the local `idea` — this.currentIdea is not set until lock is confirmed.
    await this.opts.transparency.log(`ARMED→RUNNING: idea="${idea.slice(0, 60)}"`)
    ctx.ui.setStatus('autodev', 'RUNNING')
    this.opts.transparency.setHudStatus('P1', idea.slice(0, 60), 'running', 'opus')

    const runResult = await runPromise
    if (!runResult.ok) {
      // Lock denied — another instance holds it; roll back UI state
      await this.opts.transparency.log(`input ignored (already RUNNING): ${text.slice(0, 40)}`)
      ctx.ui.notify(`[pi-autodev] Cannot start: ${runResult.reason}`, 'warning')
      ctx.ui.setStatus('autodev', 'ARMED')
      return
    }

    // Lock won — now safe to update the shared fields.
    this.currentIdea = idea
    this.currentForcedTier = parsed.forcedTier
    this.currentTaskType = parsed.taskType
    // B3a: phase-by-phase mode from step: prefix
    this.phaseByPhase = parsed.phaseByPhase
    // B2: derive gear from forced tier (undefined when no prefix → full path auto)
    this.currentGear = gearFromForced(parsed.forcedTier)
    void this.journal.write({
      type: 'decision',
      phase: 'P1',
      action: `overrides parsed: forcedTier=${parsed.forcedTier ?? 'none'} taskType=${parsed.taskType} gear: ${this.currentGear ?? 'full'} task-type: ${parsed.taskType}`,
    })

    // Re-root repoRoot to the resolved project dir (async, before _runPhases).
    // _resolveRepoRoot is a no-op when no registry is injected (preserves current behavior).
    await this._resolveRepoRoot(idea)

    // B2: Task-type router — debug runs _runDebugTrack; refactor escalates with stub.
    // Finding 2 fix: reset currentRunId + _terminalStored here, mirroring the phase-method
    // preamble, so _escalate tags this escalation under a fresh run id (not the previous run's).
    if (this.currentTaskType === 'debug') {
      this.currentRunId = `run-${crypto.randomUUID()}`
      this._terminalStored = false
      this.currentDebugStep = undefined
      void this._runDebugTrack(ctx)
      return
    }
    if (this.currentTaskType === 'refactor') {
      this.currentRunId = `run-${crypto.randomUUID()}`
      this._terminalStored = false
      this.currentRefactorStep = undefined
      void this._runRefactorTrack(ctx)
      return
    }

    // B2: Gear dispatch — quick/middle gear methods fire ONLY on explicit prefix.
    // No-prefix (currentGear===undefined) always runs the full _runPhases (unchanged).
    // Auto-downshift is out of scope for B2.
    if (this.currentGear === 'quick') {
      void this._runPhasesQuick(ctx)
    } else if (this.currentGear === 'middle') {
      void this._runPhasesMiddle(ctx)
    } else {
      // full gear (explicit full: prefix) OR no prefix (undefined) → unchanged full path
      void this._runPhases(ctx)
    }
  }

  private _onToolCall(e: ToolCallEvent): ToolCallEventResult {
    // H1: check bash commands for dangerous patterns
    if (e.type === 'tool_call' && 'input' in e) {
      const input = (e as unknown as { input?: Record<string, unknown> }).input
      const toolName = (e as unknown as { toolName?: string }).toolName ?? ''

      if ((toolName === 'bash' || toolName === 'shell') && input) {
        const cmd = input['command'] as string | undefined
        if (cmd) {
          const check = this.actionMonitor.checkBashCommand(cmd)
          if (!check.allowed) {
            void this.journal.write({
              type: 'decision',
              phase: this.fsm.getPhase(),
              action: `BLOCKED bash: ${cmd.slice(0, 80)} — ${check.reason}`,
            })
            return { block: true, reason: check.reason }
          }
        }
      }

      const WRITE_TOOLS = new Set(['write', 'create_file', 'write_file', 'edit', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool'])
      if (WRITE_TOOLS.has(toolName) && input) {
        // Fix 2: fail-closed path extraction — add more keys and handle array shapes.
        // If the tool is a known write tool but no path resolves, BLOCK (fail closed).
        const filePaths: string[] = []

        // Single-path keys
        const singlePath = (
          input['file_path'] as string | undefined ??
          input['path'] as string | undefined ??
          input['target_file'] as string | undefined ??
          input['filename'] as string | undefined ??
          input['notebook_path'] as string | undefined ??
          input['dst'] as string | undefined
        )
        if (singlePath) filePaths.push(singlePath)

        // Array shapes: edits/files arrays of {path} or {file_path}
        const editsArr = input['edits']
        if (Array.isArray(editsArr)) {
          for (const item of editsArr) {
            if (item && typeof item === 'object') {
              const p = (item as Record<string, unknown>)['path'] ?? (item as Record<string, unknown>)['file_path']
              if (typeof p === 'string') filePaths.push(p)
            }
          }
        }
        const filesArr = input['files']
        if (Array.isArray(filesArr)) {
          for (const item of filesArr) {
            if (item && typeof item === 'object') {
              const p = (item as Record<string, unknown>)['path'] ?? (item as Record<string, unknown>)['file_path']
              if (typeof p === 'string') filePaths.push(p)
            }
          }
        }

        // Fix 2: fail closed — if no path found, block the write tool
        if (filePaths.length === 0) {
          void this.journal.write({
            type: 'decision',
            phase: this.fsm.getPhase(),
            action: `BLOCKED write tool ${toolName}: unrecognized path shape`,
          })
          return { block: true, reason: 'write tool, unrecognized path shape' }
        }

        // Check each resolved path
        for (const filePath of filePaths) {
          const absPath = path.resolve(filePath)
          const check = this.actionMonitor.checkFileWrite(absPath)
          if (!check.allowed) {
            void this.journal.write({
              type: 'decision',
              phase: this.fsm.getPhase(),
              action: `BLOCKED write: ${filePath} — ${check.reason}`,
            })
            return { block: true, reason: check.reason }
          }
        }
      }
    }
    return {}
  }

  private async _onBeforeCompact(): Promise<void> {
    // Defensive flush: ensure phase files are on disk before compaction.
    const phase = this.fsm.getPhase()
    await this.journal.write({
      type: 'checkpoint-ref',
      phase,
      action: 'session_before_compact: phase files should already be on disk',
    })
  }

  // ── isPaused ──────────────────────────────────────────────────────────────

  private async _isPaused(): Promise<boolean> {
    try {
      await fs.access(this.pauseFilePath)
      return true
    } catch {
      return false
    }
  }

  // ── Phase runner ──────────────────────────────────────────────────────────

  /**
   * Main phase execution loop.
   * Runs P1→P6 sequentially; compacts at each phase boundary;
   * handles backedge (P4→P3) and mid-steer timeout.
   *
   * Fix 8 (defensive assumption): `ctx` (ExtensionContext) is the context object
   * passed in from the `input` event handler. It is assumed to remain valid and
   * reusable across all phases within a single run. The pi runtime guarantees this
   * for the duration of a session; do not cache ctx across sessions or after
   * lifecycle.release() returns.
   */
  private async _runPhases(ctx: ExtensionContext): Promise<void> {
    try {
      // ── Run-start: default tier M (or forced tier from prefix override) ──────
      this.currentRunId = `run-${crypto.randomUUID()}`
      this._terminalStored = false // Fix #1: reset per-run so consecutive runs don't share state
      // B3b: reset intent per-run; resolvedIsNew was already reset at top of _resolveRepoRoot
      this.currentIntent = undefined
      // B3a: phaseByPhase is NOT reset here — it is unconditionally reassigned from
      // parsed.phaseByPhase in _onInput's lock-won block (line ~578) on every new input
      // event, which is sufficient: each run always reflects the most-recent input's
      // step: prefix state, with no risk of stale carry-over between consecutive runs.
      // per-phase adjust counters are local vars in _runPhaseGate, no instance field needed
      const pi = this.pi as unknown as { setThinkingLevel?: (level: string) => void }
      if (this.currentForcedTier) {
        // B1: forced tier from quick:/mid:/full: prefix — use directly, skip rescore later
        this.currentTier = this.currentForcedTier
        this.currentSizing = tierSizing(this.currentForcedTier)
        await this.journal.write({
          type: 'decision',
          phase: 'P1',
          action: `tier forced to ${this.currentForcedTier} via prefix override`,
        })
      } else {
        this.currentSizing = tierSizing('M')
        this.currentTier = 'M'
      }
      pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)

      await this.journal.write({ type: 'pre-action', phase: 'P1', action: 'starting P1 DISCOVER' })

      // B3b: intent gate — ask 1-3 questions before P1 if this is a new project with UI
      const gatedIntent = await this._intentGate(ctx)
      if (gatedIntent !== undefined) {
        this.currentIntent = gatedIntent
      }

      // ── P1 DISCOVER ──────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p1 = new P1Discover(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
      const p1Result = await p1.execute({
        phase: 'P1',
        idea: this.currentIdea,
        sizing: this.currentSizing,
        memoryStore: this.opts.memoryStore,
        embedder: this.opts.embedder,
        screenContent: this.opts.securityLane
          ? (t, s) => this.opts.securityLane!.screenContent(t, s)
          : undefined,
        intent: this.currentIntent,
      })
      if (!p1Result.ok || !p1Result.output) {
        await this._escalate('P1', p1Result.reason ?? 'P1 failed')
        return
      }
      this.phaseStore.p1 = p1Result.output

      // ── Post-P1 rescore: skipped when forced tier is set; else prefer p1.complexity ──
      if (!this.currentForcedTier) {
        const assessed = this.phaseStore.p1.complexity
        const usingAssessment = assessed !== undefined && isValidComplexityInput(assessed)
        const rescoreInput: ComplexityInput = usingAssessment
          ? assessed
          : this._rescoreFromSpec(this.phaseStore.p1.spec)
        await this.journal.write({
          type: 'decision',
          phase: 'P1',
          action: usingAssessment
            ? 'tier rescore via p1.complexity (host self-assessment)'
            : 'tier rescore via keyword heuristic (no p1.complexity)',
        })
        const rescoreResult = scoreComplexity(rescoreInput)
        const newSizing = tierSizing(rescoreResult.tier)
        if (rescoreResult.tier !== this.currentTier) {
          await this.journal.write({
            type: 'decision',
            phase: 'P1',
            action: `tier: ${this.currentTier} -> ${rescoreResult.tier} (post-P1 rescore)`,
          })
          this.currentTier = rescoreResult.tier
          this.currentSizing = newSizing
          pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)
        }
      }

      await this.journal.write({ type: 'completion', phase: 'P1', action: 'P1 complete' })
      this.opts.transparency.setHudStatus('P1→P2', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: this.fsm.getPhase(), action: 'compaction skipped: 45s timeout' })
      })
      await this.fsm.advance()

      // B3a: phase-by-phase gate after P1 (forward edge; no-op when phaseByPhase=false)
      if (this.phaseByPhase) {
        const g = await this._runPhaseGate('P1', ctx, (note) => this._rerunP1(note))
        if (g === 'stop') { await this._operatorBrief('P1', 'phase-by-phase: human chose stop'); return }
        if (g === 'escalated') return
      }

      this.opts.transparency.setHudStatus('P2', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P2 ELABORATE ─────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p2 = new P2Elaborate(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
      const p2Result = await p2.execute({ phase: 'P2', p1: this.phaseStore.p1, sizing: this.currentSizing })
      if (!p2Result.ok || !p2Result.output) {
        await this._escalate('P2', p2Result.reason ?? 'P2 failed')
        return
      }
      this.phaseStore.p2 = p2Result.output
      await this.journal.write({ type: 'completion', phase: 'P2', action: 'P2 complete' })
      this.opts.transparency.setHudStatus('P2→P3', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: this.fsm.getPhase(), action: 'compaction skipped: 45s timeout' })
      })
      await this.fsm.advance()

      // B3a: phase-by-phase gate after P2
      if (this.phaseByPhase) {
        const g = await this._runPhaseGate('P2', ctx, (note) => this._rerunP2(note))
        if (g === 'stop') { await this._operatorBrief('P2', 'phase-by-phase: human chose stop'); return }
        if (g === 'escalated') return
      }

      this.opts.transparency.setHudStatus('P3', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P3 PLAN ──────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p3 = new P3Plan(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
      const p3Result = await p3.execute({
        phase: 'P3',
        p1: this.phaseStore.p1,
        p2: this.phaseStore.p2,
        sizing: this.currentSizing,
      })
      if (!p3Result.ok || !p3Result.output) {
        // P3 exhausted re-plan rounds — surface operator brief
        const failResult = p3Result as { ok: false; reason?: string; operatorBrief?: unknown }
        const brief = failResult.operatorBrief ? JSON.stringify(failResult.operatorBrief, null, 2) : undefined
        if (brief) {
          await this._operatorBrief('P3', brief)
        } else {
          await this._escalate('P3', failResult.reason ?? 'P3 failed')
        }
        return
      }
      this.phaseStore.p3 = p3Result.output
      await this.journal.write({ type: 'completion', phase: 'P3', action: 'P3 complete' })
      this.opts.transparency.setHudStatus('P3→P4', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: this.fsm.getPhase(), action: 'compaction skipped: 45s timeout' })
      })
      await this.fsm.advance()

      // B3a: phase-by-phase gate after P3
      if (this.phaseByPhase) {
        const g = await this._runPhaseGate('P3', ctx, (note) => this._rerunP3(note))
        if (g === 'stop') { await this._operatorBrief('P3', 'phase-by-phase: human chose stop'); return }
        if (g === 'escalated') return
      }

      this.opts.transparency.setHudStatus('P4', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P4 BUILD ─────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p4 = new P4Build(this.hostAgent, this.outputDir, this.subagentDriver, this.opts.steerTimeoutMs)
      const p4Result = await p4.execute({ phase: 'P4', p3: this.phaseStore.p3, sizing: this.currentSizing, repoRoot: this.repoRoot })
      if (!p4Result.ok || !p4Result.output) {
        await this._escalate('P4', p4Result.reason ?? 'P4 failed')
        return
      }
      this.phaseStore.p4 = p4Result.output
      await this.journal.write({ type: 'completion', phase: 'P4', action: 'P4 complete' })
      this.opts.transparency.setHudStatus('P4→P5', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: this.fsm.getPhase(), action: 'compaction skipped: 45s timeout' })
      })
      await this.fsm.advance()

      // B3a: phase-by-phase gate after P4
      if (this.phaseByPhase) {
        const g = await this._runPhaseGate('P4', ctx, (note) => this._rerunP4(note))
        if (g === 'stop') { await this._operatorBrief('P4', 'phase-by-phase: human chose stop'); return }
        if (g === 'escalated') return
      }

      this.opts.transparency.setHudStatus('P5', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P5 VERIFY ────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p5 = new P5Verify(
        this.hostAgent,
        this.outputDir,
        this.opts.verifier,
        this.opts.judge,
        this.repoRoot,
        this.opts.steerTimeoutMs
      )
      const p5Result = await p5.execute({
        phase: 'P5',
        p3: this.phaseStore.p3,
        p4: this.phaseStore.p4,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })

      // H9 backedge: P4→P3 on divergent diff
      if (p5Result.backedge) {
        await this.journal.write({
          type: 'decision',
          phase: 'P5',
          action: `H9 backedge: ${p5Result.reason}`,
        })
        await this.fsm.backedge('P3')
        this.opts.transparency.setHudStatus('P3', 'H9 re-plan', 'running', 'opus')
        // Re-run from P3 with updated context
        const p3b = new P3Plan(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
        const p3bResult = await p3b.execute({
          phase: 'P3',
          p1: this.phaseStore.p1,
          p2: this.phaseStore.p2,
          sizing: this.currentSizing,
        })
        if (!p3bResult.ok || !p3bResult.output) {
          const p3bFail = p3bResult as { ok: false; reason?: string }
          await this._escalate('P3-backedge', p3bFail.reason ?? 'P3 re-plan failed')
          return
        }
        this.phaseStore.p3 = p3bResult.output
        // Surface to operator — re-running P4+P5 after backedge requires operator confirmation
        await this._operatorBrief('P5-backedge', 'H9 backedge: re-plan complete; re-run P4+P5 manually')
        return
      }

      if (!p5Result.ok || !p5Result.output) {
        await this._escalate('P5', p5Result.reason ?? 'P5 failed')
        return
      }
      this.phaseStore.p5 = p5Result.output
      await this.journal.write({ type: 'completion', phase: 'P5', action: 'P5 complete' })
      this.opts.transparency.setHudStatus('P5→P6', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: this.fsm.getPhase(), action: 'compaction skipped: 45s timeout' })
      })
      await this.fsm.advance()

      // B3a: phase-by-phase gate after P5 (forward path only; H9 backedge branch above has no gate)
      if (this.phaseByPhase) {
        const g = await this._runPhaseGate('P5', ctx, (note) => this._rerunP5(note))
        if (g === 'stop') { await this._operatorBrief('P5', 'phase-by-phase: human chose stop'); return }
        if (g === 'escalated') return
      }

      this.opts.transparency.setHudStatus('P6', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P6 RELEASE ───────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p6 = new P6Release(this.hostAgent, this.outputDir, this.opts.gitOps, undefined, this.opts.steerTimeoutMs)
      const p6Result = await p6.execute({ phase: 'P6', p5: this.phaseStore.p5, sizing: this.currentSizing, repoRoot: this.repoRoot })
      if (!p6Result.ok || !p6Result.output) {
        await this._escalate('P6', p6Result.reason ?? 'P6 failed')
        return
      }
      await this.journal.write({ type: 'completion', phase: 'P6', action: `P6 release: ${p6Result.output.commitSha}` })

      // Retro: success (BEFORE lifecycle.release)
      const successLesson = `${this.currentIdea.slice(0, 120)} → ${p6Result.output.commitSha}`
      await this.opts.retroWriter?.write({
        runId: this.currentRunId,
        lesson: successLesson,
        bugPattern: 'none',
        convention: this.currentTier,
      })
      // Fix #1: guard terminalStored so _escalate (catch below) cannot double-store
      // if lifecycle.release() or transparency.log() throws after we store here.
      this._terminalStored = true
      try {
        await this.opts.memoryStore?.store(this.currentRunId, successLesson, {
          tier: this.currentTier,
          outcome: 'success',
        })
      } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) } // Fix #3

      // All done
      await this.lifecycle.release()
      // Restore cwd after a successful run so a later non-autodev pi command
      // isn't surprised by the moved cwd (no-op when no re-root chdir happened).
      this._restoreCwd()
      this.opts.transparency.setHudStatus('DONE', p6Result.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE: commit=${p6Result.output.commitSha}`)

    } catch (err) {
      await this._escalate(this.fsm.getPhase(), `Unexpected error: ${String(err)}`)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Re-roots repoRoot, outputDir, journal, actionMonitor, pauseFilePath from
   * the resolved project dir AND chdir's the host process into it so the
   * dominant write vector (bash/npm/git spawn) is confined to the project dir.
   * All construction-captured backends (GitOps, CodebaseMemory, Transparency)
   * are re-rooted too, because chdir does NOT fix paths frozen at construction.
   *
   * No-op if no registry is injected (preserves existing behavior: repoRoot
   * stays process.cwd(), NO chdir).
   */
  private async _resolveRepoRoot(idea: string): Promise<void> {
    // B3b: reset per-run; stays false on the no-registry early-return path
    this.resolvedIsNew = false
    if (!this.opts.registry) return

    let r
    try {
      r = await resolveProjectDir({
        cwd: process.cwd(),
        idea,
        registry: this.opts.registry,
        homeDir: os.homedir(),
      })
    } catch (e) {
      void this.journal.write({
        type: 'decision',
        phase: 'P1',
        action: `_resolveRepoRoot: failed (${String(e)}), keeping cwd`,
      })
      return
    }

    // mkdir -p the resolved dir if new — must exist before we chdir into it.
    if (r.isNew) {
      await fs.mkdir(r.dir, { recursive: true })
    }

    // chdir the host process so its bash/npm/git spawn in the project dir.
    // Capture originalCwd FIRST. If chdir throws, journal + abort the re-root
    // safely: stay on the original cwd, do NOT mutate any instance state (no
    // half-rooted controller). originalCwd stays undefined so restore is a no-op.
    const originalCwd = process.cwd()
    try {
      process.chdir(r.dir)
    } catch (e) {
      void this.journal.write({
        type: 'decision',
        phase: 'P1',
        action: `_resolveRepoRoot: chdir to ${r.dir} failed (${String(e)}), aborting re-root, keeping cwd`,
      })
      return
    }
    this.originalCwd = originalCwd
    // B3b: record whether this resolved project is brand-new
    this.resolvedIsNew = r.isNew

    // chdir succeeded — now safe to mutate instance state to the new dir.
    this.repoRoot = r.dir
    this.subagentDriver.setRepoRoot(r.dir)

    // Re-derive all repoRoot-dependent fields
    this.outputDir = path.join(r.dir, '.autodev', 'phase-output')
    this.pauseFilePath = path.join(r.dir, '.autodev', 'PAUSE')
    this.journal = new Journal(path.join(r.dir, '.autodev', 'journal.jsonl'))
    this.actionMonitor = new ActionMonitor([r.dir])

    // Re-root construction-captured backends (chdir does NOT fix frozen paths):
    //  - GitOps: rebuild ScopedCommit/PerPhasePush/GitleaksHook → P6 commits/pushes r.dir.
    //  - Transparency: redirect activity.log + metrics.jsonl → r.dir/.autodev.
    //  - CodebaseMemory: reset cached index, then ensureIndexed() indexes r.dir.
    // securityScan honors its wd arg (P5 passes this.repoRoot) — no per-instance call.
    const gitOps = this.opts.gitOps as { setRepoRoot?: (dir: string) => void }
    gitOps.setRepoRoot?.(r.dir)
    const transparency = this.opts.transparency as { setRepoRoot?: (dir: string) => void }
    transparency.setRepoRoot?.(r.dir)
    this.opts.codebaseMemory?.setRepoRoot?.(r.dir)
    const boundedExec = this.opts.boundedExec as { setRepoRoot?: (d: string) => void } | undefined
    boundedExec?.setRepoRoot?.(r.dir)

    // Register in registry
    await this.opts.registry.register(r.name, r.dir, { lastRun: new Date().toISOString() })
    if (!r.isNew) {
      await this.opts.registry.setActive(r.name)
    }

    // Index existing codebase (degrade gracefully on failure).
    // setRepoRoot above already reset the cached index, so this indexes r.dir.
    if (r.isExisting && this.opts.codebaseMemory?.ensureIndexed) {
      try {
        await this.opts.codebaseMemory.ensureIndexed()
      } catch (e) {
        void this.journal.write({
          type: 'decision',
          phase: 'P1',
          action: `_resolveRepoRoot: ensureIndexed failed (${String(e)}), continuing`,
        })
      }
    }

    void this.journal.write({
      type: 'decision',
      phase: 'P1',
      action: `resolved project '${r.name}' -> ${r.dir} (${r.isNew ? 'new' : 'existing'}); chdir from ${originalCwd}`,
    })
  }

  /**
   * Restore the process cwd captured before the re-root chdir. Idempotent and
   * safe: a no-op when no chdir happened (originalCwd undefined). Wrapped in
   * try/catch so a restore failure never crashes the terminal path; clears
   * originalCwd after the attempt so it runs at most once per run.
   */
  private _restoreCwd(): void {
    if (this.originalCwd === undefined) return
    const target = this.originalCwd
    this.originalCwd = undefined
    try {
      process.chdir(target)
    } catch (e) {
      void this.journal.write({
        type: 'decision',
        phase: this.fsm.getPhase(),
        action: `_restoreCwd: chdir back to ${target} failed (${String(e)}), continuing`,
      })
    }
  }

  // ── B2: Quick gear — seed→P4→P5→P6 ──────────────────────────────────────────

  /**
   * Quick gear phase path: skips P1/P2/P3 ceremony.
   * Issues ONE seed steer to produce a combined quick-seed.json (containing both
   * spec and plan fields), then runs P4→P5→P6.
   *
   * Single-file seed design: writing two separate files (p1-spec.json + p3-plan.json)
   * introduced a race — the steer's expectFile gated on p1 only, so the steer could
   * resolve with p1 written and p3 not yet flushed, making fs.readFile(p3File) throw
   * spuriously. Collapsing to ONE file eliminates the race entirely.
   *
   * Full lifecycle bookends: pause-check at entry, compactAsync between steps,
   * _escalate on failure, retro + lifecycle.release() + _restoreCwd on success.
   * Lock is released on BOTH success and failure paths.
   */
  private async _runPhasesQuick(ctx: ExtensionContext): Promise<void> {
    try {
      this.currentRunId = `run-${crypto.randomUUID()}`
      this._terminalStored = false
      // Quick gear always uses XS sizing (forced by quick: prefix → XS tier)
      this.currentTier = 'XS'
      this.currentSizing = tierSizing('XS')
      const pi = this.pi as unknown as { setThinkingLevel?: (level: string) => void }
      pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)

      await this.journal.write({
        type: 'decision', phase: 'QUICK', action: `gear: quick task-type: ${this.currentTaskType} — starting seed steer`,
      })

      // ── Pause check at entry ──────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      // ── Seed steer: produce a SINGLE combined seed file ───────────────────
      // Writing two files (p1-spec.json + p3-plan.json) introduced a race where
      // the steer resolved (expectFile=p1File) with p3 not yet flushed. A single
      // combined file eliminates the race structurally.
      const outputDir = this.outputDir
      await fs.mkdir(outputDir, { recursive: true })
      const seedFile = path.join(outputDir, 'quick-seed.json')

      const seedInstruction = [
        '## Role: Quick-Gear Seed Agent',
        `You are the **quick gear** seed phase for pi-autodev. The idea is: "${this.currentIdea}"`,
        '',
        'Produce a MINIMAL build plan for this small task. Write ONE JSON file:',
        '',
        `**\`${seedFile}\`** (combined seed):`,
        '```json',
        '{',
        '  "spec": "<one paragraph spec>",',
        '  "plan": {',
        '    "goal": "<goal>",',
        '    "successCriteria": ["<criterion>"],',
        '    "fileDAG": [{"file": "<path>", "lane": 0, "deps": []}],',
        '    "examplesTable": [{"scenario": "<name>", "input": "<input>", "expectedOutput": "<output>"}]',
        '  }',
        '}',
        '```',
        '',
        'Rules: No web research. No alternatives. No personas. Write ONLY this one file. Keep it minimal.',
        '',
        MINIMALISM_DIRECTIVE,
        '',
        CRAFTSMANSHIP_DIRECTIVE,
      ].join('\n')

      this.opts.transparency.setHudStatus('QUICK-SEED', this.currentIdea.slice(0, 60), 'running', 'opus')

      // Steer the host to write the combined seed file
      const hostAgent = this.hostAgent
      let seedSteerResult
      try {
        seedSteerResult = await hostAgent.steer(seedInstruction, {
          expectFile: seedFile,
          ...(this.opts.steerTimeoutMs !== undefined ? { timeoutMs: this.opts.steerTimeoutMs } : {}),
        })
      } catch (err) {
        await this._escalate('QUICK-SEED', `Seed steer failed: ${String(err)}`)
        return
      }
      void seedSteerResult

      // Read + parse combined seed file
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(seedFile, 'utf-8'))
      } catch (err) {
        await this._escalate('QUICK-SEED', `Seed file read/parse failed: ${String(err)}`)
        return
      }

      // Extract and validate fields; include a raw excerpt for debuggability (Finding 5)
      const rawExcerpt = JSON.stringify(raw).slice(0, 200)
      if (!raw || typeof raw !== 'object') {
        await this._escalate('QUICK-SEED', `Seed file is not a JSON object. Raw: ${rawExcerpt}`)
        return
      }
      const seedObj = raw as Record<string, unknown>

      if (typeof seedObj['spec'] !== 'string' || !seedObj['spec']) {
        await this._escalate('QUICK-SEED', `Seed missing valid "spec" string. Raw: ${rawExcerpt}`)
        return
      }
      if (!seedObj['plan'] || typeof seedObj['plan'] !== 'object') {
        await this._escalate('QUICK-SEED', `Seed missing valid "plan" object. Raw: ${rawExcerpt}`)
        return
      }
      const plan = seedObj['plan'] as Record<string, unknown>

      // Construct minimal P1Output from seed
      const p1Candidate: unknown = {
        phase: 'P1',
        spec: seedObj['spec'],
        stackAdr: typeof seedObj['stackAdr'] === 'string' ? seedObj['stackAdr'] : '(quick gear — no ADR)',
        webResearch: [],
      }
      if (!validateP1Output(p1Candidate)) {
        await this._escalate('QUICK-SEED', `Constructed P1Output failed schema validation. Raw: ${rawExcerpt}`)
        return
      }
      this.phaseStore.p1 = p1Candidate

      // Construct minimal P3Output from plan
      const p3Candidate: unknown = {
        phase: 'P3',
        fileDAG: Array.isArray(plan['fileDAG']) ? plan['fileDAG'] : [],
        panelObjCount: 0,
        sprintContract: {
          goal: typeof plan['goal'] === 'string' ? plan['goal'] : '',
          successCriteria: Array.isArray(plan['successCriteria']) ? plan['successCriteria'] : [],
          outOfScope: [],
        },
        examplesTable: Array.isArray(plan['examplesTable']) ? plan['examplesTable'] : [],
      }
      if (!validateP3Output(p3Candidate)) {
        await this._escalate('QUICK-SEED', `Constructed P3Output failed schema validation. Raw: ${rawExcerpt}`)
        return
      }
      this.phaseStore.p3 = p3Candidate

      await this.journal.write({ type: 'completion', phase: 'QUICK-SEED', action: 'seed complete' })

      // ── Compact between seed and P4 ───────────────────────────────────────
      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'QUICK-SEED', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P4', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P4 BUILD (XS sizing, laneCap 1) ──────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p4 = new P4Build(this.hostAgent, this.outputDir, this.subagentDriver, this.opts.steerTimeoutMs)
      const p4Result = await p4.execute({
        phase: 'P4',
        p3: this.phaseStore.p3!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p4Result.ok || !p4Result.output) {
        await this._escalate('P4', p4Result.reason ?? 'P4 failed')
        return
      }
      this.phaseStore.p4 = p4Result.output
      await this.journal.write({ type: 'completion', phase: 'P4', action: 'P4 complete (quick gear)' })

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P4', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P5', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P5 VERIFY (XS sizing, reviewRounds 1) ─────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p5 = new P5Verify(
        this.hostAgent, this.outputDir, this.opts.verifier,
        this.opts.judge, this.repoRoot, this.opts.steerTimeoutMs
      )
      const p5Result = await p5.execute({
        phase: 'P5',
        p3: this.phaseStore.p3!,
        p4: this.phaseStore.p4!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p5Result.ok || !p5Result.output) {
        await this._escalate('P5', p5Result.reason ?? 'P5 failed')
        return
      }
      this.phaseStore.p5 = p5Result.output
      await this.journal.write({ type: 'completion', phase: 'P5', action: 'P5 complete (quick gear)' })

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P5', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P6', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P6 RELEASE ────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p6 = new P6Release(this.hostAgent, this.outputDir, this.opts.gitOps, undefined, this.opts.steerTimeoutMs)
      const p6Result = await p6.execute({
        phase: 'P6',
        p5: this.phaseStore.p5!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p6Result.ok || !p6Result.output) {
        await this._escalate('P6', p6Result.reason ?? 'P6 failed')
        return
      }
      await this.journal.write({ type: 'completion', phase: 'P6', action: `P6 release (quick gear): ${p6Result.output.commitSha}` })

      // Retro: success
      const successLesson = `[quick] ${this.currentIdea.slice(0, 120)} → ${p6Result.output.commitSha}`
      await this.opts.retroWriter?.write({
        runId: this.currentRunId, lesson: successLesson, bugPattern: 'none', convention: this.currentTier,
      })
      this._terminalStored = true
      try {
        await this.opts.memoryStore?.store(this.currentRunId, successLesson, { tier: this.currentTier, outcome: 'success' })
      } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) }

      await this.lifecycle.release()
      this._restoreCwd()
      this.opts.transparency.setHudStatus('DONE', p6Result.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE (quick gear): commit=${p6Result.output.commitSha}`)

    } catch (err) {
      await this._escalate('QUICK', `Unexpected error: ${String(err)}`)
    }
  }

  // ── B2: Middle gear — P1→(synth P2)→P3→P4→P5→P6 ─────────────────────────────

  /**
   * Middle gear phase path: runs P1 and P3 but skips P2 persona debate.
   * A synthetic empty P2Output is passed to P3 so its type contract holds.
   * Post-P1 rescore runs unless tier was forced (mid: prefix forces M, skips rescore).
   * Full lifecycle bookends: pause-check, compactAsync, escalate, retro+release+restoreCwd.
   * Lock is released on BOTH success and failure paths.
   */
  private async _runPhasesMiddle(ctx: ExtensionContext): Promise<void> {
    try {
      this.currentRunId = `run-${crypto.randomUUID()}`
      this._terminalStored = false
      const pi = this.pi as unknown as { setThinkingLevel?: (level: string) => void }

      // Initialize sizing: forced tier or default M
      if (this.currentForcedTier) {
        this.currentTier = this.currentForcedTier
        this.currentSizing = tierSizing(this.currentForcedTier)
        await this.journal.write({
          type: 'decision', phase: 'P1',
          action: `tier forced to ${this.currentForcedTier} via prefix override (middle gear)`,
        })
      } else {
        this.currentSizing = tierSizing('M')
        this.currentTier = 'M'
      }
      pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)

      await this.journal.write({
        type: 'decision', phase: 'P1',
        action: `gear: middle task-type: ${this.currentTaskType} — starting P1 DISCOVER`,
      })

      // ── P1 DISCOVER ──────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      this.opts.transparency.setHudStatus('P1', this.currentIdea.slice(0, 60), 'running', 'opus')

      const p1 = new P1Discover(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
      const p1Result = await p1.execute({
        phase: 'P1',
        idea: this.currentIdea,
        sizing: this.currentSizing,
        memoryStore: this.opts.memoryStore,
        embedder: this.opts.embedder,
        screenContent: this.opts.securityLane
          ? (t, s) => this.opts.securityLane!.screenContent(t, s)
          : undefined,
      })
      if (!p1Result.ok || !p1Result.output) {
        await this._escalate('P1', p1Result.reason ?? 'P1 failed')
        return
      }
      this.phaseStore.p1 = p1Result.output

      // ── Post-P1 rescore: skipped when tier is forced ──────────────────────
      if (!this.currentForcedTier) {
        const assessed = this.phaseStore.p1.complexity
        const usingAssessment = assessed !== undefined && isValidComplexityInput(assessed)
        const rescoreInput: ComplexityInput = usingAssessment
          ? assessed
          : this._rescoreFromSpec(this.phaseStore.p1.spec)
        await this.journal.write({
          type: 'decision', phase: 'P1',
          action: usingAssessment
            ? 'tier rescore via p1.complexity (host self-assessment)'
            : 'tier rescore via keyword heuristic (no p1.complexity)',
        })
        const rescoreResult = scoreComplexity(rescoreInput)
        const newSizing = tierSizing(rescoreResult.tier)
        if (rescoreResult.tier !== this.currentTier) {
          await this.journal.write({
            type: 'decision', phase: 'P1',
            action: `tier: ${this.currentTier} -> ${rescoreResult.tier} (post-P1 rescore)`,
          })
          this.currentTier = rescoreResult.tier
          this.currentSizing = newSizing
          pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)
        }
      }

      await this.journal.write({ type: 'completion', phase: 'P1', action: 'P1 complete (middle gear)' })
      this.opts.transparency.setHudStatus('P1→P3', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P1', action: 'compaction skipped: 45s timeout' })
      })

      // ── Skip P2: synthesize empty P2Output so P3's type contract holds ────
      const synthP2: import('../phases/phase-output.js').P2Output = {
        phase: 'P2',
        domainModel: '(middle gear — P2 skipped)',
        personaDebate: [],
      }
      this.phaseStore.p2 = synthP2
      await this.journal.write({
        type: 'decision', phase: 'P2',
        action: 'P2 skipped (middle gear) — synthetic empty P2Output injected',
      })

      this.opts.transparency.setHudStatus('P3', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P3 PLAN ──────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p3 = new P3Plan(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
      const p3Result = await p3.execute({
        phase: 'P3',
        p1: this.phaseStore.p1!,
        p2: this.phaseStore.p2,
        sizing: this.currentSizing,
      })
      if (!p3Result.ok || !p3Result.output) {
        const failResult = p3Result as { ok: false; reason?: string; operatorBrief?: unknown }
        const brief = failResult.operatorBrief ? JSON.stringify(failResult.operatorBrief, null, 2) : undefined
        if (brief) {
          await this._operatorBrief('P3', brief)
        } else {
          await this._escalate('P3', failResult.reason ?? 'P3 failed')
        }
        return
      }
      this.phaseStore.p3 = p3Result.output
      await this.journal.write({ type: 'completion', phase: 'P3', action: 'P3 complete (middle gear)' })
      this.opts.transparency.setHudStatus('P3→P4', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P3', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P4', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P4 BUILD ─────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p4m = new P4Build(this.hostAgent, this.outputDir, this.subagentDriver, this.opts.steerTimeoutMs)
      const p4Result = await p4m.execute({
        phase: 'P4',
        p3: this.phaseStore.p3!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p4Result.ok || !p4Result.output) {
        await this._escalate('P4', p4Result.reason ?? 'P4 failed')
        return
      }
      this.phaseStore.p4 = p4Result.output
      await this.journal.write({ type: 'completion', phase: 'P4', action: 'P4 complete (middle gear)' })

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P4', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P5', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P5 VERIFY ────────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p5m = new P5Verify(
        this.hostAgent, this.outputDir, this.opts.verifier,
        this.opts.judge, this.repoRoot, this.opts.steerTimeoutMs
      )
      const p5Result = await p5m.execute({
        phase: 'P5',
        p3: this.phaseStore.p3!,
        p4: this.phaseStore.p4!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p5Result.ok || !p5Result.output) {
        await this._escalate('P5', p5Result.reason ?? 'P5 failed')
        return
      }
      this.phaseStore.p5 = p5Result.output
      await this.journal.write({ type: 'completion', phase: 'P5', action: 'P5 complete (middle gear)' })

      await compactAsync(ctx, COMPACT_TIMEOUT_MS, () => {
        void this.journal.write({ type: 'decision', phase: 'P5', action: 'compaction skipped: 45s timeout' })
      })
      this.opts.transparency.setHudStatus('P6', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P6 RELEASE ───────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p6m = new P6Release(this.hostAgent, this.outputDir, this.opts.gitOps, undefined, this.opts.steerTimeoutMs)
      const p6mResult = await p6m.execute({
        phase: 'P6',
        p5: this.phaseStore.p5!,
        sizing: this.currentSizing,
        repoRoot: this.repoRoot,
      })
      if (!p6mResult.ok || !p6mResult.output) {
        await this._escalate('P6', p6mResult.reason ?? 'P6 failed')
        return
      }
      await this.journal.write({ type: 'completion', phase: 'P6', action: `P6 release (middle gear): ${p6mResult.output.commitSha}` })

      // Retro: success
      const successLesson = `[middle] ${this.currentIdea.slice(0, 120)} → ${p6mResult.output.commitSha}`
      await this.opts.retroWriter?.write({
        runId: this.currentRunId, lesson: successLesson, bugPattern: 'none', convention: this.currentTier,
      })
      this._terminalStored = true
      try {
        await this.opts.memoryStore?.store(this.currentRunId, successLesson, { tier: this.currentTier, outcome: 'success' })
      } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) }

      await this.lifecycle.release()
      this._restoreCwd()
      this.opts.transparency.setHudStatus('DONE', p6mResult.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE (middle gear): commit=${p6mResult.output.commitSha}`)

    } catch (err) {
      await this._escalate('MIDDLE', `Unexpected error: ${String(err)}`)
    }
  }

  // ── C-1: Debug track D1→D5 ───────────────────────────────────────────────────

  /**
   * _runDebugTrack: linear D1→D5 debug execution.
   *
   * Independent of the P1-P6 FSM — uses its own D-step counter.
   * Debug runs are NON-resurrectable in v1 (no P-phase vocabulary in resurrection.ts).
   * Full lifecycle bookends: currentRunId + _terminalStored reset at entry;
   * try/catch → _escalate; every terminal releases lock + restores cwd.
   *
   * Gates (all deterministic, no host self-report):
   *   D1: reproCommand runs consistently RED 3× via boundedExec; faithfulness judge;
   *       content-hash snapshot of reproArtifact.
   *   D3: gitOps.changedFiles excludes reproArtifact AND hash unchanged AND changed
   *       set is non-empty (guards against vacuous "fix" with no file writes).
   *   D4: reproCommand runs consistently GREEN 3×; full suite via verifier.runDeterministic.
   *       Loop D2/D3 capped MAX_DEBUG_ROUNDS; on cap → _operatorBrief.
   *   D5: scopedCommit fix+repro, scanSecrets, perPhasePush. TierDGate skipped (debug v1).
   */
  private async _runDebugTrack(ctx: ExtensionContext): Promise<void> {
    // ── Entry: reset per-run debug state ────────────────────────────────────
    this.currentDebugStep = undefined

    // Journal non-resurrectable marker
    await this.journal.write({
      type: 'decision', phase: 'DEBUG',
      action: 'debug track started — NON-RESURRECTABLE in v1; D-steps journalled for post-mortem only',
    })

    try {
      const bugReport = this.currentIdea
      const repoRoot = this.repoRoot
      const outputDir = this.outputDir

      // boundedExec is required for the debug track
      const boundedExec = this.opts.boundedExec
      if (!boundedExec) {
        await this._escalate('D1', 'boundedExec not injected — debug track requires BoundedExec')
        return
      }

      // Arm allowedPaths so boundedExec path-guard works even when _resolveRepoRoot
      // was not called (e.g. repoRoot supplied directly via opts).
      boundedExec.setRepoRoot?.(repoRoot)

      // ── D1: REPRODUCE ────────────────────────────────────────────────────
      this.currentDebugStep = 'D1'
      this.opts.transparency.setHudStatus('D1', bugReport.slice(0, 60), 'running', 'opus')
      await this.journal.write({ type: 'pre-action', phase: 'D1', action: 'starting D1 REPRODUCE' })

      const d1Step = new D1Reproduce(this.hostAgent, outputDir, this.opts.steerTimeoutMs)
      const d1Result = await d1Step.execute(bugReport, repoRoot)
      if (!d1Result.ok || !d1Result.output) {
        await this._escalate('D1', d1Result.reason ?? 'D1 failed')
        return
      }
      const d1: D1Output = d1Result.output

      // ── D1 gate: run reproCommand 3× — require consistent RED ────────────
      const REPRO_TIMEOUT_MS = 60_000
      const RUNS = 3
      const reproOutputs: string[] = []
      let allRed = true

      for (let i = 0; i < RUNS; i++) {
        const run = await boundedExec.run(d1.reproCommand, repoRoot, { timeoutMs: REPRO_TIMEOUT_MS })
        reproOutputs.push(run.output)

        if (run.blocked) {
          await this._escalate('D1', `reproCommand blocked by action-monitor: ${d1.reproCommand}`)
          return
        }
        if (run.timedOut) {
          await this._escalate('D1', `reproCommand timed out after ${REPRO_TIMEOUT_MS}ms — repro hangs`)
          return
        }
        // Distinguish harness-level failure (import/collection/TS error) from a real assertion failure.
        // isHarnessError covers: no test suite found, failed to resolve import, transform failed,
        // TS\d{4,}, cannot find name, cannot find module, failed to load, enoent, syntaxerror, etc.
        if (run.output && isHarnessError(run.output)) {
          await this._escalate('D1', 'repro harness broken — test suite could not be collected (not an assertion failure)')
          return
        }
        if (run.passed) {
          // Repro is green — not consistently red
          allRed = false
          break
        }
      }

      if (!allRed) {
        await this._operatorBrief('D1', 'could not reproduce consistently — repro green or flaky')
        return
      }

      // ── D1 faithfulness: judge confirms repro demonstrates the bug ────────
      const reproOutput = reproOutputs[reproOutputs.length - 1] ?? ''
      const faithfulness = await checkReproFaithfulness(bugReport, d1.reproSummary, reproOutput, this.opts.judge)
      if (!faithfulness.faithful) {
        await this._escalate('D1', `repro faithfulness check failed: ${faithfulness.reason ?? 'repro does not demonstrate the reported bug'}`)
        return
      }
      if (faithfulness.skipped) {
        await this.journal.write({ type: 'decision', phase: 'D1', action: 'faithfulness check skipped (judge error) — proceeding fail-open' })
        await this.opts.transparency.log('faithfulness check skipped (judge error)')
      }

      // ── D1 hash snapshot — for D3/D4 anti-cheat ─────────────────────────
      let reproHashSnapshot: string
      try {
        const reproContent = await fs.readFile(
          d1.reproArtifact.startsWith('/') ? d1.reproArtifact : path.join(repoRoot, d1.reproArtifact),
          'utf-8'
        )
        // SHA-256 hash for reliable change detection (crypto already imported via randomUUID)
        reproHashSnapshot = crypto.createHash('sha256').update(reproContent).digest('hex')
      } catch (err) {
        await this._escalate('D1', `Could not read reproArtifact for hash snapshot: ${String(err)}`)
        return
      }

      await this.journal.write({ type: 'completion', phase: 'D1', action: `D1 complete — repro confirmed RED 3× (faithfulness ok); artifact=${d1.reproArtifact}` })

      // ── D2/D3/D4 loop — capped at MAX_DEBUG_ROUNDS ───────────────────────
      let d2: D2Output | undefined
      let d3: D3Output | undefined
      let round = 0

      while (round < MAX_DEBUG_ROUNDS) {
        round++

        // ── D2: ROOT-CAUSE ─────────────────────────────────────────────────
        this.currentDebugStep = 'D2'
        this.opts.transparency.setHudStatus('D2', bugReport.slice(0, 60), 'running', 'opus')
        await this.journal.write({ type: 'pre-action', phase: 'D2', action: `starting D2 ROOT-CAUSE (round ${round})` })

        // Gather findCallers data when available
        let callerData: Array<{ file: string; symbol?: string }> | undefined
        try {
          // Extract candidate symbols from repro output (simple heuristic: words near 'at ' stack frames)
          const symbolMatch = reproOutput.match(/\bat\s+(\w+(?:\.\w+)*)\s/g)
          const symbols = symbolMatch
            ? [...new Set(symbolMatch.map(m => m.replace(/^at\s+/, '').replace(/\s.*/, '')))]
            : []
          if (symbols.length > 0 && this.opts.codebaseMemory?.findCallers) {
            const callerResults = await Promise.allSettled(
              symbols.slice(0, 3).map(sym => this.opts.codebaseMemory!.findCallers!(sym))
            )
            callerData = callerResults
              .filter((r): r is PromiseFulfilledResult<Array<{ file: string; symbol?: string }>> => r.status === 'fulfilled')
              .flatMap(r => r.value)
          }
        } catch {
          // findCallers degraded — continue without it
        }

        const d2Step = new D2RootCause(this.hostAgent, outputDir, this.opts.steerTimeoutMs)
        const d2Result = await d2Step.execute(bugReport, d1, reproOutput, callerData)
        if (!d2Result.ok || !d2Result.output) {
          await this._escalate('D2', d2Result.reason ?? 'D2 failed')
          return
        }
        d2 = d2Result.output
        await this.journal.write({ type: 'completion', phase: 'D2', action: `D2 complete — rootCause: ${d2.rootCause.slice(0, 80)}` })

        // ── D3: FIX ────────────────────────────────────────────────────────
        this.currentDebugStep = 'D3'
        this.opts.transparency.setHudStatus('D3', bugReport.slice(0, 60), 'running', 'opus')
        await this.journal.write({ type: 'pre-action', phase: 'D3', action: `starting D3 FIX (round ${round})` })

        const d3Step = new D3Fix(this.hostAgent, outputDir, this.opts.steerTimeoutMs)
        const d3Result = await d3Step.execute(bugReport, d1, d2)
        if (!d3Result.ok || !d3Result.output) {
          await this._escalate('D3', d3Result.reason ?? 'D3 failed')
          return
        }
        d3 = d3Result.output

        // ── D3 anti-cheat: deterministic changedFiles gate ──────────────────
        const changedFiles = await this.opts.gitOps.changedFiles(repoRoot)

        // Guard: changedFiles must be non-empty after fix steer
        if (changedFiles.length === 0) {
          await this._escalate('D3', 'no changes detected after fix — host wrote nothing to disk')
          return
        }

        // Guard: reproArtifact must NOT be in changedFiles.
        // Use exact-path and path.resolve comparison only — basename match is over-broad
        // and would false-reject a real fix to a same-basename file in another directory.
        const reproAbsolute = path.resolve(repoRoot, d1.reproArtifact)
        const reproModified = changedFiles.some(f =>
          f === d1.reproArtifact || path.resolve(repoRoot, f) === reproAbsolute
        )
        if (reproModified) {
          await this._escalate('D3', `repro was modified during fix — anti-cheat failed: ${d1.reproArtifact} appears in changedFiles`)
          return
        }

        // Guard: reproArtifact content hash unchanged (SHA-256 for post-512-byte safety)
        let currentHash: string
        try {
          const currentContent = await fs.readFile(
            d1.reproArtifact.startsWith('/') ? d1.reproArtifact : path.join(repoRoot, d1.reproArtifact),
            'utf-8'
          )
          currentHash = crypto.createHash('sha256').update(currentContent).digest('hex')
        } catch (err) {
          await this._escalate('D3', `Could not re-read reproArtifact for hash check: ${String(err)}`)
          return
        }

        if (currentHash !== reproHashSnapshot) {
          await this._escalate('D3', 'repro was altered during fix — content hash changed (anti-cheat failed)')
          return
        }

        await this.journal.write({ type: 'completion', phase: 'D3', action: `D3 complete — ${d3.filesChanged.length} file(s) changed; anti-cheat passed` })

        // ── D4: VERIFY ────────────────────────────────────────────────────
        this.currentDebugStep = 'D4'
        this.opts.transparency.setHudStatus('D4', bugReport.slice(0, 60), 'running', 'opus')
        await this.journal.write({ type: 'pre-action', phase: 'D4', action: `starting D4 VERIFY (round ${round})` })

        const d4Gate = await runD4Gate(d1, repoRoot, boundedExec, this.opts.verifier)

        if (d4Gate.harnessError) {
          // Fix broke the repro's imports/collection — distinct from "fix didn't work"
          await this._escalate('D4', `harness broken during fix — test suite could not be collected after D3 (round ${round}): ${d4Gate.reproOutput.slice(0, 300)}`)
          return
        }

        if (d4Gate.reproGreen && d4Gate.suiteGreen) {
          // Both gates pass — proceed to D5
          await this.journal.write({ type: 'completion', phase: 'D4', action: `D4 complete — repro GREEN 3×, suite GREEN (round ${round})` })
          break
        }

        // D4 failed — log and loop (if rounds remain)
        await this.journal.write({
          type: 'decision', phase: 'D4',
          action: `D4 failed (round ${round}/${MAX_DEBUG_ROUNDS}) — reproGreen=${d4Gate.reproGreen} suiteGreen=${d4Gate.suiteGreen}; ${round < MAX_DEBUG_ROUNDS ? 'looping D2/D3' : 'cap reached'}`,
        })

        if (round >= MAX_DEBUG_ROUNDS) {
          const evidence = [
            `repro ${d4Gate.reproGreen ? 'GREEN' : 'RED'} after ${round} rounds`,
            `suite ${d4Gate.suiteGreen ? 'GREEN' : 'RED'}`,
            `last repro output: ${d4Gate.reproOutput.slice(0, 400)}`,
          ].join('\n')
          await this._operatorBrief('D4', `debug track did not converge after ${MAX_DEBUG_ROUNDS} rounds:\n${evidence}`)
          return
        }
        // Continue loop (d2/d3 will be re-executed next iteration)
      }

      // d3 must be defined here (loop ran at least once and broke on D4 success)
      if (!d3 || !d2) {
        await this._escalate('DEBUG', 'internal error: D3/D2 undefined after loop — should not happen')
        return
      }

      // ── D5: SHIP ──────────────────────────────────────────────────────────
      this.currentDebugStep = 'D5'
      this.opts.transparency.setHudStatus('D5', bugReport.slice(0, 60), 'running', 'opus')
      await this.journal.write({ type: 'pre-action', phase: 'D5', action: 'starting D5 SHIP' })

      const d5Result = await runD5Ship(d1, d2, d3, repoRoot, this.opts.gitOps)
      if (!d5Result.ok || !d5Result.output) {
        await this._escalate('D5', d5Result.reason ?? 'D5 failed')
        return
      }

      await this.journal.write({
        type: 'completion', phase: 'D5',
        action: `D5 complete — commit=${d5Result.output.commitSha} push=${d5Result.output.pushResult}`,
      })

      // ── Success: retro + store + release ──────────────────────────────────
      const successLesson = `[debug] ${bugReport.slice(0, 120)} → ${d5Result.output.commitSha}`
      await this.opts.retroWriter?.write({
        runId: this.currentRunId,
        lesson: successLesson,
        bugPattern: d2.rootCauseLocation,
        convention: this.currentTier,
      })
      this._terminalStored = true
      try {
        await this.opts.memoryStore?.store(this.currentRunId, successLesson, {
          tier: this.currentTier,
          outcome: 'debug-success',
        })
      } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) }

      await this.lifecycle.release()
      this._restoreCwd()
      this.currentDebugStep = undefined
      this.opts.transparency.setHudStatus('DONE', d5Result.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE (debug track): commit=${d5Result.output.commitSha}`)

    } catch (err) {
      await this._escalate('DEBUG', `Unexpected error in debug track: ${String(err)}`)
    }
  }

  // ── Stage D: Refactor track R1→R4 ────────────────────────────────────────────

  /**
   * _runRefactorTrack: linear R1→R4 refactor execution.
   *
   * Independent of the P1-P6 FSM — uses its own R-step counter.
   * Refactor runs are NON-resurrectable in v1.
   * Full lifecycle bookends: currentRunId + _terminalStored reset at entry;
   * try/catch → _escalate; every terminal releases lock + restores cwd.
   *
   * Gates (all deterministic, no host self-report):
   *   R1: characterizationCommand runs consistently GREEN 3× on CURRENT code (baseline).
   *       SHA-256 snapshot of characterizationArtifact (anti-cheat for R2/R3).
   *   R2: gitOps.changedFiles non-empty; characterizationArtifact NOT in changed set
   *       AND its SHA-256 == R1 snapshot (cannot edit the oracle).
   *   R3: characterizationCommand runs consistently GREEN 3× (behavior preserved).
   *       Full suite via verifier.runDeterministic GREEN.
   *       If characterization RED → HARD escalate "refactor altered behavior" (no retry).
   *       If only suite fails (char green) → loop R2 capped MAX_REFACTOR_ROUNDS.
   *   R4: scopedCommit refactor+characterization, scanSecrets, perPhasePush. TierDGate skipped.
   */
  private async _runRefactorTrack(ctx: ExtensionContext): Promise<void> {
    // ── Entry: reset per-run refactor state ─────────────────────────────────
    this.currentRefactorStep = undefined

    // Journal non-resurrectable marker
    await this.journal.write({
      type: 'decision', phase: 'REFACTOR',
      action: 'refactor track started — NON-RESURRECTABLE in v1; R-steps journalled for post-mortem only',
    })

    try {
      const refactorRequest = this.currentIdea
      const repoRoot = this.repoRoot
      const outputDir = this.outputDir

      // boundedExec is required for the refactor track
      const boundedExec = this.opts.boundedExec
      if (!boundedExec) {
        await this._escalate('R1', 'boundedExec not injected — refactor track requires BoundedExec')
        return
      }

      // Arm allowedPaths so boundedExec path-guard works even when _resolveRepoRoot
      // was not called (e.g. repoRoot supplied directly via opts).
      boundedExec.setRepoRoot?.(repoRoot)

      // ── R1: CHARACTERIZE ─────────────────────────────────────────────────
      this.currentRefactorStep = 'R1'
      this.opts.transparency.setHudStatus('R1', refactorRequest.slice(0, 60), 'running', 'opus')
      await this.journal.write({ type: 'pre-action', phase: 'R1', action: 'starting R1 CHARACTERIZE' })

      const r1Step = new R1Characterize(this.hostAgent, outputDir, this.opts.steerTimeoutMs)
      const r1Result = await r1Step.execute(refactorRequest, repoRoot)
      if (!r1Result.ok || !r1Result.output) {
        await this._escalate('R1', r1Result.reason ?? 'R1 failed')
        return
      }
      const r1: R1Output = r1Result.output

      // ── R1 gate: run characterizationCommand 3× — require consistent GREEN ──
      const CHAR_TIMEOUT_MS = 60_000
      const RUNS = 3

      for (let i = 0; i < RUNS; i++) {
        const run = await boundedExec.run(r1.characterizationCommand, repoRoot, { timeoutMs: CHAR_TIMEOUT_MS })

        if (run.blocked) {
          await this._escalate('R1', `characterizationCommand blocked by action-monitor: ${r1.characterizationCommand}`)
          return
        }
        if (run.timedOut) {
          await this._escalate('R1', `characterizationCommand timed out after ${CHAR_TIMEOUT_MS}ms`)
          return
        }
        if (run.output && isHarnessError(run.output)) {
          await this._escalate('R1', 'characterization harness broken — test suite could not be collected')
          return
        }
        if (!run.passed) {
          // Characterization is RED on current (unchanged) code — cannot establish baseline
          await this._escalate('R1', 'characterization not green on current code — cannot establish a behavior baseline')
          return
        }
      }

      // ── R1 SHA-256 snapshot of characterizationArtifact (anti-cheat for R2) ──
      let charHashSnapshot: string
      try {
        const charContent = await fs.readFile(
          r1.characterizationArtifact.startsWith('/') ? r1.characterizationArtifact : path.join(repoRoot, r1.characterizationArtifact),
          'utf-8'
        )
        charHashSnapshot = crypto.createHash('sha256').update(charContent).digest('hex')
      } catch (err) {
        await this._escalate('R1', `Could not read characterizationArtifact for hash snapshot: ${String(err)}`)
        return
      }

      await this.journal.write({ type: 'completion', phase: 'R1', action: `R1 complete — characterization confirmed GREEN 3×; artifact=${r1.characterizationArtifact}` })

      // ── R2/R3 loop — capped at MAX_REFACTOR_ROUNDS ───────────────────────
      let r2: R2Output | undefined
      let round = 0

      while (round < MAX_REFACTOR_ROUNDS) {
        round++

        // ── R2: TRANSFORM ──────────────────────────────────────────────────
        this.currentRefactorStep = 'R2'
        this.opts.transparency.setHudStatus('R2', refactorRequest.slice(0, 60), 'running', 'opus')
        await this.journal.write({ type: 'pre-action', phase: 'R2', action: `starting R2 TRANSFORM (round ${round})` })

        const r2Step = new R2Transform(this.hostAgent, outputDir, this.opts.steerTimeoutMs)
        const r2Result = await r2Step.execute(refactorRequest, r1)
        if (!r2Result.ok || !r2Result.output) {
          await this._escalate('R2', r2Result.reason ?? 'R2 failed')
          return
        }
        r2 = r2Result.output

        // ── R2 anti-cheat: deterministic changedFiles gate ──────────────────
        const changedFiles = await this.opts.gitOps.changedFiles(repoRoot)

        // Guard: changedFiles must be non-empty after transform steer
        if (changedFiles.length === 0) {
          await this._escalate('R2', 'no changes detected after transform — host wrote nothing to disk')
          return
        }

        // Guard: characterizationArtifact must NOT be in changedFiles (can't edit the oracle)
        const charAbsolute = path.resolve(repoRoot, r1.characterizationArtifact)
        const charModified = changedFiles.some(f =>
          f === r1.characterizationArtifact || path.resolve(repoRoot, f) === charAbsolute
        )
        if (charModified) {
          await this._escalate('R2', `characterization oracle was modified during transform — anti-cheat failed: ${r1.characterizationArtifact} appears in changedFiles`)
          return
        }

        // Guard: characterizationArtifact content hash unchanged
        let currentHash: string
        try {
          const currentContent = await fs.readFile(
            r1.characterizationArtifact.startsWith('/') ? r1.characterizationArtifact : path.join(repoRoot, r1.characterizationArtifact),
            'utf-8'
          )
          currentHash = crypto.createHash('sha256').update(currentContent).digest('hex')
        } catch (err) {
          await this._escalate('R2', `Could not re-read characterizationArtifact for hash check: ${String(err)}`)
          return
        }

        if (currentHash !== charHashSnapshot) {
          await this._escalate('R2', 'characterization oracle was altered during transform — content hash changed (anti-cheat failed)')
          return
        }

        await this.journal.write({ type: 'completion', phase: 'R2', action: `R2 complete — ${r2.filesChanged.length} file(s) changed; anti-cheat passed` })

        // ── R3: VERIFY ────────────────────────────────────────────────────
        this.currentRefactorStep = 'R3'
        this.opts.transparency.setHudStatus('R3', refactorRequest.slice(0, 60), 'running', 'opus')
        await this.journal.write({ type: 'pre-action', phase: 'R3', action: `starting R3 VERIFY (round ${round})` })

        const r3Gate = await runR3Gate(r1, repoRoot, boundedExec, this.opts.verifier)

        if (r3Gate.harnessError) {
          // Transform broke the characterization's imports/collection
          await this._escalate('R3', `harness broken during verify — characterization test suite could not be collected after R2 (round ${round}): ${r3Gate.characterizationOutput.slice(0, 300)}`)
          return
        }

        if (r3Gate.behaviorChanged) {
          // Characterization went RED — behavior CHANGED. Hard stop, do NOT retry.
          await this._escalate('R3', `refactor altered behavior: ${r3Gate.characterizationOutput.slice(0, 300)}`)
          return
        }

        if (r3Gate.characterizationGreen && r3Gate.suiteGreen) {
          // Both gates pass — proceed to R4
          await this.journal.write({ type: 'completion', phase: 'R3', action: `R3 complete — characterization GREEN 3×, suite GREEN (round ${round})` })
          break
        }

        // Characterization green but suite failed — log and loop (if rounds remain)
        await this.journal.write({
          type: 'decision', phase: 'R3',
          action: `R3 suite failed (round ${round}/${MAX_REFACTOR_ROUNDS}) — characterizationGreen=${r3Gate.characterizationGreen} suiteGreen=${r3Gate.suiteGreen}; ${round < MAX_REFACTOR_ROUNDS ? 'looping R2' : 'cap reached'}`,
        })

        if (round >= MAX_REFACTOR_ROUNDS) {
          const evidence = [
            `characterization ${r3Gate.characterizationGreen ? 'GREEN' : 'RED'} after ${round} rounds`,
            `suite ${r3Gate.suiteGreen ? 'GREEN' : 'RED'}`,
            `last characterization output: ${r3Gate.characterizationOutput.slice(0, 400)}`,
          ].join('\n')
          await this._operatorBrief('R3', `refactor track did not converge after ${MAX_REFACTOR_ROUNDS} rounds:\n${evidence}`)
          return
        }
        // Continue loop (r2 will be re-executed next iteration)
      }

      // r2 must be defined here (loop ran at least once and broke on R3 success)
      if (!r2) {
        await this._escalate('REFACTOR', 'internal error: R2 undefined after loop — should not happen')
        return
      }

      // ── R4: SHIP ──────────────────────────────────────────────────────────
      this.currentRefactorStep = 'R4'
      this.opts.transparency.setHudStatus('R4', refactorRequest.slice(0, 60), 'running', 'opus')
      await this.journal.write({ type: 'pre-action', phase: 'R4', action: 'starting R4 SHIP' })

      const r4Result = await runR4Ship(r1, r2, repoRoot, this.opts.gitOps)
      if (!r4Result.ok || !r4Result.output) {
        await this._escalate('R4', r4Result.reason ?? 'R4 failed')
        return
      }

      await this.journal.write({
        type: 'completion', phase: 'R4',
        action: `R4 complete — commit=${r4Result.output.commitSha} push=${r4Result.output.pushResult}`,
      })

      // ── Success: retro + store + release ──────────────────────────────────
      const successLesson = `[refactor] ${refactorRequest.slice(0, 120)} → ${r4Result.output.commitSha}`
      await this.opts.retroWriter?.write({
        runId: this.currentRunId,
        lesson: successLesson,
        bugPattern: 'none',
        convention: this.currentTier,
      })
      this._terminalStored = true
      try {
        await this.opts.memoryStore?.store(this.currentRunId, successLesson, {
          tier: this.currentTier,
          outcome: 'refactor-success',
        })
      } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) }

      await this.lifecycle.release()
      this._restoreCwd()
      this.currentRefactorStep = undefined
      this.opts.transparency.setHudStatus('DONE', r4Result.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE (refactor track): commit=${r4Result.output.commitSha}`)

    } catch (err) {
      await this._escalate('REFACTOR', `Unexpected error in refactor track: ${String(err)}`)
    }
  }

  private async _escalate(phase: string, reason: string): Promise<void> {
    await this.journal.write({ type: 'decision', phase, action: `HARD BLOCK: ${reason}`, suspect: true })
    await this.opts.transparency.log(`ESCALATE [${phase}]: ${reason}`)
    this.opts.transparency.setHudStatus(phase, 'BLOCKED', 'failed', 'none')
    // Retro: halt (BEFORE lifecycle.release)
    if (this.currentRunId) {
      await this.opts.retroWriter?.write({
        runId: this.currentRunId,
        lesson: reason,
        bugPattern: phase,
        convention: 'halted',
      })
      // Fix #1: skip store if already stored (prevents double-store on success→catch path)
      if (!this._terminalStored) {
        this._terminalStored = true
        try {
          await this.opts.memoryStore?.store(this.currentRunId, reason, {
            tier: this.currentTier,
            outcome: 'halted',
          })
        } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) } // Fix #3
      }
    }
    await this.lifecycle.release()
    // Restore cwd on the halt/escalate terminal path too.
    this._restoreCwd()
  }

  private async _operatorBrief(phase: string, brief: string): Promise<void> {
    await this.journal.write({ type: 'decision', phase, action: `OPERATOR BRIEF: ${brief.slice(0, 200)}` })
    await this.opts.transparency.log(`OPERATOR BRIEF [${phase}]: ${brief.slice(0, 200)}`)
    this.opts.transparency.setHudStatus(phase, 'OPERATOR NEEDED', 'paused', 'none')
    // Retro: operator-brief path (BEFORE lifecycle.release), mirroring _escalate
    if (this.currentRunId) {
      await this.opts.retroWriter?.write({
        runId: this.currentRunId,
        lesson: brief.slice(0, 200),
        bugPattern: phase,
        convention: 'operator-brief',
      })
      // Fix #2: store to memoryStore on operator-brief terminal path (symmetric with _escalate)
      // Fix #1: respect terminalStored to prevent double-store
      if (!this._terminalStored) {
        this._terminalStored = true
        try {
          await this.opts.memoryStore?.store(this.currentRunId, brief.slice(0, 200), {
            tier: this.currentTier,
            outcome: 'operator-brief',
          })
        } catch (e) { void this.opts.transparency.log(`memory store failed: ${e}`) } // Fix #3
      }
    }
    await this.lifecycle.release()
    // Restore cwd on the operator-brief terminal path too.
    this._restoreCwd()
  }

  /**
   * Heuristic: extract ComplexityInput signals from the P1 spec text.
   * Word-count proxies file-estimate; keyword scan drives novelty/blast/irreversibility.
   */
  private _rescoreFromSpec(spec: string): ComplexityInput {
    const words = spec.split(/\s+/).filter(Boolean)

    // Fix 4: guard against empty/degenerate spec — silently scoring XS on empty input
    // would incorrectly downgrade the tier. Return M-equivalent defaults instead.
    if (words.length === 0) {
      void this.journal.write({
        type: 'decision',
        phase: 'P1',
        action: '_rescoreFromSpec: empty spec — using M-equivalent defaults to prevent silent XS downgrade',
      })
      // files:4 + blast:3*1.5 + novelty:med(2) + irrev:med(2) = 12.5 → tier M (≤13)
      return { files: 4, novelty: 'med', blastRadius: 3, irreversibility: 'med' }
    }

    // Word-count → rough file count proxy (1 file per ~30 words, capped at 20)
    const files = Math.min(Math.max(1, Math.floor(words.length / 30)), 20)

    // Fix 5: dots escaped to prevent wildcard matching (event\.sourcing won't match eventXsourcing)
    // Novelty keywords
    const noveltyHigh = /\b(distributed|microservice|event\.sourcing|CQRS|novel|new architecture|redesign|rethink|blockchain|AI|ML|machine\.learning)\b/i
    const noveltyMed = /\b(integration|migration|refactor|redesign|new\.feature|extend|plugin)\b/i
    const novelty = noveltyHigh.test(spec) ? 'high' : noveltyMed.test(spec) ? 'med' : 'low'

    // Blast-radius keywords (1–5)
    const blastHigh = /\b(cross\.service|platform\.wide|global|all\.users|blast\.radius\.critical|schema\.migration|database\.migration|breaking\.change)\b/i
    const blastMed = /\b(multiple\.services|shared\.library|core\.module|api\.change|breaking)\b/i
    const blastRadius = blastHigh.test(spec) ? 5 : blastMed.test(spec) ? 3 : 1

    // Irreversibility keywords
    const irrevHigh = /\b(irreversible|permanent|delete\.data|drop\.table|non-rollback|cannot\.undo|destructive)\b/i
    const irrevMed = /\b(migration|schema\.change|rename|move\.data|alter\.table)\b/i
    const irreversibility = irrevHigh.test(spec) ? 'high' : irrevMed.test(spec) ? 'med' : 'low'

    return { files, novelty, blastRadius, irreversibility }
  }

  // ── B3a: per-phase rerun helpers ─────────────────────────────────────────────
  // One method per phase so the gate closure and the primary phase path share a
  // single construction site. Called exclusively from _runPhaseGate rerunPhase
  // callbacks. Returns true on success, false when escalation already fired.

  private async _rerunP1(note: string | undefined): Promise<boolean> {
    const r = new P1Discover(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
    const res = await r.execute({
      phase: 'P1', idea: this.currentIdea, sizing: this.currentSizing,
      memoryStore: this.opts.memoryStore, embedder: this.opts.embedder,
      screenContent: this.opts.securityLane ? (t, s) => this.opts.securityLane!.screenContent(t, s) : undefined,
    })
    if (!res.ok || !res.output) { await this._escalate('P1', res.reason ?? 'P1 re-run failed'); return false }
    this.phaseStore.p1 = res.output
    if (note) await this.journal.write({ type: 'decision', phase: 'P1', action: `adjust note: ${note.slice(0, 200)}` })
    return true
  }

  private async _rerunP2(note: string | undefined): Promise<boolean> {
    const r = new P2Elaborate(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
    const res = await r.execute({ phase: 'P2', p1: this.phaseStore.p1!, sizing: this.currentSizing })
    if (!res.ok || !res.output) { await this._escalate('P2', res.reason ?? 'P2 re-run failed'); return false }
    this.phaseStore.p2 = res.output
    if (note) await this.journal.write({ type: 'decision', phase: 'P2', action: `adjust note: ${note.slice(0, 200)}` })
    return true
  }

  private async _rerunP3(note: string | undefined): Promise<boolean> {
    const r = new P3Plan(this.hostAgent, this.outputDir, this.opts.steerTimeoutMs)
    const res = await r.execute({ phase: 'P3', p1: this.phaseStore.p1!, p2: this.phaseStore.p2!, sizing: this.currentSizing })
    if (!res.ok || !res.output) {
      const f = res as { ok: false; reason?: string; operatorBrief?: unknown }
      const brief = f.operatorBrief ? JSON.stringify(f.operatorBrief, null, 2) : undefined
      if (brief) { await this._operatorBrief('P3', brief) } else { await this._escalate('P3', f.reason ?? 'P3 re-run failed') }
      return false
    }
    this.phaseStore.p3 = res.output
    if (note) await this.journal.write({ type: 'decision', phase: 'P3', action: `adjust note: ${note.slice(0, 200)}` })
    return true
  }

  private async _rerunP4(note: string | undefined): Promise<boolean> {
    const r = new P4Build(this.hostAgent, this.outputDir, this.subagentDriver, this.opts.steerTimeoutMs)
    const res = await r.execute({ phase: 'P4', p3: this.phaseStore.p3!, sizing: this.currentSizing, repoRoot: this.repoRoot })
    if (!res.ok || !res.output) { await this._escalate('P4', res.reason ?? 'P4 re-run failed'); return false }
    this.phaseStore.p4 = res.output
    if (note) await this.journal.write({ type: 'decision', phase: 'P4', action: `adjust note: ${note.slice(0, 200)}` })
    return true
  }

  private async _rerunP5(note: string | undefined): Promise<boolean> {
    const r = new P5Verify(this.hostAgent, this.outputDir, this.opts.verifier, this.opts.judge, this.repoRoot, this.opts.steerTimeoutMs)
    const res = await r.execute({ phase: 'P5', p3: this.phaseStore.p3!, p4: this.phaseStore.p4!, sizing: this.currentSizing, repoRoot: this.repoRoot })
    if (!res.ok || !res.output) { await this._escalate('P5', res.reason ?? 'P5 re-run failed'); return false }
    this.phaseStore.p5 = res.output
    if (note) await this.journal.write({ type: 'decision', phase: 'P5', action: `adjust note: ${note.slice(0, 200)}` })
    return true
  }

  // ── B3a: phase gate ───────────────────────────────────────────────────────────

  /**
   * Ask the human what to do after a phase completes (B3a phase-by-phase mode).
   *
   * Guard: only called when this.phaseByPhase === true.
   * If !ctx.hasUI → return 'continue' immediately (autonomous fallback; no UI to ask on).
   * Otherwise calls ctx.ui.select with a bounded timeout.
   * timeout/cancel (undefined) → degrade to 'continue'.
   * Unknown values → degrade to 'continue'.
   */
  private async _phaseGate(
    phaseName: string,
    ctx: ExtensionContext
  ): Promise<'continue' | 'adjust' | 'stop'> {
    const ctxAny = ctx as unknown as { hasUI?: boolean }
    if (!ctxAny.hasUI) return 'continue'

    const uiAny = ctx.ui as unknown as {
      select?(title: string, options: string[], opts: { timeout: number }): Promise<string | undefined>
    }
    if (typeof uiAny.select !== 'function') return 'continue'

    const choice = await uiAny.select(
      `autodev — ${phaseName} complete. Proceed?`,
      ['continue', 'adjust', 'stop'],
      { timeout: this.opts.dialogueTimeoutMs ?? 300_000 }
    )
    if (choice === undefined) return 'continue'
    if (choice === 'continue' || choice === 'adjust' || choice === 'stop') return choice
    return 'continue' // unknown → safe default
  }

  /**
   * B3a: phase-by-phase gate with adjust re-run loop, capped at MAX_ADJUST_PER_PHASE=3.
   * Called on each FORWARD phase boundary when this.phaseByPhase===true.
   * rerunPhase: async fn that re-executes the phase; receives optional human note.
   *   Returns true on success, false if it already called _escalate/_operatorBrief internally.
   * Returns 'continue' | 'stop' | 'escalated'.
   * 'escalated' means rerunPhase returned false — caller must `return` immediately.
   */
  private async _runPhaseGate(
    phaseName: string,
    ctx: ExtensionContext,
    rerunPhase: (note: string | undefined) => Promise<boolean>
  ): Promise<'continue' | 'stop' | 'escalated'> {
    const MAX_ADJUST = 3
    let adjustCount = 0
    let decision = await this._phaseGate(phaseName, ctx)

    while (decision === 'adjust') {
      if (adjustCount >= MAX_ADJUST) {
        await this.journal.write({ type: 'decision', phase: phaseName, action: 'adjust limit reached, continuing' })
        break
      }
      adjustCount++

      // Optionally collect a note via ctx.ui.input (if available)
      const uiAny = ctx.ui as unknown as {
        input?(title: string, placeholder: string): Promise<string | undefined>
      }
      const note = typeof uiAny.input === 'function'
        ? await uiAny.input('What to adjust?', '')
        : undefined

      // Re-run the phase in-place. The FSM is already at the NEXT phase (advanced
      // in _runPhases before calling _runPhaseGate) and must stay there — do NOT
      // call fsm.backedge or fsm.advance here. Those calls would desync the FSM,
      // produce phantom "FSM → Pn" journal entries, and (for P3 gate) illegitimately
      // increment backedgeCount (polluting H9 accounting). rerunPhase re-executes the
      // phase object directly and stores fresh output into phaseStore; it is FSM-independent.
      const ok = await rerunPhase(note)
      if (!ok) return 'escalated'

      decision = await this._phaseGate(phaseName, ctx)
    }

    if (decision === 'stop') return 'stop'
    return 'continue'
  }

  // ── B3b: intent gate ─────────────────────────────────────────────────────────

  /**
   * Ask up to 3 questions via ctx.ui.input when starting a brand-new project with UI.
   *
   * Gate conditions (ALL must hold — any false → skip, return undefined):
   *   1. ctx.hasUI  — UI is available (tui/rpc mode)
   *   2. this.resolvedIsNew — the resolved project is new (not an existing repo)
   *   3. !this.currentForcedTier — no explicit tier/depth override (quick:/mid:/full:)
   *
   * A `build:` prefix leaves forcedTier undefined → gate is eligible (the user gave
   * no depth signal, so we ask). debug:/refactor: early-return before _runPhases (moot).
   *
   * On any answer returning undefined (cancel/timeout) → stop asking, return whatever
   * was gathered so far (partial intent) or undefined if nothing was captured yet.
   * Never hangs: ctx.ui.input is a bounded Promise (dialogueTimeoutMs or 5 min).
   */
  private async _intentGate(
    ctx: ExtensionContext
  ): Promise<{ useCase?: string; scale?: string; audience?: string } | undefined> {
    const ctxAny = ctx as unknown as { hasUI?: boolean }
    if (!ctxAny.hasUI) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate skipped: no UI' })
      return undefined
    }
    if (!this.resolvedIsNew) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate skipped: existing project' })
      return undefined
    }
    if (this.currentForcedTier) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: `intent gate skipped: forcedTier=${this.currentForcedTier}` })
      return undefined
    }

    const uiAny = ctx.ui as unknown as {
      input?(title: string, placeholder?: string, opts?: { timeout: number }): Promise<string | undefined>
    }
    if (typeof uiAny.input !== 'function') {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate skipped: ctx.ui.input not available' })
      return undefined
    }

    void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate fired: asking 3 questions' })
    const timeout = this.opts.dialogueTimeoutMs ?? 300_000
    const intent: { useCase?: string; scale?: string; audience?: string } = {}

    const useCaseRaw = await uiAny.input(
      'What are you building? (use case)',
      'e.g. a todo app, a REST API, a CLI tool',
      { timeout }
    )
    const useCase = useCaseRaw?.trim()
    if (!useCase) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate: use-case empty/cancelled — degrading' })
      return undefined
    }
    intent.useCase = useCase

    const scaleRaw = await uiAny.input(
      'What scale? (team size / user count)',
      'e.g. solo, small team, 1k users',
      { timeout }
    )
    const scale = scaleRaw?.trim()
    if (!scale) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate: scale empty/cancelled — proceeding with partial intent' })
      return intent
    }
    intent.scale = scale

    const audienceRaw = await uiAny.input(
      'Who is the audience?',
      'e.g. just me, internal team, public users',
      { timeout }
    )
    const audience = audienceRaw?.trim()
    if (!audience) {
      void this.journal.write({ type: 'decision', phase: 'P1', action: 'intent gate: audience empty/cancelled — proceeding with partial intent' })
      return intent
    }
    intent.audience = audience

    void this.journal.write({ type: 'decision', phase: 'P1', action: `intent gate complete: useCase="${useCase}" scale="${scale}" audience="${audience}"` })
    return intent
  }

  /**
   * Poll until the pause file is removed.
   *
   * Fix 7: cap the wait at MAX_RESUME_WAIT_MS (default 1 hour) to prevent
   * infinite polling if the pause file is never removed (e.g. operator forgets,
   * or the file is accidentally left behind). After the cap, escalate to operator.
   */
  private _waitResume(): Promise<void> {
    const MAX_RESUME_WAIT_MS = 60 * 60 * 1000 // 1 hour
    const POLL_INTERVAL_MS = 2000
    const deadline = Date.now() + MAX_RESUME_WAIT_MS

    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (Date.now() >= deadline) {
          reject(new Error(
            `_waitResume: pause file not removed within ${MAX_RESUME_WAIT_MS / 1000}s — escalating to operator`
          ))
          return
        }
        void this._isPaused().then((paused) => {
          if (!paused) resolve()
          else setTimeout(check, POLL_INTERVAL_MS)
        })
      }
      check()
    })
  }
}
