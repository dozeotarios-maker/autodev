# pi-autodev — Stage-2.5 Implementation Plan (wire the 3 disconnected pillars)

> **For Claude:** Executed via the operator flow: ralplan (short) → executor-subagent build → post-plan review. TDD per task. Builds on Stage-2 (23 commits, 524 tests green, `~/pi-autodev` on `main`).

**Goal:** Connect 3 built-but-unwired spec pillars so the engine runs at full fidelity: §6 complexity-tier SIZING, §3/§6 thinking-level routing, and R5 post-run retro.

**Architecture:** All three are wiring of existing components into the controller's run lifecycle. The ComplexityScorer (`src/engine/complexity.ts`), RetroWriter (`src/engine/retro.ts`), and the panel/partitioner/review-loop already exist; they just aren't called/parameterized. The controller computes a `Sizing` once per run (from the tier) and threads it through `PhaseContext`; the phases read it to scale panel count / lane cap / review rounds; the controller sets the host thinking level and calls the retro at run end.

**Tech stack:** Stage-2 codebase. pi API: `pi.setThinkingLevel(level)` (verified in §2 / types.d.ts). No new deps.

## Audit basis (why these 3)
`grep` of src/host + src/phases confirmed: no tier consumption (ComplexityScorer output never sizes anything), no `setThinkingLevel`/`setModel`, no `RetroWriter` call. The components are tested in isolation but disconnected. (Note: per-ROLE model routing already works — role agents carry `model:` in frontmatter and run as subagents; only the HOST thinking-level-by-tier is unwired.)

## The §6 sizing table (source of truth)
| Tier | panelPersonas | laneCap | reviewRounds | thinkingLevel |
|------|---------------|---------|--------------|---------------|
| XS | 0 | 1 | 1 | low |
| S  | 2 | 2 | 1 | medium |
| M  | 4 | 3 | 2 | high |
| L  | 6 | 5 | 3 | high |
| XL | 8 | 5 | 5 | xhigh |

---

## Task 1 — `tierSizing()` table in the scorer
**Files:** Modify `src/engine/complexity.ts`; Test `tests/engine/complexity.test.ts`.
- Add `export interface Sizing { panelPersonas: number; laneCap: number; reviewRounds: number; thinkingLevel: 'low'|'medium'|'high'|'xhigh' }` and `export function tierSizing(tier: Tier): Sizing` returning the table above.
- **Test-first:** assert each of XS/S/M/L/XL maps to the exact Sizing row.

## Task 2 — Controller computes tier + Sizing once per run, sets thinking level
**Files:** Modify `src/host/controller.ts` (+ `src/phases/phase-output.ts` to add `sizing: Sizing` to `PhaseContext`); Test `tests/host/controller.test.ts`.
- On ARMED→RUNNING (after capturing the idea, before P1): `const tier = scoreComplexity(ideaSignals); const sizing = tierSizing(tier)`. Store on the run state; include in every `PhaseContext`.
- Call `this.pi.setThinkingLevel(sizing.thinkingLevel)` at run start (host thinking scales by tier).
- **Test-first (mock pi):** an XL idea → `setThinkingLevel('xhigh')` called; `PhaseContext.sizing` carries the XL row. An XS idea → `setThinkingLevel('low')`.
- *Note:* `scoreComplexity` needs idea signals (files/novelty/blast/irreversibility). For the initial estimate use a lightweight heuristic from the idea text (length/keywords) OR a default M tier with a documented TODO to refine from P1's spec; P1 can re-score and update sizing for later phases. Keep it simple: estimate at start, allow P1 to refine.

## Task 3 — Phases consume `sizing`
**Files:** Modify `src/phases/{p2-elaborate,p3-plan,p5-verify}.ts`; Tests `tests/phases/*`.
- P2/P3 panel: spawn `ctx.sizing.panelPersonas` persona subagents (was a fixed count). If `panelPersonas === 0` (XS), skip the panel entirely.
- P3/P4 lane partitioner: pass `ctx.sizing.laneCap` as the partitioner cap (was hardcoded 5).
- P5 review-to-zero: use `ctx.sizing.reviewRounds` as the loop cap (was a fixed cap).
- **Test-first:** XS context → panel skipped (0 personas), laneCap 1, reviewRounds 1. XL context → 8 personas, laneCap 5, reviewRounds 5.

## Task 4 — Controller calls R5 retro at run end
**Files:** Modify `src/host/controller.ts`; Test `tests/host/controller.test.ts`.
- On run completion (after P6 success) AND on halt/hard-block, call `RetroWriter.write({ idea, tier, outcome, phaseOutcomes, findings })` to append a lesson to the global plane (`~/.pi/autodev/global/`).
- **Test-first (mock RetroWriter / fs):** a completed run → retro called once with the run summary (idea, tier, outcome). A halted run → retro called with outcome='halted'.

---

## Acceptance (default-FAIL)
☐ `tierSizing(tier)` returns the exact §6 row for all 5 tiers ☐ controller computes tier+Sizing once per run, stores in PhaseContext ☐ `pi.setThinkingLevel` called with the tier's level (xhigh for XL, low for XS) ☐ P2/P3 panel size = `sizing.panelPersonas` (0 → skipped) ☐ partitioner cap = `sizing.laneCap` ☐ P5 review cap = `sizing.reviewRounds` ☐ retro called at run completion AND on halt with the run summary ☐ `npx tsc --noEmit` clean + `npx vitest run` all green.

## Pre-mortem (short)
1. **scoreComplexity needs signals not available pre-P1** (file count etc. unknown before DISCOVER). *Mitigation:* estimate from the idea text at start (heuristic), let P1 re-score from the real spec and update `sizing` for P2–P6; document the two-stage estimate.
2. **panelPersonas=0 (XS) must SKIP the panel cleanly**, not spawn 0 subagents and hang. *Mitigation:* explicit `if (sizing.panelPersonas === 0) skip` branch + a test.

## Lane grouping (build)
Small + sequential-ish: Task1 (complexity.ts) → Task2 (controller + phase-output) → Task3 (phases) → Task4 (controller retro). Task1 blocks Task2/3; Task2 (PhaseContext.sizing) blocks Task3. Single executor agent does Task1→2→4 (controller+scorer), a second does Task3 (phases) after Task2 lands — OR one agent does all 4 sequentially (small enough). Recommend: 1 agent, sequential, since they're tightly coupled (the Sizing type threads through all).

## Consensus amendments (ralplan APPROVED — BUILD per these, they override the draft above)
1. **NO FLOOR on re-sizing.** Initial: default tier **M** at run-start (no scoring data pre-P1) → `tierSizing('M')` → `setThinkingLevel('high')`. After P1 completes (between the P1 result and P2-context construction), the controller calls `_rescoreFromSpec(p1Output.spec)` → extracts `ComplexityInput` from the spec text (heuristic: word-count→files proxy, keyword scan for novelty/blast/irreversibility) → `scoreComplexity` → `tierSizing`. This is the **authoritative** tier for P2–P6 and **MAY go DOWN to XS/S** (the scorer's own thresholds — XS needs files≤~4 AND blast≤1 AND low novelty/irrev — structurally prevent under-scoring a genuinely complex task, so a floor is redundant and would make XS/S unreachable). If the tier changes, call `setThinkingLevel` again.
2. **REQUIRED: journal-log every tier transition** (e.g. `"tier: M → XS (post-P1 rescore)"`) for observability of the heuristic.
3. **`sizing` is OPTIONAL** (`sizing?: Sizing`) on each `P*Context` variant (PhaseContext is a discriminated union — additive, keeps the existing tests green). Consumers use `ctx.sizing ?? DEFAULT_SIZING`. Export `DEFAULT_SIZING = tierSizing('M')`. Add `// TODO: make sizing required once test fixtures updated`.
4. **REQUIRED: P2 (and P3) skip the panel when `panelPersonas === 0` (XS) AND relax the empty-debate gate** — change `personaDebate.length === 0 → fail` to `if ((sizing?.panelPersonas ?? 5) > 0 && personaDebate.length === 0) → fail`. Without this, XS runs hard-fail at P2.
5. P3 panel size = `Math.min((sizing?.panelPersonas ?? 5) * 2, 10)`.
6. Partitioner: add a `maxLanes` param to `partitionFiles()` (currently hardcoded `MAX_LANES=5`); P4 passes `sizing.laneCap`.
7. ReviewLoop: add a `maxRounds` constructor/run param (currently `MAX_ROUNDS=5` module const); P5 passes `sizing.reviewRounds`.
8. **RetroEntry adaptation** — the existing interface is `{runId, lesson, bugPattern, convention}` (NOT the draft's shape). Success path (after P6, BEFORE `lifecycle.release()`): `{runId, lesson: idea+outcome, bugPattern:'none', convention: tier}`. Halt path (in `_escalate`, BEFORE `lifecycle.release()`): `{runId, lesson: reason, bugPattern: phase, convention:'halted'}`. Inject `RetroWriter` via `ControllerOptions` (optional, for test isolation).
9. `Sizing.thinkingLevel` type = `'low'|'medium'|'high'|'xhigh'` (subset of SDK `ThinkingLevel` — compiles without cast).

Added acceptance: ☐ post-P1 `_rescoreFromSpec` updates tier+sizing for P2–P6, logged ☐ XS panel-skip path passes the P2 gate ☐ existing suite stays green (sizing optional + fallback).

## Rework note
`PhaseContext` gains an OPTIONAL `sizing?: Sizing` field (additive). The phases' fixed panel/lane/review constants become `ctx.sizing?.* ?? default`. `partitionFiles` + `ReviewLoop` gain cap params. No port-interface changes.
