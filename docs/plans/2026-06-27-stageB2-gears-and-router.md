# Stage B2 — Gears as Phase-Paths + Task-Type Router

> **For Claude:** Build via executor (TDD), then post-build review-to-zero. No ralplan (design nailed below; the safety bar is "full-gear path untouched → 851 tests stay green by construction"). Second of three Stage-B increments — see `2026-06-27-gears-and-tracks.md`.

**Goal:** Make autodev run a *lighter phase-path* for lighter work. B1 made sizing accurate (trivial → XS → panels skip). B2 adds skipping whole PHASES: the **quick** gear goes idea→build→test→commit with no discovery/planning ceremony; the **middle** gear runs discovery+plan but skips the elaborate/persona phase; **full** is today's P1→P6, unchanged. Plus a **task-type router** (build/debug/refactor) that sends build work to the gears and stubs debug/refactor until their tracks land.

**Architecture (SAFE + ADDITIVE — the core constraint):** Do NOT refactor the battle-tested `_runPhases` monolith into a generic loop (it has woven-in compaction, pause-checks, the H9 P5→P3 backedge, retro, terminal/release). Instead:
- `_runPhases` (full gear) stays **byte-for-byte unchanged** → every existing test that exercises the implicit full path stays green with zero edits.
- Add NEW isolated methods `_runPhasesQuick` and `_runPhasesMiddle` that reuse the existing P4/P5/P6 phase classes (and P1/P3 for middle) but assemble a shorter sequence.
- A small dispatcher at run-start picks the path from the **gear** (forced by a `quick:`/`mid:`/`full:` prefix, else derived from tier).
Shared phase-execution boilerplate (instantiate → execute → gate → compact) may be extracted into small private helpers to limit duplication, but ONLY if the extraction leaves the full path's observable behavior identical (run the full suite after the extraction; if any full-path test changes, revert the extraction and accept duplication).

**Tech Stack:** existing. No new deps.

---

## Background facts (verified by exploration + B1)

- `_runPhases` (controller.ts ~640–863): hardcoded P1→P6. Run-start sets `currentSizing=tierSizing('M')` then (B1) applies `currentForcedTier` if set; post-P1 rescore (guarded by `!currentForcedTier`).
- B1 added: `parseOverrides` → `{idea, forcedTier?, taskType}`; fields `currentForcedTier`, `currentTaskType` (write-only, "B2-consumed"). `tierFromOverride` (quick→XS, mid→M, full→XL). `P1Output.complexity`.
- Phase classes: `P1Discover`, `P2Elaborate`, `P3Plan`, `P4Build`, `P5Verify`, `P6Release` — each `new …(hostAgent, outputDir, steerTimeoutMs)` then `.execute(ctx)`. Contexts in `phase-output.ts`. P4 needs a `P3Output` (fileDAG + sprintContract); P5 needs P3Output+P4Output; P6 needs P5Output.
- FSM (`engine/fsm.ts`): `PHASE_ORDER=['P1'..'P6']`, `advance()`, `backedge('P3')`. The new gear methods will drive the FSM minimally (or bypass it with their own phase tracking) — keep the full path's FSM use unchanged.
- Pause checks `_isPaused`/`_waitResume`, `compactAsync(ctx, COMPACT_TIMEOUT_MS, …)`, `_escalate`, retro/`memoryStore.store`, `lifecycle.release()`, `_restoreCwd` — the new methods must replicate the lifecycle bookends (escalate-on-failure, retro+release on success) so they don't leak the run-lock.

---

## Design decisions (locked)

### Gear ↔ tier
`Gear = 'quick' | 'middle' | 'full'`. `gearFromTier`: XS→quick, S→middle, M→middle, L→full, XL→full. Forced prefix maps via existing `tierFromOverride` then `gearFromTier` (quick:→XS→quick, mid:→M→middle, full:→XL→full). A `currentGear` field is set at run-start.

### When the gear is known
- **Explicit prefix** (`quick:`/`mid:`/`full:`): gear known at run-start → full path control, including quick skipping P1/P2/P3.
- **No prefix**: discovery must run to size the work, so the **auto path always runs the full `_runPhases`** (which already self-minimizes via B1 sizing: XS → panels skip, reviewRounds 1). Auto-downshift-to-quick-mid mid-run is explicitly OUT OF SCOPE for B2 (it would require unwinding P1 — not worth it; B1 sizing already makes the auto full path cheap for small work). So: **gear methods fire ONLY on an explicit prefix.** Document this clearly.

### quick gear — `_runPhasesQuick`
The quick path has no P1 discovery / P2 personas / P3 planning panel. It needs a minimal build target. One **seed steer** turns the idea into a minimal plan, then reuses P4/P5/P6:
1. **Seed**: steer the host once — "Produce a MINIMAL build plan for this small task: a one-paragraph spec, the file(s) to create/modify, and 1–2 acceptance examples. No web research, no alternatives, no personas." Parse into a minimal `P1Output` (`{phase:'P1', spec, stackAdr:'(quick gear — no ADR)', webResearch:[]}`) and a minimal `P3Output` (sprintContract with the goal + ≥1 success criterion, a single-lane `fileDAG`, ≥1 `examplesTable` entry). Reuse the existing P1Output/P3Output validators; if the seed output fails them, `_escalate('SEED', …)`.
2. **P4 build** with XS sizing (laneCap 1) using the seeded P3Output.
3. **P5 verify** with XS sizing (reviewRounds 1). Quick gear runs the deterministic test pass; the clean-context review-to-zero still applies (a quick build must still pass tests + have no CRITICAL/HIGH) — quick skips *ceremony*, not *correctness*.
4. **P6 release** (commit + push gate as today).
Bookends: pause-check at entry, `compactAsync` between steps (will no-op for a small session via B1's shouldCompact), escalate-on-failure, retro + `lifecycle.release()` + `_restoreCwd` on success — mirror the full path's terminal handling.

### middle gear — `_runPhasesMiddle`
P1 (discovery, with B1 sizing) → **skip P2** → P3 (plan; sizing gives a small panel) → P4 → P5 → P6. Reuse all existing phase classes unchanged; just omit the P2 call and pass P3 a P2Output-less context. NOTE: P3Context currently requires `p2: P2Output`. For middle, synthesize a minimal empty `P2Output` (`{phase:'P2', domainModel:'(middle gear — P2 skipped)', personaDebate:[]}`) so P3's type contract holds without a real P2 run. Keep the post-P1 rescore (middle is not a forced-tier-skip case unless `mid:` was used; if `mid:` forced M, skip rescore per B1).

### task-type router
At run-start, branch on `currentTaskType` (B1):
- `build` (default) → gear dispatch (quick/middle method on explicit prefix, else full `_runPhases`).
- `debug` → `_escalate('ROUTER', 'debug track not yet implemented — coming in Stage C (D1–D5). Re-run without debug: to use the build pipeline.')` — clean stub, no half-run.
- `refactor` → `_escalate('ROUTER', 'refactor track not yet implemented. Re-run without refactor: to use the build pipeline.')`.

---

## Tasks (TDD)

### Task 1: `Gear` type + `gearFromTier` + `selectGear`
- Files: `src/engine/complexity.ts` (or new `src/engine/gears.ts`); test `tests/engine/*`.
- `export type Gear='quick'|'middle'|'full'`; `gearFromTier(tier)` (XS→quick,S/M→middle,L/XL→full); `gearFromForced(forcedTier?)` → `forcedTier ? gearFromTier(forcedTier) : undefined`.
- Tests: each tier→gear; forced→gear; undefined→undefined.

### Task 2: router stubs for debug/refactor
- File: `src/host/controller.ts` run-start (before gear dispatch); test `tests/host/controller.test.ts`.
- If `currentTaskType==='debug'|'refactor'` → escalate with the stub message; do NOT enter any phase. Journal the routing decision.
- Tests: a `debug:` idea escalates with the stub message and starts NO phase (no P1 steer); same for `refactor:`; a `build:`/no-prefix idea proceeds normally.

### Task 3: gear dispatch + `currentGear`
- File: controller.ts run-start. Add `currentGear` field; set from `gearFromForced(currentForcedTier)` (undefined when no prefix). If `currentGear==='quick'` → `await this._runPhasesQuick(ctx)`; if `'middle'` → `_runPhasesMiddle(ctx)`; else (`'full'` or undefined) → the existing `_runPhases(ctx)` path UNCHANGED.
- Tests: `full:`/no-prefix → full path runs (existing behavior, P1 fires). `quick:` → `_runPhasesQuick` invoked (stub-assert via a journal/marker for now if methods land in later tasks; otherwise order tasks so 4/5 land first).

### Task 4: `_runPhasesQuick`
- File: controller.ts (new private method) + maybe a small seed-instruction builder in `src/phases/` ; tests `tests/host/controller.test.ts` (+ a seed-phase unit test).
- Implement the seed→P4→P5→P6 sequence with XS sizing, full bookends (pause/compact/escalate/retro/release/restoreCwd). Seed via one `hostAgent.steer` producing minimal P1Output+P3Output (reuse validators).
- Tests (mock hostAgent + phase deps): a quick run with a happy-path seed drives P4/P5/P6 and ends in `release()` (lock freed); a seed that fails validation escalates; no P1Discover/P2/P3 panel steer is issued (assert the ceremony phases are skipped).

### Task 5: `_runPhasesMiddle`
- File: controller.ts (new private method); tests.
- P1 → (synth empty P2Output) → P3 → P4 → P5 → P6, full bookends, keep post-P1 rescore unless `mid:` forced.
- Tests: a middle run issues a P1 steer and a P3 steer but NO P2 persona steer; ends in release; failures escalate.

### Task 6: wire dispatch end-to-end + journal
- Ensure run-start journals `gear: quick|middle|full` and `task-type: …`. `/autodev-status` shows the gear.
- Tests: status reflects gear; journal has the gear line.

---

## Acceptance (default-FAIL)
- **Full-gear path is behaviorally identical to today — all 851 existing tests pass with no edits to their intent.** (The single hard gate. If any existing test needs changing, the additive design was violated — stop and fix the approach, not the test.)
- `quick:` runs seed→P4→P5→P6, skips P1/P2/P3 ceremony, still enforces tests-pass + no CRITICAL/HIGH, ends with the lock released.
- `mid:` runs P1→P3→P4→P5→P6, skips P2, ends released.
- `debug:`/`refactor:` escalate with a clear stub message and start no phase.
- No-prefix work runs the full path (auto-downshift is out of scope) — but stays cheap via B1 sizing.
- `tsc --noEmit` clean; full suite green (+ new tests); deterministic (no new flaky tests — apply the B1 teardown-settle pattern to any new integration test that starts a run); `npm audit` 0.

## Pre-mortem
1. **Lock leak in the new methods.** The new gear methods MUST replicate the full path's terminal handling (escalate→release on failure, retro→release on success) or they leak `.autodev/running.lock`. Each new integration test asserts the lock is released at the end. Reuse B1's `waitForRunSettled`-style teardown.
2. **Seed produces an invalid plan.** Quick gear depends on the host emitting a parseable minimal P1Output+P3Output. Reuse the existing validators; escalate (don't crash) on failure. Calibrate the seed instruction; iterate if live runs fail to parse.
3. **P3 type contract for middle.** P3Context needs a P2Output; the synthesized empty P2Output must pass P3's expectations (P3 reads p2 for objections — empty debate is fine, P3 just has nothing to fold in). Verify P3 tolerates an empty personaDebate.
4. **Existing-test drift from a shared-helper extraction.** If you extract `_executeP4`-style helpers, the full path must stay identical. Run the full suite immediately after any extraction; revert to inline duplication if anything drifts.
5. **Forced-tier + gear interplay.** `quick:`→XS→quick gear AND forced tier XS (skips rescore). `_runPhasesQuick` uses XS sizing directly. Confirm no double-application or rescore attempt inside the quick path.

## Out of scope (later)
- Auto-downshift mid-run (no-prefix work picking quick/middle after P1) — deferred; B1 sizing covers the cheap-auto case.
- Stage B3: intent gate + phase-by-phase (file-poll dialogue).
- Stage C: the debug track (D1–D5) that the `debug:` stub points to.
