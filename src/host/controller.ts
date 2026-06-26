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
import type { Verifier, GitOps, Judge, Transparency, MemoryStore, Embedder, SecurityLane } from '../ports.js'
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
import { scoreComplexity, tierSizing, DEFAULT_SIZING } from '../engine/complexity.js'
import type { Sizing, ComplexityInput, ComplexityTier } from '../engine/complexity.js'
import type { RetroWriter } from '../engine/retro.js'
import { resolveProjectDir } from '../project/resolver.js'
import type { ProjectRegistry } from '../project/registry.js'

// ── compactAsync ─────────────────────────────────────────────────────────────

/**
 * Promise wrapper over ctx.compact({ onComplete, onError }).
 * The controller MUST await this before the next steer — otherwise the next
 * message lands in a pre-compaction context.
 */
export function compactAsync(ctx: ExtensionContext): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ctx.compact({
      onComplete: () => resolve(),
      onError: (err: Error) => {
        // "Nothing to compact" on a small session at a phase boundary is benign — skip it.
        // "Already compacted" fires on back-to-back zero-work compaction at phase boundaries
        // (the session hasn't grown since the last compaction). Also benign — skip it.
        if (/nothing to compact|too small|already compacted/i.test(err.message)) {
          resolve()
        } else {
          reject(err)
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
  /** Optional RetroWriter for post-run retro (injected for test isolation) */
  retroWriter?: RetroWriter
  /** Optional memory backends — wired at entry; consumed by P1 and retro. */
  memoryStore?: MemoryStore
  embedder?: Embedder
  codebaseMemory?: { healthCheck(): Promise<{ ok: boolean; details?: string }>; ensureIndexed?(): Promise<void> }
  /** Optional security lane — used to screen recalled memory before injecting into instructions. */
  securityLane?: SecurityLane
  /** Optional project registry — when injected, _resolveRepoRoot re-roots the build dir from the idea. */
  registry?: ProjectRegistry
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

  private phaseStore: PhaseStore = {}
  private currentIdea = ''
  private startedAt = Date.now()
  private currentSizing: Sizing = DEFAULT_SIZING
  private currentTier: ComplexityTier = 'M'
  private currentRunId = ''
  /** Fix #1: set true after the first terminal store so _escalate cannot double-store. */
  private _terminalStored = false

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
          // Set active project; register cwd under that name if new
          const existing = await this.opts.registry.get(name)
          if (!existing) {
            await this.opts.registry.register(name, process.cwd())
          }
          await this.opts.registry.setActive(name)
          const meta = await this.opts.registry.get(name)
          ctx.ui.notify(`[pi-autodev] Active project: ${name} -> ${meta?.dir ?? process.cwd()}`, 'info')
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

    // Capture idea in a local — do NOT write this.currentIdea yet.
    // Fix: two concurrent _onInput calls must not overwrite each other's idea
    // before the lock is won. this.currentIdea is only written by the winner,
    // after lifecycle.run() returns {ok:true}.
    const idea = text.trim()

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

    // Lock won — now safe to update the shared field.
    this.currentIdea = idea

    // Re-root repoRoot to the resolved project dir (async, before _runPhases).
    // _resolveRepoRoot is a no-op when no registry is injected (preserves current behavior).
    await this._resolveRepoRoot(idea)

    // Start P1 asynchronously within the extension event loop
    void this._runPhases(ctx)
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
        const filePath = (
          input['file_path'] as string | undefined ??
          input['path'] as string | undefined ??
          input['target_file'] as string | undefined
        )
        if (filePath) {
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
      // ── Run-start: default tier M, set thinking level ─────────────────────
      this.currentRunId = `run-${crypto.randomUUID()}`
      this.currentSizing = tierSizing('M')
      this.currentTier = 'M'
      this._terminalStored = false // Fix #1: reset per-run so consecutive runs don't share state
      const pi = this.pi as unknown as { setThinkingLevel?: (level: string) => void }
      pi.setThinkingLevel?.(this.currentSizing.thinkingLevel)

      await this.journal.write({ type: 'pre-action', phase: 'P1', action: 'starting P1 DISCOVER' })

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
      })
      if (!p1Result.ok || !p1Result.output) {
        await this._escalate('P1', p1Result.reason ?? 'P1 failed')
        return
      }
      this.phaseStore.p1 = p1Result.output

      // ── Post-P1 rescore: update tier+sizing from the spec text ────────────
      const rescoreInput = this._rescoreFromSpec(this.phaseStore.p1.spec)
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

      await this.journal.write({ type: 'completion', phase: 'P1', action: 'P1 complete' })
      this.opts.transparency.setHudStatus('P1→P2', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx)
      await this.fsm.advance()
      this.opts.transparency.setHudStatus('P2', this.currentIdea.slice(0, 60), 'running', 'opus')

      // ── P2 ELABORATE ─────────────────────────────────────────────────────
      if (await this._isPaused()) { await this._waitResume() }

      const p2 = new P2Elaborate(this.hostAgent, this.outputDir, this.subagentDriver, this.opts.steerTimeoutMs)
      const p2Result = await p2.execute({ phase: 'P2', p1: this.phaseStore.p1, sizing: this.currentSizing })
      if (!p2Result.ok || !p2Result.output) {
        await this._escalate('P2', p2Result.reason ?? 'P2 failed')
        return
      }
      this.phaseStore.p2 = p2Result.output
      await this.journal.write({ type: 'completion', phase: 'P2', action: 'P2 complete' })
      this.opts.transparency.setHudStatus('P2→P3', this.currentIdea.slice(0, 60), 'compacting', 'opus')

      await compactAsync(ctx)
      await this.fsm.advance()
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

      await compactAsync(ctx)
      await this.fsm.advance()
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

      await compactAsync(ctx)
      await this.fsm.advance()
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

      await compactAsync(ctx)
      await this.fsm.advance()
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
      this.opts.transparency.setHudStatus('DONE', p6Result.output.commitSha, 'done', 'none')
      await this.opts.transparency.log(`ALL DONE: commit=${p6Result.output.commitSha}`)

    } catch (err) {
      await this._escalate(this.fsm.getPhase(), `Unexpected error: ${String(err)}`)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Re-roots repoRoot, outputDir, journal, actionMonitor, pauseFilePath from
   * the resolved project dir. No-op if no registry is injected (preserves
   * existing behavior: repoRoot stays process.cwd()).
   */
  private async _resolveRepoRoot(idea: string): Promise<void> {
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

    this.repoRoot = r.dir
    this.subagentDriver.setRepoRoot(r.dir)

    // mkdir -p the resolved dir if new
    if (r.isNew) {
      await fs.mkdir(r.dir, { recursive: true })
    }

    // Re-derive all repoRoot-dependent fields
    this.outputDir = path.join(r.dir, '.autodev', 'phase-output')
    this.pauseFilePath = path.join(r.dir, '.autodev', 'PAUSE')
    this.journal = new Journal(path.join(r.dir, '.autodev', 'journal.jsonl'))
    this.actionMonitor = new ActionMonitor([r.dir])

    // Register in registry
    await this.opts.registry.register(r.name, r.dir, { lastRun: new Date().toISOString() })
    if (!r.isNew) {
      await this.opts.registry.setActive(r.name)
    }

    // Index existing codebase (degrade gracefully on failure)
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
      action: `resolved project '${r.name}' -> ${r.dir} (${r.isNew ? 'new' : 'existing'})`,
    })
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
