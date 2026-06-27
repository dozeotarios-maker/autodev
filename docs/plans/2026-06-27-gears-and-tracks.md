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
