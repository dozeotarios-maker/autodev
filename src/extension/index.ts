// S2-M2: Extension entry point — wires the Controller (event-loop orchestrator).
// Rewritten from Stage-1 stub: replaces bare session_start handler with the full
// Controller that drives P1→P6 via steer/agent_end + file-based phase contracts.
//
// Port interfaces only for Verifier, GitOps, Judge — no concrete imports from
// src/verify or src/git (those belong to Lane β). Concretes are injected via opts.

import type { ExtensionAPI, SessionShutdownEvent } from '@earendil-works/pi-coding-agent'
import type {
  MemoryStore,
  Embedder,
  Lane,
  Verifier,
  GitOps,
  Transparency,
  Judge,
  TokenVault,
  SecurityLane,
  Resurrection,
  SecurityFinding,
} from '../ports.js'

// ── Lane A: Memory ────────────────────────────────────────────────────────────
import { LettaAdapter } from '../memory/letta-adapter.js'
import { GeminiEmbedder } from '../memory/gemini-embedder.js'
import { OllamaEmbedder } from '../memory/ollama-embedder.js'
import { CodebaseMemoryAdapter } from '../memory/codebase-memory-adapter.js'

// ── Lane D: Transparency ──────────────────────────────────────────────────────
import { TransparencyImpl } from '../transparency/index.js'
import type { PiHudClient } from '../transparency/hud.js'

// ── Lane C: Git ───────────────────────────────────────────────────────────────
import { ScopedCommit } from '../git/scoped-commit.js'
import { PerPhasePush } from '../git/per-phase-push.js'
import { TierDGate } from '../git/tier-d-gate.js'
import { GitleaksHook } from '../git/gitleaks-hook.js'
import { TokenVaultImpl } from '../git/token-vault.js'
import { ChangedFiles } from '../git/changed-files.js'

// ── Lane E: Verify ────────────────────────────────────────────────────────────
import { DeterministicVerifier } from '../verify/deterministic.js'
import { MutationGate } from '../verify/mutation.js'
import { HoldoutVerifier } from '../verify/holdout.js'
import { BoundedExecImpl } from '../verify/bounded-exec.js'
import { ActionMonitor } from '../safety/action-monitor.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── Env: load .env from the package root so keys (GEMINI_API_KEY, etc.) survive
// across pi launches without a manual export. Minimal parser — no dotenv dep.
// Never overrides a variable already set in the process environment.
function loadDotEnv(): void {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim()
      let val = trimmed.slice(eq + 1).trim()
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
        val = val.slice(1, -1)
      }
      if (key && process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    // No or unreadable .env — leave the environment untouched.
  }
}
loadDotEnv()

// ── S2-M8: Real concretes wired here ─────────────────────────────────────────
import { SubagentJudge } from '../verify/subagent-judge.js'
import { LaneSubagentRunner } from '../lanes/subagent-runner.js'
import { HostAgent } from '../host/host-agent.js'
import { SubagentDriver } from '../host/subagent-driver.js'

// ── Lane B: Engine ────────────────────────────────────────────────────────────
import { FSM } from '../engine/fsm.js'
import { ResurrectionEngine } from '../engine/resurrection.js'

// ── Lane B: Lanes ─────────────────────────────────────────────────────────────
import { partitionFiles } from '../lanes/partitioner.js'
import { Integrator } from '../lanes/integrator.js'
import { ContractRegistry } from '../lanes/contract-registry.js'
import { SubagentRunner } from '../lanes/subagent-runner.js'

// ── S2-M2: Controller ────────────────────────────────────────────────────────
import { Controller } from '../host/controller.js'
import { ProjectRegistry } from '../project/registry.js'

// ── Extension options (all external boundaries injectable for test isolation) ──
export interface AutodevExtensionOptions {
  // Memory
  memoryStore?: MemoryStore
  embedder?: Embedder
  // Transparency
  transparency?: Transparency
  hudClient?: PiHudClient
  repoRoot?: string
  // Git
  gitOps?: GitOps
  // Verifier
  verifier?: Verifier
  // Tokens
  tokenVault?: TokenVault
  // Security
  securityLane?: SecurityLane
  // Resurrection
  resurrection?: Resurrection
  // Judge
  judge?: Judge
  // Project registry (injectable for test isolation)
  registry?: ProjectRegistry
}

// ── Composed concrete adapters ─────────────────────────────────────────────────

function buildMemoryStore(opts: AutodevExtensionOptions): MemoryStore {
  if (opts.memoryStore) return opts.memoryStore
  const mock = process.env['LETTA_MOCK'] === '1'
  return new LettaAdapter({ mock })
}

function buildEmbedder(opts: AutodevExtensionOptions): Embedder {
  if (opts.embedder) return opts.embedder
  const geminiApiKey = process.env['GEMINI_API_KEY']
  const ollama = new OllamaEmbedder({ mock: process.env['OLLAMA_MOCK'] === '1' })

  // Skip Gemini entirely when no API key is set — avoids wasteful 401 before fallback.
  if (!geminiApiKey) {
    console.warn('[pi-autodev] GEMINI_API_KEY not set — using Ollama embedder directly')
    return ollama
  }

  const gemini = new GeminiEmbedder({
    mock: process.env['GEMINI_MOCK'] === '1',
    apiKey: geminiApiKey,
  })

  const fallbackEmbedder: Embedder = {
    async embed(texts: string[]): Promise<number[][]> {
      try {
        return await gemini.embed(texts)
      } catch (err) {
        console.warn('[pi-autodev] Gemini embedder unavailable, falling back to Ollama:', err instanceof Error ? err.message : String(err))
        return ollama.embed(texts)
      }
    },
    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
      const g = await gemini.healthCheck()
      if (g.ok) return g
      return ollama.healthCheck()
    },
  }
  return fallbackEmbedder
}

function buildTransparency(opts: AutodevExtensionOptions): Transparency {
  if (opts.transparency) return opts.transparency
  const repoRoot = opts.repoRoot ?? process.cwd()
  const hudClient: PiHudClient = opts.hudClient ?? {
    setWidget: () => { /* no-op stub */ },
  }
  return new TransparencyImpl(repoRoot, hudClient)
}

/**
 * GitOps with a setRepoRoot hook so the controller can re-root the
 * construction-captured git adapters (ScopedCommit/PerPhasePush/GitleaksHook)
 * after a project re-root. Without this, P6 would commit/push and scan the
 * build-time cwd instead of the resolved project dir.
 */
export interface ReRootableGitOps extends GitOps {
  setRepoRoot(dir: string): void
}

function buildGitOps(opts: AutodevExtensionOptions): ReRootableGitOps {
  const tierDGate = new TierDGate({ timeoutMs: 30_000 })
  tierDGate.setApprovalProvider(async () => false)

  // Rebuildable cwd-bound adapters: scopedCommit/perPhasePush/gitleaks freeze cwd
  // at construction, so re-rooting means rebuilding them against the new dir.
  let cwd = opts.repoRoot ?? process.cwd()
  let scopedCommit = new ScopedCommit(cwd)
  let perPhasePush = new PerPhasePush(cwd)
  let gitleaksHook = new GitleaksHook(cwd)

  // If an external gitOps is injected, wrap it so setRepoRoot is still present
  // (a no-op for the injected impl — it owns its own dir handling).
  const changedFilesImpl = new ChangedFiles()

  if (opts.gitOps) {
    const injected = opts.gitOps
    return {
      scopedCommit: (msg, paths) => injected.scopedCommit(msg, paths),
      perPhasePush: (branch) => injected.perPhasePush(branch),
      tierDGate: (action, brief) => injected.tierDGate(action, brief),
      scanSecrets: (staged) => injected.scanSecrets(staged),
      changedFiles: (wdir) => injected.changedFiles(wdir),
      setRepoRoot: () => { /* injected gitOps manages its own dir */ },
    }
  }

  return {
    scopedCommit: (msg, paths) => scopedCommit.scopedCommit(msg, paths),
    perPhasePush: (branch) => perPhasePush.perPhasePush(branch),
    tierDGate: (action, brief) => tierDGate.tierDGate(action, brief),
    scanSecrets: (staged) => gitleaksHook.scanSecrets(staged),
    changedFiles: (wdir) => changedFilesImpl.changedFiles(wdir),
    setRepoRoot: (dir: string) => {
      cwd = dir
      scopedCommit = new ScopedCommit(cwd)
      perPhasePush = new PerPhasePush(cwd)
      gitleaksHook = new GitleaksHook(cwd)
    },
  }
}

function buildVerifier(opts: AutodevExtensionOptions): Verifier {
  if (opts.verifier) return opts.verifier
  const det = new DeterministicVerifier()
  const judge = opts.judge ?? noopJudge()
  const holdout = new HoldoutVerifier(judge)
  return {
    runDeterministic: (testCmd, wd) => det.run(testCmd, wd),
    runMutation: (wd, threshold) => new MutationGate({ threshold }).run(wd),
    runHoldout: async (testCmd, wd) => {
      const det2 = new DeterministicVerifier()
      const detResult = await det2.run(testCmd, wd)
      const holdoutResult = await holdout.run({
        goal: testCmd,
        evidence: detResult.output,
        testFiles: [],
        testFilesSnapshot: {},
      })
      return { passed: holdoutResult.passed, output: holdoutResult.reason ?? detResult.output }
    },
    // Honor the wd arg (P5 passes the resolved repoRoot). A fresh GitleaksHook
    // is bound to the caller-supplied dir so the scan targets the right tree.
    runSecurityScan: (wd) => new GitleaksHook(wd).scan({ staged: false }),
  }
}

function buildTokenVault(opts: AutodevExtensionOptions): TokenVault {
  if (opts.tokenVault) return opts.tokenVault
  const home = process.env['HOME'] ?? '/root'
  return new TokenVaultImpl(`${home}/.pi/autodev/vault`)
}

function buildSecurityLane(opts: AutodevExtensionOptions): SecurityLane {
  if (opts.securityLane) return opts.securityLane
  const INJECTION_PATTERNS = [
    /ignore previous instructions/i,
    /system prompt/i,
    /\bexfiltrate\b/i,
    /curl\s+https?:\/\//i,
    /fetch\(.*secrets/i,
  ]
  return {
    async reviewDiff(diff: string): Promise<{ clean: boolean; findings: SecurityFinding[] }> {
      const findings: SecurityFinding[] = []
      for (const pat of INJECTION_PATTERNS) {
        if (pat.test(diff)) findings.push({ severity: 'HIGH', description: `Prompt-injection: ${pat.source}` })
      }
      return { clean: findings.length === 0, findings }
    },
    async screenContent(content: string, _source: 'repo' | 'web'): Promise<{ safe: boolean; threats: string[] }> {
      const threats: string[] = []
      for (const pat of INJECTION_PATTERNS) {
        if (pat.test(content)) threats.push(`Prompt-injection: ${pat.source}`)
      }
      return { safe: threats.length === 0, threats }
    },
  }
}

function buildResurrection(opts: AutodevExtensionOptions, fsm: FSM): Resurrection {
  if (opts.resurrection) return opts.resurrection
  const engine = new ResurrectionEngine()
  engine.hookFSM(fsm)
  return {
    reconstruct: (j, c) => engine.reconstruct(j, c),
    resume: (state, options) => engine.resume(state, options),
    isIdempotentSafe: (action, ledgerPath) => engine.isIdempotentSafe(action, ledgerPath),
  }
}

function buildLaneAdapter(id: string, files: string[], runner?: SubagentRunner): Lane {
  return {
    id,
    files,
    async run(task: string, options?: { workdir?: string }): Promise<{ output: string; exitCode: number }> {
      if (runner) {
        const r = await runner.run(task, { workdir: options?.workdir })
        return { output: r.output, exitCode: r.exitCode }
      }
      void options
      return { output: `[lane ${id}] queued: ${task}`, exitCode: 0 }
    },
    status() { return 'idle' as const },
  }
}

// ── No-op stub judge (fallback when no SubagentDriver is available) ──────────
// isStillRight returns aligned:false (fail-safe) so H9 is disabled rather than
// silently bypassed when no real judge is wired.
function noopJudge(): Judge {
  console.warn('[pi-autodev] noopJudge active: no real judge wired — H9 alignment checks disabled')
  return {
    async isDone(_goal: string, _evidence: string): Promise<boolean> { return false },
    async isStillRight(_spec: string, _diff: string): Promise<{ aligned: boolean; reason?: string }> {
      return { aligned: false, reason: 'no judge available' }
    },
  }
}

// ── S2-M8: Build the real SubagentDriver from a HostAgent ───────────────────
// Both SubagentJudge and LaneSubagentRunner depend on SubagentDriver which
// depends on HostAgent. HostAgent needs a pi-like object with sendUserMessage.
// In buildExtension (static composition) we don't have pi yet, so a
// SubagentDriver + SubagentJudge can only be built at extension entry time
// (when the real pi is available). buildExtension supports injection via opts.judge.
// The autodevExtension entry point below wires the real concretes.
function buildJudge(opts: AutodevExtensionOptions, driver?: SubagentDriver): Judge {
  if (opts.judge) return opts.judge
  if (driver) return new SubagentJudge(driver)
  return noopJudge()
}

function buildLaneSubagentRunner(driver?: SubagentDriver): LaneSubagentRunner | undefined {
  if (!driver) return undefined
  return new LaneSubagentRunner(driver, { concurrency: 5 })
}

// ── buildExtension — composes all adapters ────────────────────────────────────

export function buildExtension(opts: AutodevExtensionOptions = {}): {
  memoryStore: MemoryStore
  embedder: Embedder
  transparency: Transparency
  gitOps: GitOps
  verifier: Verifier
  tokenVault: TokenVault
  securityLane: SecurityLane
  resurrection: Resurrection
  judge: Judge
  fsm: FSM
  registry: ContractRegistry
  integrator: Integrator
  partitionFiles: typeof partitionFiles
  buildLane: (id: string, files: string[], runner?: SubagentRunner) => Lane
  SubagentRunner: typeof SubagentRunner
} {
  const fsm = new FSM()
  const registry = new ContractRegistry()
  const integrator = new Integrator(registry)

  return {
    memoryStore: buildMemoryStore(opts),
    embedder: buildEmbedder(opts),
    transparency: buildTransparency(opts),
    gitOps: buildGitOps(opts),
    verifier: buildVerifier(opts),
    tokenVault: buildTokenVault(opts),
    securityLane: buildSecurityLane(opts),
    resurrection: buildResurrection(opts, fsm),
    // S2-M8: judge is noopJudge here (no pi available at static compose time).
    // The real SubagentJudge is wired in autodevExtension() where pi is available.
    judge: opts.judge ?? noopJudge(),
    fsm,
    registry,
    integrator,
    partitionFiles,
    buildLane: buildLaneAdapter,
    SubagentRunner,
  }
}

// ── Extension entry point (S2-M2, wired with real concretes in S2-M8) ────────
//
// Wiring map (S2-M8):
//   HostAgent        ← pi (ExtensionAPI with sendUserMessage)
//   SubagentDriver   ← HostAgent  (composes steer + git-stash guard)
//   SubagentJudge    ← SubagentDriver  (Judge port — replaces noopJudge)
//   LaneSubagentRunner ← SubagentDriver  (build lane — worktree-isolated pi-subagents)
//   HoldoutVerifier  ← SubagentJudge
//   Verifier         ← DeterministicVerifier + MutationGate + HoldoutVerifier (SubagentJudge)
//   LettaAdapter     ← LETTA_MOCK env / real HTTP
//   CodebaseMemoryAdapter ← CODEBASE_MEMORY_MOCK env / stdio JSON-RPC binary
//
// All external boundaries (Letta HTTP, codebase-memory binary, CLIs, pi-hud)
// remain injectable via AutodevExtensionOptions for test isolation.

export default function autodevExtension(pi: ExtensionAPI): void {
  const repoRoot = process.cwd()

  // ── Real HostAgent + SubagentDriver (need pi at runtime) ──────────────────
  const hostAgent = new HostAgent(pi)
  const subagentDriver = new SubagentDriver(hostAgent)

  // ── Real Judge: SubagentJudge via SubagentDriver ───────────────────────────
  const judge = buildJudge({}, subagentDriver)

  // ── Real LaneSubagentRunner (build lane, worktree-isolated) ───────────────
  const _laneRunner = buildLaneSubagentRunner(subagentDriver)
  void _laneRunner // available for P4Build if wired via opts; currently SubagentDriver is in Controller

  // ── Verifier with real SubagentJudge for holdout ──────────────────────────
  const det = new DeterministicVerifier()
  const holdout = new HoldoutVerifier(judge)
  const verifier: Verifier = {
    runDeterministic: (testCmd, wd) => det.run(testCmd, wd),
    runMutation: (wd, threshold) => new MutationGate({ threshold }).run(wd),
    runHoldout: async (testCmd, wd) => {
      const det2 = new DeterministicVerifier()
      const detResult = await det2.run(testCmd, wd)
      const holdoutResult = await holdout.run({
        goal: testCmd,
        evidence: detResult.output,
        testFiles: [],
        testFilesSnapshot: {},
      })
      return { passed: holdoutResult.passed, output: holdoutResult.reason ?? detResult.output }
    },
    // Honor the wd arg (P5 passes the resolved repoRoot) so the scan follows the re-root.
    runSecurityScan: (wd) => new GitleaksHook(wd).scan({ staged: false }),
  }

  // ── Memory (injectable; real Letta + real codebase-memory) ────────────────
  const transparency = buildTransparency({ repoRoot })
  const gitOps = buildGitOps({ repoRoot })

  const memoryStore = buildMemoryStore({})
  const embedder = buildEmbedder({})
  const codebaseMemory = new CodebaseMemoryAdapter()

  const securityLane = buildSecurityLane({})

  const registry = new ProjectRegistry()

  const boundedExec = new BoundedExecImpl(new ActionMonitor([repoRoot]))

  const controller = new Controller(pi, {
    repoRoot,
    verifier,
    gitOps,
    judge,
    transparency,
    memoryStore,
    embedder,
    codebaseMemory,
    securityLane,
    registry,
    boundedExec,
  })

  controller.wire()
  controller.registerCommands()

  // Fix #8: dispose the long-lived codebaseMemory child process on session teardown.
  // pi provides `session_shutdown` which fires on /quit, SIGINT, SIGTERM, and session
  // replacement — the correct hook for releasing long-lived resources.
  // Process signal handlers are NOT registered here: pi already emits session_shutdown
  // on SIGINT/SIGTERM (confirmed in CHANGELOG: "session_shutdown fires on SIGTERM/SIGHUP
  // in interactive, print, and RPC modes so extensions can run shutdown cleanup").
  pi.on('session_shutdown', (_e: SessionShutdownEvent, _ctx) => {
    try { codebaseMemory.dispose() } catch { /* idempotent — swallow if already closed */ }
  })
}
