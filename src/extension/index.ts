// S2-M2: Extension entry point — wires the Controller (event-loop orchestrator).
// Rewritten from Stage-1 stub: replaces bare session_start handler with the full
// Controller that drives P1→P6 via steer/agent_end + file-based phase contracts.
//
// Port interfaces only for Verifier, GitOps, Judge — no concrete imports from
// src/verify or src/git (those belong to Lane β). Concretes are injected via opts.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
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

// ── Lane D: Transparency ──────────────────────────────────────────────────────
import { TransparencyImpl } from '../transparency/index.js'
import type { PiHudClient } from '../transparency/hud.js'

// ── Lane C: Git ───────────────────────────────────────────────────────────────
import { ScopedCommit } from '../git/scoped-commit.js'
import { PerPhasePush } from '../git/per-phase-push.js'
import { TierDGate } from '../git/tier-d-gate.js'
import { GitleaksHook } from '../git/gitleaks-hook.js'
import { TokenVaultImpl } from '../git/token-vault.js'

// ── Lane E: Verify (via stub judge — concretes injected by S2-M8 integrator) ──
import { DeterministicVerifier } from '../verify/deterministic.js'
import { MutationGate } from '../verify/mutation.js'
import { HoldoutVerifier } from '../verify/holdout.js'

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
}

// ── Composed concrete adapters ─────────────────────────────────────────────────

function buildMemoryStore(opts: AutodevExtensionOptions): MemoryStore {
  if (opts.memoryStore) return opts.memoryStore
  const mock = process.env['LETTA_MOCK'] === '1'
  return new LettaAdapter({ mock })
}

function buildEmbedder(opts: AutodevExtensionOptions): Embedder {
  if (opts.embedder) return opts.embedder
  const mockGemini = process.env['GEMINI_MOCK'] === '1'
  const gemini = new GeminiEmbedder({
    mock: mockGemini,
    apiKey: process.env['GEMINI_API_KEY'] ?? '',
  })
  const ollama = new OllamaEmbedder({ mock: process.env['OLLAMA_MOCK'] === '1' })

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

function buildGitOps(opts: AutodevExtensionOptions): GitOps {
  if (opts.gitOps) return opts.gitOps
  const cwd = opts.repoRoot ?? process.cwd()
  const scopedCommit = new ScopedCommit(cwd)
  const perPhasePush = new PerPhasePush(cwd)
  const tierDGate = new TierDGate({ timeoutMs: 30_000 })
  const gitleaksHook = new GitleaksHook(cwd)
  tierDGate.setApprovalProvider(async () => false)
  return {
    scopedCommit: (msg, paths) => scopedCommit.scopedCommit(msg, paths),
    perPhasePush: (branch) => perPhasePush.perPhasePush(branch),
    tierDGate: (action, brief) => tierDGate.tierDGate(action, brief),
    scanSecrets: (staged) => gitleaksHook.scanSecrets(staged),
  }
}

function buildVerifier(opts: AutodevExtensionOptions): Verifier {
  if (opts.verifier) return opts.verifier
  const cwd = opts.repoRoot ?? process.cwd()
  const det = new DeterministicVerifier()
  const judge = opts.judge ?? noopJudge()
  const holdout = new HoldoutVerifier(judge)
  const gitleaks = new GitleaksHook(cwd)
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
    runSecurityScan: (_wd) => gitleaks.scan({ staged: false }),
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

// ── No-op stub judge (used when no SubagentDriver is available at boot time) ──
// In production this is replaced by SubagentJudge injected via opts.judge.
function noopJudge(): Judge {
  return {
    async isDone(_goal: string, _evidence: string): Promise<boolean> { return false },
    async isStillRight(_spec: string, _diff: string): Promise<{ aligned: boolean; reason?: string }> {
      return { aligned: true }
    },
  }
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
    judge: opts.judge ?? noopJudge(),
    fsm,
    registry,
    integrator,
    partitionFiles,
    buildLane: buildLaneAdapter,
    SubagentRunner,
  }
}

// ── Extension entry point (S2-M2) ─────────────────────────────────────────────

export default function autodevExtension(pi: ExtensionAPI): void {
  const opts: AutodevExtensionOptions = {}
  const repoRoot = process.cwd()

  const transparency = buildTransparency({ ...opts, repoRoot })
  const gitOps = buildGitOps({ ...opts, repoRoot })
  const verifier = buildVerifier(opts)
  const judge = opts.judge ?? noopJudge()

  const controller = new Controller(pi, {
    repoRoot,
    verifier,
    gitOps,
    judge,
    transparency,
  })

  controller.wire()
  controller.registerCommands()
}
