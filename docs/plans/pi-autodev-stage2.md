# pi-autodev — Stage-2 Implementation Plan (the engine) — v2, ralplan-hardened

> **For Claude:** Passed ralplan consensus (Planner → Architect → Critic). Executed via executor subagents (omc-teams is env-blocked here). TDD per task. Builds on the Stage-1 foundation (13 commits, 341 tests, `~/pi-autodev` on `main`).

**Goal:** Make pi-autodev RUN — turn the Stage-1 skeleton (empty FSM, stubbed model/subagent boundaries) into a working autonomous engine that takes one idea and drives it through P1→P6 to shipped code.

**Architecture (v2, research- + ralplan-verified):** A pi extension has **no standalone model-call API**, and **`ctx.newSession()` is unavailable in event handlers** (it lives only on `ExtensionCommandContext`, verified in `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:246-283`; event handlers get the base `ExtensionContext`). Therefore the engine runs as **one long host session** that the controller **steers** (`pi.sendUserMessage(prompt,{deliverAs:'followUp'})`, fire-and-forget `void`) and observes via `agent_end`. **The backbone is FILE-BASED PHASE CONTRACTS:** each phase steers the host to write its authoritative output to `.autodev/phase-output/p{N}-{name}.json`; the controller reads + schema-validates the file (deterministic), not free-form conversation text. Because the real data lives in files, **context-rot is a non-issue**: the controller calls `ctx.compact()` aggressively at each phase boundary and masks stale messages via the `context` event (extending the Stage-1 `ObservationMasker`). Parallelism + clean-context = **pi-subagents** (LLM-mediated `subagent` tool; results in `turn_end`).

**Tech stack:** Stage-1 codebase (TypeScript) + the real pi ExtensionAPI: `sendUserMessage` (void), `on('agent_end'|'turn_end'|'input'|'tool_call'|'context'|'session_before_compact'|'session_start')`, `ctx.compact()`, `registerCommand`, `ctx.ui`, `appendEntry`, `pi.exec()`. pi-subagents (worktree mode) · Letta HTTP · codebase-memory-mcp (direct binary `pi.exec`, stdio JSON-RPC) · verify CLIs via `pi.exec`.

## Governing API facts (verified against the installed types.d.ts)
- `ctx.newSession()` / `waitForIdle()` → **ExtensionCommandContext ONLY** (command handlers). NOT available in `agent_end`/event handlers. Per-phase sessions are impossible.
- `ctx.compact()` → available on `ExtensionContext` (event handlers). Triggers summarizing compaction.
- `context` event → fires before each LLM call; handler may return `{messages}` to rewrite the array (masking).
- `session_before_compact` event → handler may inject custom compaction instructions / ensure phase files are flushed first.
- `pi.sendUserMessage(content, {deliverAs?:'steer'|'followUp'})` → returns **void** (fire-and-forget). The result arrives via `agent_end` (`event.messages`).
- `agent_end` has **no correlation ID** → correlation is by "one steer in-flight (mutex) → the next `agent_end` is mine"; the file-contract check is the real validation.
- `pi.exec(command, args, options?)` → `Promise<ExecResult>` — used for codebase-memory-mcp + verify CLIs.

## File-based phase contracts (THE BACKBONE)
| Phase | Output file | Schema (key fields) |
|-------|-------------|---------------------|
| P1 DISCOVER | `.autodev/phase-output/p1-spec.json` | `{spec, stackAdr, webResearch[]}` |
| P2 ELABORATE | `.autodev/phase-output/p2-domain.json` | `{domainModel, personaDebate[]}` |
| P3 PLAN | `p3-plan.json` + `p3-sprint-contract.json` + `p3-examples.json` | `{fileDAG, panelObjCount, sprintContract, examplesTable}` |
| P4 BUILD | `p4-build.json` | `{laneResults[], artifacts[]}` |
| P5 VERIFY | `p5-verify.json` | `{verifyReport, reviewFindings[]}` |
| P6 RELEASE | `p6-release.json` | `{commitSha, pushResult}` |

**Steer-then-verify pattern (every phase):** controller steers host → "do <phase work>, write result to `<file>`" → awaits `agent_end` → reads + schema-validates `<file>` → on missing/invalid: retry (≤2) → escalate to operator. The next phase's `PhaseContext` is the prior phase's parsed file (the controller injects a concise reference into the next steer).

## Standing rules
Test-first (D1) · web-currency (D2) · best model (D3) · incremental wiring (D4) · pre-decompose before dispatch (D5) · meta-build H1 on build's own milestones (D6) · rollback to last green (D7).

## Test strategy (mock host, no real model)
Inject a mock `pi`: `sendUserMessage` records the steer prompt; the test fires a synthetic `agent_end` AND simulates the host having written the phase file (test writes the `.autodev/phase-output/*.json`); assert the controller read it, validated, ran the gate, advanced. compact()/context-event masking are asserted via mock-call tracking. Real-model behavior = the manual smoke (`scripts/smoke-run.mjs`).

---

## Milestones (each behind an H1 default-FAIL contract)

### S2-M1 — HostAgent steering primitive (FOUNDATION — blocks all)
- **Files:** `src/host/host-agent.ts`, `src/host/subagent-driver.ts`, `src/host/types.ts` (`AgentResult`, `SteerOptions`, `SteerInFlightError`, `DirtyTreeError`), `tests/host/*`. Also reworks `src/engine/self-prompt.ts` (the void-return fix) — owned here.
- **Goal:** `HostAgent.steer(prompt, {expectFile?, expectTool?, timeoutMs}) → Promise<AgentResult>`: increments a monotonic seq, acquires the steer **mutex** (throw `SteerInFlightError` if held), calls `pi.sendUserMessage(prompt,{deliverAs:'followUp'})` (void), resolves on the next `agent_end` with `{rawText, toolResults, seq}`, **then validates** (if `expectFile`: the file exists + parses; if `expectTool`: that tool appears in messages) — on failure, retry ≤2, else reject. Timeout rejects. `SubagentDriver.invoke(tasks,{worktree,concurrency})`: pre-checks `git status --porcelain` (auto-stash if dirty, pop after; `DirtyTreeError` if stash conflicts), composes the `subagent`-tool instruction, steers it, parses results by filtering `turn_end.toolResults` where `toolName==='subagent'`, correlates by task index. `AgentResult` is a NEW defined type. Fix: `src/engine/self-prompt.ts` currently assumes `sendUserMessage: ()=>Promise<void>`; rewire it to call `HostAgent.steer()` (which owns the await), since the real `sendUserMessage` returns `void`.
- **Default-FAIL:** ☐ `steer()` resolves on the next `agent_end` with the assistant text (mock) ☐ monotonic seq: a stale `agent_end` (no steer in-flight) is ignored ☐ concurrent `steer()` throws `SteerInFlightError` (mutex) ☐ timeout rejects ☐ `expectFile` validation: missing/invalid file → retry ≤2 → reject ☐ `SubagentDriver.invoke()` emits a well-formed subagent instruction, filters `toolName==='subagent'` results from a mixed `turn_end`, correlates by index ☐ dirty-tree → stash → invoke → pop ☐ `self-prompt.ts` rewired to `steer()` (void-return reconciled).

### S2-M2 — Controller + extension lifecycle (one session + compact + mask)
- **Files:** rewrite `src/extension/index.ts`, `src/host/controller.ts`, `tests/host/controller.test.ts`. Reads `src/safety/masking.ts` (extends its use via the `context` event).
- **Goal:** the event-loop orchestrator. `session_start`→ARMED (read-only). `input` with an idea (or `/autodev <idea>`) → ARMED→RUNNING + run-lock + start P1. `agent_end`→hand to the active phase executor → read phase file → gate → advance. **At each phase boundary: `await compactAsync(ctx)` — a Promise wrapper over `ctx.compact({onComplete,onError})`, since `compact()` is fire-and-forget `void`; the controller MUST await `onComplete` BEFORE the next steer (else the next message lands in a pre-compaction context, defeating the purpose). The phase file is already on disk by then (`agent_end` fires after all the host's tool calls complete); `session_before_compact` is a defensive flush check, not the primary safety.** Register a `context`-event handler that masks all messages except the current `PhaseContext` (extend `ObservationMasker`). `tool_call` hook→H1 contract + action-monitor (existing). Commands `/autodev-status|config|tokens|pause|resume|doctor`. HUD per transition. Mid-steer **timeout + rollback**: if a steer times out, the controller marks the phase suspect, journals, and either retries or surfaces a hard block (no silent stall). Surface tier-D/budget/all-done/hard-block only.
- **Default-FAIL:** ☐ idea `input` → ARMED→RUNNING + run-lock ☐ non-idea input (a question) stays ARMED ☐ each `agent_end` advances one phase step ☐ `compactAsync(ctx)` awaited at each phase boundary — the next steer does not fire until compact's `onComplete` resolves (mock test) ☐ `context`-event handler masks stale phase messages, keeps the current PhaseContext ☐ `session_before_compact` ensures the phase file is written before compaction ☐ mid-steer timeout → phase marked suspect + journaled + retried/escalated (no silent stall) ☐ `/autodev-pause` sets the pause-file checked before each transition; `/autodev-resume` clears it ☐ `/autodev-status` → `{phase,task,laneStatus,model,uptime}` ☐ `/autodev-doctor` health-checks backends ☐ `tool_call` hook denies an H1 contract true-write without evidence ☐ tier-D action surfaces a brief + blocks ☐ HUD reflects the phase.
- **Gap-wiring:** §5b lifecycle, §5 self-prompt (via steer), §14 HUD, H1/H4, §18 commands, G9 masking (now via context event).

### S2-M3a — Phase executors P1–P3 (the planning phases)
- **Files:** `src/phases/{phase-executor,p1-discover,p2-elaborate,p3-plan}.ts`, `src/phases/phase-output.ts` (typed `PhaseOutput`/`PhaseContext` discriminated unions), `tests/phases/p1..p3.test.ts`.
- **Goal:** `PhaseExecutor<I extends PhaseContext, O extends PhaseOutput>`: assemble instruction (role-agent markdown + PhaseContext + the file path to write) → `steer(expectFile)` → read+validate the file → run gate → return typed `PhaseResult<O>`. P1 DISCOVER (web-research+spec+STACK-PICK+ADR+G21 dep-vet). P2 ELABORATE (domain model; persona panel = `SubagentDriver.invoke`). P3 PLAN (scope→slice→plan; 10-persona panel as parallel subagents → objections; **re-plan loop capped at 3** → if still objecting, surface to operator; emits sprint contract + examples table + file-DAG).
- **Default-FAIL:** ☐ each executor's steer prompt contains the role-agent directives + the PhaseContext + the target file path (assert) ☐ reads+schema-validates the phase file; invalid → retry path ☐ P2/P3 panel runs as parallel subagents, aggregates objections ☐ **P3 re-plan caps at 3; persistent objections → operator brief** ☐ P3 emits the sprint contract (later enforced by H1) + examples table ☐ returns the typed `PhaseOutput`.

### S2-M3b — Phase executors P4–P6 (execute / verify / release)
- **Files:** `src/phases/{p4-build,p5-verify,p6-release}.ts`, `tests/phases/p4..p6.test.ts`. Imports the Verifier/GitOps ports (does NOT modify `src/verify` or `src/git`).
- **Goal:** P4 BUILD → hand the file-DAG to S2-M5 (`SubagentDriver` worktree lanes); collect lane results into `p4-build.json`. P5 VERIFY → deterministic verify + holdout + clean-context reviewer (subagent) + review-to-zero (existing logic, real diffs); H9 still-right judge can fire P4→P3 backedge. P6 RELEASE → scoped commit + per-phase push + tier-D gate (existing git ops); writes `p6-release.json`.
- **Default-FAIL:** ☐ P4 dispatches lanes via SubagentDriver + writes `p4-build.json` ☐ P5 runs the verify pipeline on the real build diff + review-to-zero (zero CRIT/HIGH) ☐ H9 backedge P4→P3 on divergent diff ☐ P6 produces a scoped commit + `p6-release.json` ☐ each returns typed `PhaseOutput`.

### S2-M4 — Re-plumb judges/panel/reviewer as subagents (fixes Stage-1 wrong-arch) — owns `src/verify`
- **Files:** add `src/verify/subagent-judge.ts`; modify `src/verify/{reviewer,llm-judge→DELETE,holdout}.ts`, `src/engine/judges.ts`; `tests/verify/*`. **This lane owns ALL of `src/verify` (incl. S2-M7's files) to avoid conflict.**
- **Goal:** replace the Stage-1 injected-function judges (which assumed an impossible direct model call). `SubagentJudge implements Judge` via `SubagentDriver.invoke()`: `isDone()`/`isStillRight()` spawn a cheap subagent. R1 clean-context reviewer = a `reviewer` subagent given ONLY the diff (fresh context). The 10-persona panel = parallel subagents. **Delete `LLMJudge` (callback-injection wrong-arch).**
- **Default-FAIL:** ☐ R1 reviewer subagent task contains ONLY the diff (assert NO spec/builder-trace) ☐ panel runs N personas as parallel subagents + aggregates ☐ done-judge is a separate subagent (not builder self-judge) ☐ `LLMJudge` removed; nothing imports it ☐ existing review-loop/holdout tests pass against `SubagentJudge`.

### S2-M5 — Real pi-subagents build lane (P4) (fixes the stub)
- **Files:** rewrite `src/lanes/subagent-runner.ts`, modify `src/lanes/integrator.ts`; `tests/lanes/*`.
- **Goal:** partitioner lanes → `SubagentDriver.invoke(tasks=lanes,{worktree:true,concurrency:cap})` → integrator reconciles (G18 broker + merge). Clean-tree precondition (the SubagentDriver stash guard from M1).
- **Default-FAIL:** ☐ lanes → well-formed parallel subagent instruction with `worktree:true` ☐ results parsed per lane ☐ integrator reconciles + blocks unbrokered G18 shared-boundary change ☐ clean-tree precondition enforced.

### S2-M6 — Real memory (Letta HTTP + codebase-memory direct exec)
- **Files:** modify `src/memory/{letta-adapter,codebase-memory-adapter,health}.ts`; tests + a manual-verify note.
- **Goal:** Letta via direct HTTP (correct real v1 endpoints — contract test vs a recorded shape). **codebase-memory-mcp via `pi.exec` of the binary** (stdio JSON-RPC: spawn, write the JSON-RPC `find_callers` request to stdin, read stdout) — NOT HTTP, NOT host-mediated. Health-check degrades.
- **Default-FAIL:** ☐ Letta adapter hits the correct endpoints (contract test) ☐ codebase-memory adapter uses `pi.exec`/stdio JSON-RPC; `BackendUnavailableError` if binary absent ☐ health-check degrades ☐ contradiction-detect works on the corrected Letta shape.

### S2-M7 — Verify external CLIs (part of Lane β, after M4)
- **Files:** modify `src/verify/{mutation,dep-vetting,ui-grounding}.ts`, `src/git/gitleaks-hook.ts`; tests. **Sequenced AFTER M4 within Lane β (same `src/verify` files).**
- **Goal:** wire real CLI boundaries via `pi.exec`: StrykerJS, osv-scanner + trivy, Playwright-MCP, gitleaks. Validate output parsing vs recorded samples; missing-binary degrades gracefully.
- **Default-FAIL:** ☐ each CLI invoke+parse validated vs a recorded sample ☐ missing-binary → skip+log (no crash) ☐ exit-code gates correct.

### S2-M8 — End-to-end through the real pi loop (verification-only)
- **Files:** `tests/integration/e2e-pi-loop.test.ts` (REPLACES the deleted `xs-idea-e2e.test.ts`), `scripts/smoke-run.mjs`. Bug-fixes go to the source milestone, M8 re-runs (like Stage-1 M-INT).
- **Default-FAIL:** ☐ mock-host E2E: `input(idea)` → controller drives P1→P6 via steer/agent_end + file-contracts → scoped commit → activity.log full trace → H1 contract all-true ☐ pause/resume mid-run ☐ crash-resurrection resumes from a checkpoint through the real event loop ☐ `scripts/smoke-run.mjs` documents the real-pi manual run ☐ throughput note per tier (XS ~5 turns/2min … XL ~25/50min).

---

## Rework map (Stage-1 code that changes)
| Stage-1 code | Why | Stage-2 fix |
|--------------|-----|-------------|
| `src/extension/index.ts` (arms only) | no RUNNING orchestration | Controller (S2-M2) |
| `src/engine/self-prompt.ts` (assumes async sendUserMessage) | real `sendUserMessage` returns void | rewired to `HostAgent.steer()` (S2-M1) |
| `src/verify/llm-judge.ts` (callback injection) | wrong-arch proxy for a model call | DELETED; `SubagentJudge` (S2-M4) |
| `src/engine/judges.ts`, `src/verify/{reviewer,holdout}.ts` | injected model fn | subagent-backed (S2-M4) |
| `src/lanes/subagent-runner.ts` (TODO stub) | pi-subagents is LLM-mediated | real SubagentDriver (S2-M5) |
| `src/memory/codebase-memory-adapter.ts` (HTTP) | it's an MCP stdio binary | `pi.exec` JSON-RPC (S2-M6) |
| `src/engine/fsm.ts` (empty transitions) | phases did nothing | driven by phase executors; FSM stays the transition core (S2-M3a/b) |
| `tests/integration/xs-idea-e2e.test.ts` (drives FSM directly) | no controller/host in loop | DELETED, replaced (S2-M8) |
Reused unchanged: safety rails, H1 contract gate, journal/checkpoint/resurrection, git ops, transparency, partitioner, complexity scorer, agents/personas/cockpit data, masking (now driven by the context event).

## File-DAG / lane grouping
Foundation **S2-M1** sequential (owns `src/host/*` + `src/engine/self-prompt.ts`), blocks all. Then:
- **Lane α:** S2-M2 → S2-M3a → S2-M3b (controller + phases; `src/host/controller.ts`, `src/extension/index.ts`, `src/phases/*`). Imports Verifier/GitOps/Judge ports; does NOT modify `src/verify` or `src/git`.
- **Lane β:** S2-M4 → S2-M7 (sequential; owns ALL `src/verify/*` + `src/engine/judges.ts`).
- **Lane γ:** S2-M5 (`src/lanes/*`).
- **Lane δ:** S2-M6 (`src/memory/*`).
- **S2-M8** integration last.
No two concurrent lanes write the same file (`src/verify` wholly β; `src/host` wholly M1; `src/engine/judges.ts` β-only; `src/engine/self-prompt.ts` M1-only).

## Pre-mortem (DELIBERATE — 4 scenarios)
1. **Host ignores the steer / returns garbage.** *Mitigation:* file-based contract (controller checks `.autodev/phase-output/*.json` exists+valid, not conversation text) + steer-result validation (M1) + retry ≤2 → escalate.
2. **`compact()` destroys mid-run state → P5 reviews stale context.** *Mitigation:* file-based contracts make conversation state non-critical; `session_before_compact` flushes the phase file first; compact freely.
3. **P3 re-plan never converges (panel always objects).** *Mitigation:* cap at 3 rounds (M3a acceptance) → surface remaining objections to operator (accept-with-objections / abort).
4. **A P4 subagent corrupts its worktree, blocking lanes.** *Mitigation:* worktree isolation (per-lane) + the SubagentDriver clean-tree stash guard; recovery = kill lane, `git worktree remove --force`, re-queue, journal.
Plus: **mid-steer timeout** (M2) prevents the "sent instruction, never got agent_end" silent stall.

## Expanded test plan
- **Unit (~15-20/milestone, mock host):** M1 steer/seq/mutex/timeout/file-validate/subagent-filter/stash; M2 controller transitions/compact-at-boundary/context-mask/commands/timeout-rollback; M3a/b per-phase steer+file-read+gate+panel-cap; M4 subagent-judge diff-only/panel/done-judge; M5 lane dispatch+integrator; M6 adapter contracts; M7 CLI parse.
- **Integration:** compact-at-boundary (M2); file-contract round-trip P3→P4 (M3); lane-integrator reconciliation (M5); health-degrade (M6).
- **E2E:** mock-host full P1→P6 (M8); pause/resume; crash-resurrection through the event loop.
- **Observability:** activity.log per phase; HUD per transition; G6 metrics; steer-queue depth (0/1); subagent spawn count vs expected; phase-output files present per phase.

## ADR
- **Decision:** one-long-session steer-and-observe controller with **file-based phase contracts as the authoritative data channel**; compact()+context-mask for context hygiene; pi-subagents for parallelism + clean-context.
- **Drivers:** no standalone model call; `ctx.newSession()` unavailable in event handlers (verified); context-rot is a silent hazard but files make it irrelevant.
- **Alternatives rejected:** per-phase `newSession()` (impossible — command-context only); parse free-form `agent_end` text (probabilistic — files are deterministic); standalone model calls (no API); registerProvider (routing, not orchestration); Stage-1 injected-function judges (can never call a model).
- **Consequences:** every phase declares its input deps + writes a typed output file; untested context bridges / unvalidated steers are the bug class (mitigated by file-validate + retry). Serial host throughput ~15-25 turns/XL run (~8-50 min) — accepted: correctness > speed (§3 cost-not-a-factor).
- **Follow-ups:** real-service validation (Letta, codebase-memory binary, the CLIs) + the manual smoke with a model + billing lifted; explore `before_agent_start` for per-phase system-prompt injection (efficiency, deferred).

## Throughput (documented tradeoff)
XS ~5 host turns/~2min · S ~8/~5min · M ~12/~10min · L ~18/~25min · XL ~25/~50min (Opus xhigh, orchestration overhead; subagent work additional). Accepted per §3.
