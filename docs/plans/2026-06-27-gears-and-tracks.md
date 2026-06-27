# pi-autodev Gears + Task-Type Tracks — Master Plan

> **For Claude:** Built in stages via executor subagents, each stage plan→build→review. No ralplan (operator-approved skip). The clamp live-run exposed all of this: full enterprise pipeline (web research, 8-persona panel, revision rounds, per-boundary compaction) fired at a 6-line function, and the compaction HUNG the run.

**Vision:** autodev picks the right KIND of work at the right DEPTH, sized from context — not guessed.
```
detect task-type (build / debug / refactor)
  -> smart sizing (intent gate | codebase impact | triviality | LLM-judge)
  -> gear (quick / middle / full)
  -> run that workflow's phase-path
  -> autonomous (quick/middle) or phase-by-phase (full)
  + explicit override: quick:/mid:/full:  and  build:/debug:
```

## The two dimensions
**Task type → workflow:**
- **build** → P1→P6 (current)
- **debug** → D1 reproduce → D2 root-cause (codebase-memory + competing hypotheses) → D3 fix → D4 verify (repro green + suite green) → D5 ship
- **refactor** (later) → characterize → transform → verify-no-behavior-change

**Gear → depth** (the clamp run proved the keyword scorer over-scores; replace with an LLM judge):
| | Quick (fn/script) | Middle (module/feature) | Full (enterprise) |
|---|---|---|---|
| research | none | targeted (external deps only) | full sweep + ADR |
| elaborate/personas | skip | brief self-check | domain model + persona debate |
| plan/panel | skip | plan + 1 critique | N-persona panel + revisions |
| verify | run tests | tests + done-judge | holdout + mutation + N rounds |
| compaction | never | only near limit | only near limit |

**Smart sizing (asks only when needed):**
- new project from scratch → **intent gate** (2-3 Qs: use case / scale / users)
- feature on existing code → **codebase-memory** maps blast radius (files, subsystems, risk: auth/data/migration/API) → gear; one-line confirm only if high-risk/ambiguous
- trivial standalone → quick, no questions
- explicit prefix → forced

**Execution:** autonomous (quick/middle default) OR phase-by-phase (full default) — each phase emits its `.autodev/` contract, autodev pauses for continue/adjust/stop. Overridable.

---

## STAGE A — Urgent fixes (build first) — detailed below
## STAGE B — task-type router + gears + smart sizing + phase-by-phase
## STAGE C — debug track (D1–D5)

---

# STAGE A tasks (TDD)

### A1 — Compaction: conditional + timeout (URGENT — this hung the live run)
**File:** `src/host/controller.ts` (`compactAsync` ~L55 + the phase-boundary callers).
Root cause of the hang: compaction needs a model call to summarize; the model 400'd ("out of usage"); pi's `ctx.compact()` never fired `onComplete` OR `onError`; `compactAsync` has no timeout → waited forever.
- **Timeout:** race `ctx.compact({onComplete,onError})` against a timeout (default 45_000ms, configurable). On timeout → `resolve()` (skip compaction, log `compaction skipped: timeout`), do NOT hang, do NOT escalate. Ensure the late onComplete/onError after timeout is a no-op (guard double-settle).
- **Conditional:** only compact when context is actually near the limit. Investigate pi's `ContextUsage` (the `context` event / ctx exposes usage). If readable, skip compaction unless usage > a threshold (e.g. 0.7). If not readily readable, gate compaction on the run's tier (skip for XS/S; only full/large compacts) — accept a `shouldCompact()` predicate. Keep tolerating "nothing to compact"/"already compacted" (already in).
- Tests: compact that never settles → compactAsync resolves after the timeout (fake timers); usage-below-threshold → compaction skipped (not called); usage-high → compaction runs.

### A2 — Write-confinement safe-zones (over-blocks /dev/null, /tmp)
**File:** `src/safety/action-monitor.ts`.
The live run blocked `2>/dev/null` and `>/tmp/npm.log` — both legit. `2>/dev/null` is in half of all shell commands; blocking it breaks normal builds.
- Add a SAFE_WRITE_ZONES allowlist treated as always-writable in BOTH `checkFileWrite` and `checkBashCommand` (alongside `allowedPaths`): `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/zero`, `/dev/tty`, `/dev/fd/*`, and `os.tmpdir()` (covers `/tmp`). A write whose resolved path is within a safe zone is allowed even if outside repoRoot.
- Tests: `2>/dev/null` allowed; `>/tmp/x.log` allowed; `> $TMPDIR/x` allowed; `>/root/pollute.js` STILL blocked; tool-write to `/dev/null` allowed.

### A3 — Persona panel: no "Unknown agent" error
**Files:** `src/phases/p2-elaborate.ts`, `src/phases/p3-plan.ts` (persona task construction) + investigate the subagent driver.
The live run logged `Unknown agent: user` — the persona names (user/developer/security/…) are not registered pi-subagent agent types, so the panel can't spawn them; it falls back to host-synthesis but emits an error.
- Investigate what subagent agent type(s) pi-subagents actually provides. Then EITHER (a) spawn personas as a VALID generic subagent type with persona-framed prompts ("Act as a <persona>; critique this from that lens"), OR (b) make host-synthesis the DESIGNED path (detect unavailable persona agents once, log an info line not an error, synthesize). Pick whichever actually works against the installed pi-subagents. No `Unknown agent` error in the run.
- Tests: panel with unavailable persona types → no throw, no "Unknown agent" error surfaced; debate still produced (real or synthesized); valid-type path spawns correctly if available.

## Stage A acceptance
- compactAsync cannot hang (timeout) and skips tiny/low-usage sessions; bash `2>/dev/null` + `/tmp` writes allowed while `/root` writes stay blocked; no `Unknown agent` error. tsc clean, full suite green (+ new tests), npm audit 0.

**STAGE A STATUS: DONE + reviewed-to-zero (2 rounds) + pushed (commit 2bb5f78, 45 commits on origin/main, 792 tests).**

---

# STAGE B — detailed (post-exploration)

The codebase exploration (4 parallel agents) established the existing infrastructure and one critical constraint. Stage B is built on top of what already exists, not greenfield.

## What already exists (don't rebuild)
- **`Sizing` type** (`src/engine/complexity.ts:11`): `{ panelPersonas, laneCap, reviewRounds, thinkingLevel }`. Mapped from `ComplexityTier` (XS/S/M/L/XL) via `SIZING_TABLE`. XS → `panelPersonas:0` (panels skip), `reviewRounds:1`, `thinkingLevel:low`.
- **Two-stage sizing** in the controller: run-start defaults to tier M; post-P1, `_rescoreFromSpec(spec)` (controller.ts:1049) runs a **keyword heuristic** that feeds `scoreComplexity()`. **This keyword scorer is what over-scored the clamp (XL → 8 personas).**
- **Sizing threads through `PhaseContext`** as `sizing?: Sizing`; each phase reads it: P2/P3 `panelPersonas` (0 ⇒ skip panel), P4 `laneCap`, P5 `reviewRounds`. `setThinkingLevel` called at run-start + post-P1 rescore.
- **Phase loop** (`_runPhases`, controller.ts:637–863): a ~230-line monolith of hardcoded sequential P1→P6 blocks. FSM `PHASE_ORDER` is hardcoded. Each phase: instantiate → `execute(ctx)` → gate → `compactAsync` → `fsm.advance()`. A file-based pause check (`_isPaused`/`_waitResume`) sits at each phase entry.
- **Phase outputs** are JSON contract files under `.autodev/phase-output/p{N}-*.json`, validated by discriminated-union types; each feeds the next.
- **No existing notion** of gear/track/task-type/mode — this is the new dimension.

## THE CRITICAL CONSTRAINT — pi has no "ask the human" API
- `pi.sendUserMessage(content, {deliverAs})` is **fire-and-forget to the host LLM**, not the human. There is **no prompt/confirm/ask request-response API** in the pi extension surface.
- Human input during RUNNING is **rejected** (lock denied / treated as a new idea). Self-steers are filtered by `source:'extension'`.
- The ONLY human-wait primitive is **file polling** (`_waitResume` polls a pause file every 2s, 1h cap) and the **operator-brief** pattern (release lifecycle, human resumes).
- **Consequence:** the intent gate (ask 2–3 questions) and phase-by-phase (continue/adjust/stop) CANNOT be blocking interactive dialogs.

### The interaction design that works within the constraint (file-poll + host-conducts-dialogue)
The host LLM — not autodev — owns the human conversation (that's pi's primary loop). So:
1. Autodev fires a **non-awaited** steer to the host: "Interview the user: ask (1) use case, (2) scale, (3) audience. When they answer, write `{useCase,scale,audience}` to `.autodev/intent.json`."
2. Autodev **polls** for `.autodev/intent.json` (reuse the `_waitResume` polling pattern; timeout → degrade to defaults, not hang).
3. The host asks the human (turn ends), the human answers (new turn — flows to the host naturally, autodev ignores it in `_onInput`), the host may follow up, then writes the file.
4. Autodev reads the file, threads the answers into sizing + P1 context, proceeds.
Same pattern for phase-by-phase: write the phase contract, fire "ask the user continue/adjust/stop," poll `.autodev/phase-decision.json`, branch on the verdict. This relies only on proven primitives (sendUserMessage + file-poll) and the same host-writes-a-file trust model every phase already uses.

## Sub-staging (each: plan → build → review-to-zero; B1/B2 concrete enough to skip ralplan like Stage A; B3 gets a critic pass for the novel interaction model)

### B1 — Sizing intelligence (fixes clamp; lowest risk; build FIRST)
Replace the keyword scorer with host-LLM self-assessment + add override prefixes. Accurate XS sizing alone makes clamp skip panels (panelPersonas=0) — no phase-path refactor needed yet.
- **LLM-judge via P1 self-assessment:** extend `P1Output` with optional `complexity: { files, novelty, blastRadius, irreversibility, rationale }`. P1's instruction asks the host — having just written the spec — to assess complexity (for existing repos, factor blast radius from the codebase-memory context P1 already receives). Controller post-P1 rescore uses `p1.complexity` via `scoreComplexity()` when present; **falls back to `_rescoreFromSpec` keyword heuristic** when absent. This is the LLM judging (the host LLM with full P1 context), reusing the phase-output mechanism — no separate, possibly-invalid subagent dispatch.
- **Override prefixes** parsed at idea entry (controller `_onInput`, before run start): `quick:`/`mid:`/`full:` → force tier (XS/M/XL), skip rescore; `build:`/`debug:` → store `currentTaskType` (journalled; consumed by B2). Strip the prefix from the idea before P1.
- Acceptance: a trivial-function spec rescoringly lands XS (panelPersonas 0); `quick:` forces XS regardless of spec; the keyword heuristic still works as fallback; existing fixtures green (sizing optional, defaults preserved).

### B2 — Gears as phase-paths + task-type router
Refactor the `_runPhases` monolith into a **gear-driven phase loop**; add the build/debug/refactor router.
- Extract a phase-path abstraction: `quick` = P4→P5(tests-only)→P6 (skip P1/P2/P3 ceremony, synthesize a minimal spec from the idea); `middle` = P1(targeted)→P3(plan+1 critique)→P4→P5→P6; `full` = current P1–P6. Guard phase dependencies (a skipped P1 must still seed a minimal spec for P4).
- Task-type router: detect build/debug/refactor (LLM-assessed or prefix). `build` → the gear phase-paths above. `debug` → route to the Stage C debug track (until C lands, a stub that escalates "debug track not yet built"). `refactor` → later.
- Touches the hot controller + FSM (generalize `PHASE_ORDER`). Higher risk → careful tests per gear.

### B3 — Interaction (intent gate + phase-by-phase) — novel, gets a critic pass
- Intent gate (new-from-scratch + ambiguous): file-poll-dialogue per above. Default-degrade on timeout.
- Phase-by-phase (full gear default): after each phase, write contract + poll `.autodev/phase-decision.json` for continue/adjust/stop. `adjust` → backedge; `stop` → release.
- This increment carries the interaction-model risk → run the plan through ralplan/critic before building.
