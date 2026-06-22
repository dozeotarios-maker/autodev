# pi-autodev — Stage-1 Implementation Plan (v2, ralplan-hardened)

> **For Claude:** Executed via the operator's hardcoded flow: this plan passed ralplan consensus (Planner →
> Architect → Critic). STAGE 3 = omc-teams (tmux CLI workers), parallel lanes per the file-DAG. Each
> milestone is dispatched only after the Opus dispatch planner pre-decomposes it into ordered
> failing-test → impl → commit cycles (standing rule D5).

**Goal:** Build pi-autodev — a compiled-TypeScript pi extension that drops into any repo, takes one idea, and
autonomously plans/builds/verifies/ships code — as a hardcoded 6-phase FSM with evidence-gated safety rails,
armed-vs-running lifecycle, two-layer local-first memory, parallel file-DAG lanes, and a clean-context review
pipeline.

**Architecture:** Code owns control flow (6-phase FSM + rails in TypeScript); markdown owns content (11 role
agents + 10 personas loaded as data). Dependency-inversion: the engine orchestrates against **10 PORT
interfaces** delivered in M1, so lanes build in parallel against interfaces; the integrator wires concretes
**incrementally** (a small commit as each lane completes — not a big-bang pass). Source of truth:
`docs/pi-autodev-spec.md` (revised 2026-06-22). Research basis: `docs/research/2026-06-22-stage0-research.md`.

**Tech stack:** pi 0.79.9 (`@earendil-works/pi-coding-agent`) · TypeScript · pi-subagents ^0.30.0
(`PI_SUBAGENT_MAX_DEPTH=1`, worktree-per-lane) · pi-mcp-adapter ^2.10.0 · @wirebabel/pi-web-access ·
pi-hud ^0.9.4 · pi-claude-bridge (best model: claude-opus-4-8, 1M ctx) · Layer-A codebase-memory-mcp ·
Layer-B Letta (Apache-2.0, SQLite+local) · embeddings cloud-via-port (default Gemini, swappable) ·
verify: StrykerJS 9.6.1 · gitleaks 8.30.1 · osv-scanner 2.4.0 + trivy · @playwright/mcp · AI-SLOP Detector
3.8.6 · `gray-matter` (frontmatter; itself vetted via G21 at build).

---

## Pre-BUILD gates

1. **PAT revocation (HARD security gate, blocks M5/Lane C).** Two live tokens leaked in planning chat (spec
   §17, mem 1803). Operator MUST confirm both revoked before M5 executes — cannot be self-verified.
   **Timeout/escalation:** if unconfirmed 48h after Lane C is ready, escalate to operator; M5 MAY build
   against a **mock TokenVault** and swap the real one post-confirmation, so Lane C is not blocked indefinitely.
2. **Billing wall (operational, blocks the first LIVE autodev run, NOT this build).** Lift by paying/upgrading
   the pi account or a non-walled key. Building pi-autodev via omc-teams uses Claude workers (separate billing).

## Standing rules

- **D1 Test-first:** anything testable gets a failing test before implementation; non-testable work names why.
- **D2 Web-currency:** before wiring any external dep/API, verify the current best-practice + latest stable
  version. `scripts/verify-pins.sh` (M0) confirms every pin via `npm info` / `gh api` at build time.
- **D3 Best model everywhere** (cost not a factor); **security pillar G24** active; **release-triage** = ship
  on zero-CRIT/HIGH + filed LOW/MED.
- **D4 Incremental wiring:** the integrator wires each lane's concretes to ports in a small commit as that
  lane completes (trunk-based, §15 DORA) — never a big-bang integration commit.
- **D5 Pre-decompose before dispatch:** the Opus dispatch planner decomposes each milestone into ordered
  failing-test → impl → commit cycles before handing a brief to a Sonnet worker (decomposition is Opus work,
  not Sonnet self-planning).
- **D6 Meta-build safety:** this build is itself an autonomous build, so it uses the product's own discipline —
  each BUILD milestone contract is an H1 evidence-gate (criterion starts `false`, flips only on read evidence);
  the post-plan code review explicitly screens the build's OWN code for DAPLab G11 (silent-error suppression)
  and G12 (fake integration / placeholder keys).
- **D7 Rollback:** rollback = `git revert`/reset to the last green commit before the milestone. Letta state is
  append-only (not rolled back). `.autodev/` artifacts from a failed milestone are deleted by the rollback script.

---

## File-DAG + parallel lane grouping (for omc-teams dispatch)

Two milestones are sequential FOUNDATION; the rest fan into lanes that never write the same file.
Cross-lane dependencies are READ-only port imports, sequenced by completion — **including the M9→M5
dependency made explicit below.**

```
FOUNDATION (sequential):
  M0 Scaffold ─▶ M1 Safety + Lifecycle + 10 PORT INTERFACES (src/ports.ts)
        │
        ▼  (after M1, fan out — cap 5 lanes, no shared files)
  Lane A  M2 memory (src/memory/*) ─▶ M8 agents/skills/cockpit (data files: agents/*, skills/*, cockpit/*)
  Lane B  M3 engine (src/engine/{fsm,complexity,self-prompt,judges,ambiguity,estimate}.ts)
          ─▶ M4 lanes (src/lanes/*; ContractRegistry port promoted here)
          ─▶ M9 resurrection (src/engine/{resurrection,journal,checkpoint,retro}.ts)  ◀┄┄┄┐
  Lane C  M5 git (src/git/*)                              [GATED on PAT revocation] ┄┄┄┄┘
          (M9 cross-lane gate: starts only after M4 AND M5 — needs M5's G20 ledger)
  Lane D  M7 transparency (src/transparency/*)
  Lane E  M6a▶M6b▶M6c verify (src/verify/*)
        │
        ▼  (after ALL lanes)
  M-INT  Integration VERIFICATION only (tests/integration/*) — no new wiring
```

**Explicit cross-lane gates:** M9 starts only after **M4 AND M5** complete (M9's no-double-fire criterion
needs M5's G20 effect-ledger). **Effective parallelism ≈ 2×, not 5×** — Lane B (M3→M4→M9) is the critical
path and its tail is gated on Lane C. This is stated honestly; the 5 lanes still parallelize A/C/D/E against
B's long tail. Optional throughput win (non-blocking): M4's pure-graph `partitioner.ts` depends only on
ports and may start in a stub lane after M1, with `integrator.ts`/`subagent-runner.ts` joining after M3.

omc-teams dispatch: `omc team 5:claude:executor` (Sonnet workers) after M0+M1; one lane per worker;
lane-scoped briefs with explicit file allowlists; M5 (Lane C) held until PAT revocation confirmed.

---

## Milestones

Each milestone ships behind a **default-FAIL contract (H1)**: every criterion starts `false` in
`.autodev/contract.<milestone>.json` and flips `true` only after the named evidence artifact is produced and
read. A pi `tool_call` hook denies writing `true` without the evidence. **This same H1 gate governs the build
itself (D6).**

### M0 — Scaffold + extension entry (FOUNDATION)
- **Files:** `package.json`, `tsconfig.json`, `install.mjs`, `src/extension/index.ts` (skeleton),
  `scripts/verify-pins.sh`, `tests/extension/load.test.ts`.
- **Default-FAIL:** ☐ compiles clean ☐ install.mjs copies + registers in settings ☐ loads in a real pi
  session ☐ logs ARMED on session_start ☐ **ZERO file writes on load** (evidence: git status clean in a
  throwaway repo) ☐ `verify-pins.sh` exits 0, all pins confirmed current (D2).

### M1 — Safety rails + lifecycle + 10 PORT INTERFACES (FOUNDATION)
- **Files:** `src/ports.ts`, `src/engine/lifecycle.ts` (armed/running + per-repo run-lock),
  `src/safety/{runaway,loop-detect,action-monitor,guardrails,masking}.ts`, `src/safety/contract.ts` (H1),
  `src/safety/steer.ts` (H4), `tests/safety/*`.
- **Ports (10):** MemoryStore · Embedder · Lane · Verifier · GitOps · Transparency · Judge (the 7 proven
  boundaries) + **TokenVault · SecurityLane · Resurrection** (safety-critical — their shape must be locked
  before any lane can bypass them). NOT in M1: ContractRegistry (promoted by M4 once its shape is known),
  SelfPrompt/ComplexityScorer/HUD (a one-line API call, a pure function, and a single concrete — local types,
  not ports).
- **Default-FAIL:** ☐ ARMED on session_start = health-check + read-only crash-resurrect + idle, zero mutation
  ☐ RUNNING only on explicit idea input ☐ per-repo run-lock blocks a 2nd RUNNING session ☐ H1 hook DENIES
  writing `true` without a matching evidence read (test: no-evidence → denied; evidence → allowed) ☐
  action-monitor (G2) blocks recursive-delete + out-of-bounds-write + egress (G22/G24) ☐ G10 guardrails screen
  repo/web content; G24 untrusted-content flagged ☐ AGENT_STOP kill-file halts all tool calls ☐ masking (G9)
  drops to last-N ☐ **every M2–M9 `import {X} from '../ports'` compiles against a no-op stub (zero type errors).**
- **Gap-wiring:** §5b · H1 · H4 · G2 · G9 · G10 · G22/G24 · ports.

### M2 — Memory layer (Lane A)
- **Files:** `src/memory/{store-port,letta-adapter,codebase-memory-adapter,embedder-port,gemini-embedder,
  ollama-embedder,health}.ts`, `tests/memory/*`.
- **Default-FAIL:** ☐ MemoryStore store→recall round-trip (Letta) ☐ Layer-A `find_callers` returns cross-file
  callers (real-or-mocked boundary, G12) ☐ Embedder returns vectors via Gemini ☐ local qwen3 fallback works
  offline ☐ health-check degrades gracefully if Letta/Ollama/MCP down (down-path test, no crash) ☐
  contradiction-detect: store "service X uses REST", then "service X uses gRPC" → returns both with conflict flag.
- **Gap-wiring:** §4 · G12 · G13.

### M3 — Engine: 6-phase FSM + judges (Lane B)
- **Files:** `src/engine/{fsm,complexity,self-prompt,judges,ambiguity,estimate}.ts`, `tests/engine/*`.
- **Goal:** FSM (P1–P6 in code), complexity scorer (pure fn, tier XS–XL), self-prompt loop, H2 done-judge,
  H9 still-right judge (re-anchor + backedge P4→P3), H7 ambiguity gate, H8 scope-preview, **H6 sprint
  contract** (P3 emits a per-feature done-definition the H1 gate enforces). FSM exposes **`onResume(checkpoint)`
  + phase-reconstruction extension points** so M9 hooks resurrection WITHOUT modifying M3 files.
- **Default-FAIL:** ☐ FSM transitions P1→…→P6 deterministic + journaled ☐ complexity scorer matches 3 concrete
  fixtures (e.g. {files:1,novelty:low,blast:1,irrev:low}→XS; {files:~6,novelty:med,blast:3,irrev:med}→L;
  {files:big,novelty:high,blast:5,irrev:high}→XL) ☐ self-prompt: assert `sendUserMessage(deliverAs:'followUp')`
  called with the next instruction after turn_end ☐ H2 done-judge gates completion (cheap model, not self-judge)
  ☐ H9 backedge fires when the diff diverges from the approved plan (inject divergent diff → backedge) ☐ H7
  asks exactly one question on an ambiguous idea, zero on a clear one ☐ H6: a feature without a sprint contract
  → H1 gate rejects its completion claim ☐ FSM exposes onResume/phase-reconstruction (compile + unit test).
  *(Note: "stubs ok" = M3 tests run against stub ports; real concretes verified at integration, not shipped stubbed.)*
- **Gap-wiring:** §5 · §6 · H2 · H6 · H7 · H8 · H9 · self-prompt.

### M4 — Lanes: partitioner + integrator + G18 (Lane B, after M3)
- **Files:** `src/lanes/{partitioner,integrator,contract-registry,subagent-runner}.ts`; promotes
  `ContractRegistry` to `src/ports.ts` (incremental). `tests/lanes/*`.
- **Default-FAIL:** ☐ partitioner yields non-conflicting lanes from a file-touch set ☐ cap enforced at 5 ☐
  integrator reconciles two lanes' outputs ☐ **G18: a lane mutating a shared boundary without publishing to the
  registry is BLOCKED at merge** (unbrokered shared-type change → denied; brokered → allowed) ☐ subagent-runner
  spawns depth=1 worktree-isolated workers.
- **Gap-wiring:** §9 · G7 · G18 · R4 (single integrator = "manage").

### M5 — Git: scoped commit + tier-D + token isolation + G20 (Lane C) — GATED on PAT revocation
- **Files:** `src/git/{scoped-commit,per-phase-push,tier-d-gate,token-vault,effect-ledger,gitleaks-hook}.ts`,
  `tests/git/*`.
- **Default-FAIL:** ☐ scoped commit stages only allowlisted paths ☐ tier-D gate surfaces an H10 brief
  (change/why/risk/rollback) and BLOCKS until async approve ☐ **token never appears in model context or
  sub-agent scope** (G24 — scan context + worker env, assert absent) ☐ gitleaks blocks a staged secret (exit 1)
  ☐ G20 ledger prevents a replayed migration/push from double-firing (simulate crash-after-effect, replay → no
  double-fire) ☐ per-phase push only when HEAD on the target branch.
- **Gap-wiring:** §16 · tier-D · H10 · G20 · G22/G24 · §17. **Blocked until both leaked PATs confirmed revoked
  (or mock TokenVault per the 48h escalation).**

### M6 — Verify pipeline (Lane E) — split into 3 sub-milestones
*(M6 was a "god milestone" — 11 files / 14 spec items. Split so each sub-milestone is a Sonnet-sized brief.)*

**M6a — core verify:** `src/verify/{deterministic,holdout,mutation,reviewer,llm-judge}.ts`.
- ☐ deterministic verify reads exit codes, never an LLM trace ☐ holdout + clean-context LLM judge (primary,
  EvilGenie) + test-tree edit-detection catch a planted reward-hack ☐ mutation gate fails below threshold
  (**StrykerJS score < 80%**, configurable in `cockpit/autodev.yaml`) ☐ R1 reviewer sees diff only — assert no
  spec/trace in its context.

**M6b — augmented verify:** `src/verify/{humanizer,review-loop,blast-radius,concurrency,dep-vetting}.ts`.
- ☐ humanizer slop (AI-SLOP Detector + LLM critic for prose) folds into review ☐ review-loop drives CRIT/HIGH
  to zero (cap 5), files LOW/MED (release-triage) ☐ G19 blast-radius: `find_callers` enumerates callers before
  a breaking change ☐ G23 concurrency lens flags a planted race ☐ **G21 dep-vetting: adding a dep with an
  incompatible license or known CVE is blocked** (osv-scanner + trivy + license check) ☐ G14 reinvent-vs-reuse:
  a hand-rolled algo a library provides is flagged ☐ G15 business-rule: holdout tests derived from the plan's
  examples table.

**M6c — external-tool verify:** `src/verify/{ui-grounding,security-lane}.ts`.
- ☐ G16 opens the running app in a real browser (@playwright/mcp) + screenshots (evidence artifact) ☐ G24
  clean-context security-lane flags a planted prompt-injection in repo content.
- **Gap-wiring (M6a/b/c):** §11 · G1/G8 · G11–G16 · G19 · G21 · G23 · G24 · R1/R2 · release-triage.

### M7 — Transparency (Lane D)
- **Files:** `src/transparency/{activity-log,hud,append-entry,metrics}.ts`, `tests/transparency/*`.
- **Default-FAIL:** ☐ activity.log gets a human line per action ☐ pi-hud renders phase/task/lane/model/cost/
  last-decision ☐ appendEntry entries are resumable + excluded from LLM context ☐ **G6 metrics
  (cost-attribution per role/task, solve-rate, time-to-merge, CFR) written to `.autodev/metrics.jsonl` matching
  schema {role, task, metric_name, value, timestamp}** (after a mock run, all 4 metric types present).
- **Gap-wiring:** §14 (pi-hud) · G6 · silent-execution.

### M8 — Agents + skills + cockpit (Lane A, after M2 — data files)
- **Files:** `agents/*.md` (11 role + 10 persona), `skills/*/SKILL.md`, `cockpit/{autodev.yaml,models.yaml}`,
  `tests/agents/*`.
- **Default-FAIL:** ☐ all 21 agent/persona files load + parse via `gray-matter` ☐ cockpit yaml parses +
  validates (models, tiers, caps, runaway-backstop, mutation-threshold) ☐ each /autodev-* command registers +
  has defined behavior (e.g. /autodev-status → JSON {phase,task,lane_status,model,uptime}; /autodev-pause →
  sets a pause-file the FSM checks before each transition) ☐ /autodev-doctor health-checks **Letta** +
  codebase-memory-mcp + embedder.
- **Gap-wiring:** §7 personas (Data/Persistence, G23 concurrency, G24 security-lane) · §8 roles · §18 + H5.

### M9 — Crash resurrection + R5 retro (Lane B, after M4 AND M5)
- **Files:** `src/engine/{resurrection,journal,checkpoint,retro}.ts`, `tests/engine/resurrection.test.ts`.
- **Default-FAIL:** ☐ journal written before action, checkpoint after ☐ crash mid-action marks the step
  suspect, no completion ☐ resume replays nothing destructive (**M5's G20 ledger respected**) ☐ R5 retro writes
  a generalizable lesson to `~/.pi/autodev/global/` ☐ **ZERO modifications to M3-delivered files** (verified by
  diff) — M9 hooks via M3's onResume/phase-reconstruction + the Resurrection port.
- **Gap-wiring:** §10 · G20 (depends on M5) · R5.

### M-INT — Integration VERIFICATION (after all lanes)
- **Files:** `tests/integration/*` only. No new wiring (the integrator wired concretes incrementally per D4).
- **Default-FAIL (5 cross-lane tests):** ☐ **G24 credential-isolation chain** — injection in repo content →
  exfil attempt → G22 egress block → security-lane flag ☐ **crash-resurrection round-trip** — kill mid-P4 →
  restart → journal reconstructs → resume → G20 no double-fire ☐ **FSM full-cycle P1→P6** with real memory +
  verify ☐ **XS-idea E2E** — drop a 1-file idea in a throwaway repo → P1–P6 → scoped commit lands → activity.log
  full trace → contract all-true ☐ H1 evidence-gate end-to-end (all-false → produce evidence → flip → verify).

---

## Gap / primitive → milestone map

| Item | Milestone |
|------|-----------|
| §5b, H1, H4, G2, G9, G10, G22, ports | M1 |
| §4 memory, G12, G13 | M2 |
| §5 FSM, §6, H2, H6, H7, H8, H9, self-prompt | M3 |
| §9 lanes, G7, G18, R4 | M4 |
| §16 git, tier-D, H10, G20, G24 credential isolation, §17 | M5 |
| §11 verify, G1/G8, G11–G16, G19, G21, G23, G24 security-lane, R1/R2, release-triage | M6a/b/c |
| §14, G6 | M7 |
| §7 personas, §8 roles, §18 + H5, cockpit | M8 |
| §10 resurrection, R5 | M9 |
| cross-lane: G24 chain, G20 round-trip, full FSM, E2E | M-INT |

## Absorbed / deferred items

| Item | Disposition | Covered by |
|------|-------------|-----------|
| G3 context-fragmentation | Absorbed | G9 observation masking (M1) |
| G4 success-faking | Absorbed | H1 evidence-gate (M1) |
| G5 verification-gamed | Absorbed | G8 deterministic + holdout + LLM judge (M6a) |
| R3 smart-friend escalation | Deferred | no cost constraint — best model everywhere |
| R4 map-reduce-manage | Absorbed | M4 single integrator ("manage") |
| H3 | N/A | numbering gap in spec (does not exist) |
| G17 state-reconciliation | Deferred | spec defers; frontend-tier only |

---

## Pre-mortem (DELIBERATE mode — 3 scenarios)

1. **pi-subagents worktree corruption on submodules/shared `.git`.** Git worktrees share the `.git` dir; a
   lane's tests touching `.git/config` or a submodule can corrupt sibling worktrees. *Mitigation:* M4
   subagent-runner uses isolated worktrees with a guard that refuses to run if submodules are present without
   `--recurse` isolation; CI smoke-gate per lane catches cross-worktree corruption early.
2. **Letta SQLite write contention under 5 parallel lanes.** M3 journaling, M5 G20 ledger, and M9 resurrection
   all write Letta/SQLite concurrently; default WAL serializes writes → SQLITE_BUSY. *Mitigation:* a build-time
   spike (start Letta, 5 concurrent writers, measure) before M2 sign-off; set WAL + busy_timeout; route
   crash-resurrection WAL to OUR own files (spec §10), not Letta, so memory contention never blocks recovery.
3. **PAT-revocation gate blocks Lane C indefinitely.** *Mitigation:* the 48h timeout + mock-TokenVault path
   (Pre-BUILD gate 1) — M5 builds against a mock vault and swaps the real token post-confirmation, so Lane C
   never stalls the schedule.

## Expanded test plan (DELIBERATE mode)

- **Unit** — per-milestone default-FAIL criteria above (vitest/jest; StrykerJS mutation gate; Playwright for M6c).
- **Integration (4 cross-lane, owned by the integrator):** memory+engine (FSM drives memory stub); engine+lanes
  (partitioner → real subagent-runner, 2 lanes, zero merge conflict); git+resurrection (G20 + crash round-trip);
  verify+transparency (review-loop emits G6 metrics).
- **E2E** — XS-idea full P1→P6 on a synthetic repo (M-INT); tier-D gate blocks push without approval; ARMED-mode
  zero-mutation on a repo with a stale checkpoint; runaway backstop halts an infinite self-prompt.
- **Observability** — phase-transition latency vs G6 metrics; self-prompt loop count vs max-iterations;
  /autodev-doctor backend health; token-exposure scan (gitleaks + G24); lane-conflict check (no file in >1 lane's
  write-set); review-loop rounds vs cap.

---

## ADR

- **Decision:** Build pi-autodev Stage-1 as a 10-milestone, foundation-then-5-lane parallel build with
  dependency-inverted ports (10 in M1), incremental integration, and a split verify pipeline.
- **Drivers:** lane file-isolation correctness · port completeness for safety-critical boundaries · security
  critical-path ordering (PAT gate, G24).
- **Alternatives considered:** (a) 14 ports in M1 — rejected: 4 were premature abstractions causing downstream
  churn (TS interfaces are additive, so incremental promotion is cheaper). (b) Big-bang M-INT wiring — rejected:
  violates DORA/trunk-based and is CooperBench's "merge at end" anti-pattern. (c) Fewer lanes — rejected: wastes
  omc-teams capacity without solving any conflict.
- **Why chosen:** maximizes safe parallelism while locking safety-critical interfaces first; honest about the
  ~2× (not 5×) effective speedup driven by Lane B's critical path.
- **Consequences:** M1 is the load-bearing foundation; an M1 port error forces lane rework (mitigated: additive
  interfaces + stub-compile gate). Lane B tail gated on Lane C (PAT) — mitigated by mock-vault path.
- **Follow-ups:** build-time spike on Letta contention; verify codebase-memory-mcp license/version/stars,
  @wirebabel/pi-web-access name, Gemini free-tier limits; spec hygiene patches (below).

## Execution notes (STAGE 3)

- `omc team 5:claude:executor` (Sonnet) after M0+M1; one lane per worker; lane-scoped briefs + file allowlists;
  Opus dispatch planner pre-decomposes each milestone into test-impl-commit cycles (D5).
- Smoke-gate per commit; per-lane rollback per D7; per-phase `git push` after each lane's canary; incremental
  port-wiring commit as each lane completes (D4).
- M5 (Lane C) held until PAT revocation confirmed (or mock-vault per 48h escalation).
- After all lanes + M-INT: post-plan deep code review (CLAUDE.md `post_plan_review`) on the committed range —
  for THIS build, all-severities (OMC dev rule), and explicitly screen for DAPLab G11/G12 in the build's own
  code (D6).
- **Spec hygiene (patch before build):** spec §19 still lists `src/deepseek/` (removed §13); §18 /autodev-doctor
  still says "Cortex" (now Letta). Both flagged for a spec patch.
- **Build-time verification:** codebase-memory-mcp license/version/stars (research conflict MIT/10.4k vs
  Apache/900); @wirebabel/pi-web-access scoped name; Gemini embedding free-tier limits; pin all after
  `npm info`/`gh api`.
