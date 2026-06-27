# Stage B3 — Interaction: Phase-by-Phase + Intent Gate (REVISED after critic gate)

> **For Claude:** This plan was REWRITTEN after an architect+critic review found the original premise false. Build B3a first (phase-by-phase), then B3b (intent gate), each TDD + review-to-zero. Third Stage-B increment — see `2026-06-27-gears-and-tracks.md`.

## What the critic gate corrected (read this first)
The original plan assumed **pi has no ask-the-human API** and built an elaborate "fire a non-awaited steer → host writes a JSON file → autodev polls the file → degrade on timeout" model. **That premise is FALSE** (verified in the pi SDK):
- `ctx.ui.select(title, options[], {timeout?, signal?}) → Promise<string|undefined>` (types.d.ts:69) — blocking, typed, bounded choice.
- `ctx.ui.confirm(title, message, opts) → Promise<boolean>` (71); `ctx.ui.input(title, placeholder, opts) → Promise<string|undefined>` (73); `ctx.ui.editor` (134); `ctx.ui.custom` (116).
- `pi.registerTool(...)` (840) — an LLM-callable tool whose `execute` can call `ctx.ui.*`.
- `ctx.hasUI: boolean` (214), `ctx.mode: "tui"|"rpc"|"json"|"print"` (212). Shipped examples: `question.ts`, `questionnaire.ts`, `timed-confirm.ts`, `confirm-destructive.ts`.

**So the design is now direct request-response via `ctx.ui.*`**, not file-poll. This ELIMINATES, by construction, the original hazards: the `sendUserMessage`/`HostAgent`-mutex collision, the stale-file race, malformed-but-parseable JSON, the `awaitingDialogue`/`_onInput` input-routing change, and the "new idea typed mid-dialogue" swallow. None of those exist when the human's answer is a typed Promise resolution.

**Guard:** `ctx.ui.*` needs `ctx.hasUI` (true in tui+rpc, false in print/json). When `!ctx.hasUI`, the gate is **skipped** (autonomous fallback) — for v1 we do NOT build a headless file-poll fallback (descoped; revisit only if a headless interactive run is ever needed).

**Goal (unchanged):** (B3a) an opt-in phase-by-phase mode — after each phase, ask continue/adjust/stop; (B3b) an intent gate — when starting a brand-new project, ask 2–3 questions and fold answers into discovery.

**Tech Stack:** existing. No new deps.

---

## Corrected background facts (the original plan asserted several wrong ones)
- **`ctx.ui.*` exists** (above). Use it.
- **`.autodev/config.json` does NOT exist** — there is no config reader in `src/` (the `/autodev-config` handler just notifies repoRoot). So `phaseByPhase` is enabled via a **`step:` idea prefix ONLY** for v1 (no config subsystem).
- **`resolvedIsNew` does NOT exist** — `isNew` is local inside `_resolveRepoRoot` and only computed when a registry is injected (it early-returns otherwise). B3b must add a `resolvedIsNew` instance field, default `false`, set from the resolver, handling the no-registry path.
- **`P1Context.intent` does NOT exist** (phase-output.ts:27) — B3b adds it AND wires it into `buildP1Instruction` (p1-discover.ts).
- `parseOverrides` (controller.ts:201-221): `PREFIX_RE` matches only `quick|mid|full|build|debug|refactor`, loops twice. `step:` is unknown → would leak into the idea. B3a must extend it.
- `_runPhases` canonical phase boundary: `journal completion → setHud(compacting) → await compactAsync → await fsm.advance → setHud(running)`. The H9 P5→P3 backedge (the `p5Result.backedge` branch) does its own `fsm.backedge('P3')` then hard-returns via operator brief. Terminal success path: retro → guarded `memoryStore.store` (under `_terminalStored`) → `lifecycle.release()` → `_restoreCwd()`.
- `_operatorBrief(phase, msg)` already does the full terminal protocol (retro+store+release+restoreCwd+HUD). `fsm.backedge(target)` is supported+tested (H9 uses it).
- Existing tests that produce `isNew=true` via the full input path: `tests/host/controller-project-resolver.test.ts:240, :270` — B3b's intent gate MUST NOT fire in these (gated by `hasUI` + opt-in; verify these mocks have `hasUI=false` or the gate is otherwise skipped).
- New ControllerOptions knobs needed: `dialogueTimeoutMs?` (default ~5min for ui.* `{timeout}`) so tests can bound it. (`ctx.ui.*` returns immediately in mocks, so no hang risk — but keep it injectable.)

---

# B3a — Phase-by-phase (BUILD FIRST; lowest risk, cleanest 878-green)

### Design
- `phaseByPhase: boolean` instance field, default **false**, reset per run. Enabled when `parseOverrides` sees a `step:` prefix.
- `_phaseGate(phaseName, ctx): Promise<'continue'|'adjust'|'stop'>`:
  - if `!ctx.hasUI` → return `'continue'` (autonomous; no UI to ask on).
  - else `const choice = await ctx.ui.select(\`autodev — ${phaseName} complete. Proceed?\`, ['continue','adjust','stop'], { timeout: this.opts.dialogueTimeoutMs ?? 300_000 })`.
  - `choice === undefined` (timeout/cancel) → `'continue'` (degrade forward). Map the string to the union.
- **Hook placement (per architect):** in `_runPhases`, AFTER `await compactAsync(...)` AND AFTER `await this.fsm.advance()`, on FORWARD edges only, and NEVER on the `p5Result.backedge` branch. Guarded: `if (this.phaseByPhase) { ... }`. When false → no-op → full path identical → 878 tests green.
- **`stop`** → `await this._operatorBrief(phaseName, 'phase-by-phase: human chose stop')` then `return` (reuses the tested terminal protocol — retro+store+release+restoreCwd). Do NOT hand-roll release.
- **`adjust`** → re-run the just-finished phase once, threading the human's note. To keep FSM coherent: `this.fsm.backedge(currentPhaseName)` → re-run that phase's `execute` with a `notes` context field → on success `this.fsm.advance()`. Cap at `MAX_ADJUST_PER_PHASE = 3` via a per-phase counter reset at each phase entry; on cap-exceeded force `continue` with a journal line (the human is told "adjust limit reached, continuing").
  - For v1, to limit blast radius, `adjust` may optionally collect a note via `ctx.ui.input('What to adjust?', …)` and pass it as an optional `notes?: string` on the phase context (net-new optional field, analogous to nothing-breaks-when-absent). If threading `notes` into every phase context is too broad for v1, scope `adjust` to re-run with the SAME context (a plain redo) and journal the human's note — pick the simpler that still passes review; document the choice.
- `step:` plumbing (M1): extend `PREFIX_RE` to `^(quick|mid|full|build|debug|refactor|step)\s*:\s*`; add `phaseByPhase: boolean` (default false) to `ParsedOverrides`; bump the strip loop cap to 3; in `_onInput`'s lock-won block set `this.phaseByPhase = parsed.phaseByPhase`. `step` sets the boolean, does NOT go into taskType. Tests: `step:`, `step: full:`, `full: step:`, `step:` mid-sentence (not stripped), combined with the existing prefixes.
- Per-run reset: reset `phaseByPhase` (from parse), and any `adjustCount`, in the run-start reset block (mirror `_terminalStored=false`).

### B3a tasks (TDD)
1. `step:` in `parseOverrides` + `ParsedOverrides.phaseByPhase` + loop cap 3 + `_onInput` assignment. Unit + integration tests above.
2. `_phaseGate` (hasUI guard, `ctx.ui.select`, timeout→continue). Unit test with a mock `ctx.ui.select` returning each of continue/adjust/stop/undefined; and a `hasUI=false` ctx → returns continue without calling select.
3. Guarded hook in `_runPhases` (placement: after compact+advance, forward edges, not on backedge). Tests: flag OFF → full path identical (existing green, assert select NOT called); flag ON + select→continue → proceeds; →stop → `_operatorBrief` + lock released; →adjust → phase re-run (fsm.backedge→advance), capped at 3 then continue.
4. `/autodev-status` shows phase-by-phase mode. Determinism: new integration tests use the B1 teardown-settle (`waitForLockRelease`) pattern; run the file 10x.

### B3a acceptance
- 878 existing tests pass untouched (flag default-off → hook no-op; assert `ctx.ui.select` is never called on a default run).
- `step:` enables it and is stripped cleanly (both orders, capped); ON: continue/adjust/stop all work, `!hasUI` auto-continues; OFF: full path identical.
- `stop` releases the lock via `_operatorBrief`; `adjust` re-runs ≤3 then continues; FSM stays coherent (no mis-tagged phase).
- tsc clean; full suite green (+ new); deterministic (10x); npm audit 0.

---

# B3b — Intent gate (build AFTER B3a converges)

### Design
- `resolvedIsNew: boolean` field, default false, set from the resolver result (handle no-registry → stays false → gate never fires unexpectedly).
- `intentGate(ctx)` at `_runPhases` run-start, BEFORE P1: fires only if `ctx.hasUI && this.resolvedIsNew && !this.currentForcedTier`. (A `build:` prefix leaves `forcedTier` undefined — decide explicitly: treat `build:`+isNew as gate-eligible YES, since the user gave no depth signal. `debug:`/`refactor:` already early-return before `_runPhases`, moot.)
- Ask up to 3 `ctx.ui.input` questions (use case / scale / audience), each `{timeout}`; any `undefined` → stop asking, degrade (proceed with whatever was gathered, or nothing). Build `intent = {useCase?, scale?, audience?}`.
- Thread `intent` into a net-new optional `P1Context.intent` and into `buildP1Instruction` ("The user clarified: use case=…, scale=…, audience=… — factor these into the spec + complexity assessment"). Optional → absent leaves P1 unchanged (existing P1 tests green).
- **C1 guard (878-green):** because the gate needs `ctx.hasUI`, and `ctx.ui.input` returns immediately in mocks (no hang — unlike the old 10-min file poll), the existing `isNew=true` resolver tests will NOT hang. Still, VERIFY: either `makeExtCtx()`/the resolver-test ctx has `hasUI=false` (gate skips entirely), or add an `intentGate` default-off opt-in. Audit `controller-project-resolver.test.ts:240,:270` and confirm they stay green (write the gate so they do — prefer the `hasUI=false`-skips path; if those mocks have `hasUI=true`, add a default-off `intentGateEnabled` opt-in so existing tests don't trigger it). The plan does NOT permit editing those existing tests' intent.

### B3b tasks (TDD)
1. `resolvedIsNew` field + set from resolver (no-registry → false). Test.
2. `P1Context.intent` optional field + `buildP1Instruction` uses it. P1 unit test: intent present → instruction mentions it; absent → unchanged.
3. `intentGate` (hasUI + isNew + no-forced-tier trigger; ask via `ctx.ui.input`; degrade on undefined). Tests (mock ctx.ui.input): isNew+hasUI+no-override → asks, threads intent into P1; override OR existing-repo OR `!hasUI` → skipped (select/input NOT called); a cancelled (undefined) answer → degrades, proceeds. Confirm the two existing isNew resolver tests stay green.
4. Determinism (10x new files).

### B3b acceptance
- 878 (+B3a) tests pass untouched — the two existing isNew tests included (verified, not edited).
- Intent gate fires only on hasUI+isNew+no-override; threads typed answers into P1; degrades cleanly on cancel/timeout; skipped headless.
- tsc clean; suite green (+ new); deterministic; npm audit 0.

---

## Consolidated pre-mortem (architect + critic)
1. **`!hasUI`** (headless run) → gate skipped, autonomous. Verify the mock ctx's `hasUI` value drives the skip in tests.
2. **Timeout/cancel** → `ctx.ui.*` returns `undefined` → degrade (phase: continue; intent: proceed). Never hangs (no poll). Keep `dialogueTimeoutMs` injectable for production tuning.
3. **Hook must be no-op when flag off** — assert `ctx.ui.select` is NEVER called on a default full run; run the full suite to confirm 878 green.
4. **FSM coherence on `adjust`** — `fsm.backedge(N)`→re-run→`fsm.advance()`; cap 3; never fire the gate on the H9 backedge branch.
5. **`stop` uses `_operatorBrief`** (full terminal protocol), not a bare release (avoids the cwd-stranded bug).
6. **Per-run state reset** — `phaseByPhase`, `adjustCount`, `resolvedIsNew`, `intent` all reset at run-start (mirror `_terminalStored=false`); else a second run inherits stale state.
7. **`step:` prefix** must be plumbed through `parseOverrides` (regex + ParsedOverrides + loop cap) or it leaks into the idea string.
8. **Existing isNew tests** (`controller-project-resolver.test.ts:240,:270`) must stay green — gate them out via `hasUI`/opt-in; do NOT edit their intent.

## Out of scope
- Headless file-poll fallback (only if a non-UI interactive run is ever needed).
- `registerTool`-based intent questionnaire (a cleaner alternative to inline `ctx.ui.input`; revisit if multi-turn is wanted).
- Existing-repo codebase-impact confirm gate (B1 sizing already uses codebase context).
- Stage C debug track.
