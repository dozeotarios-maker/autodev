# Stage D — Refactor Track (R1–R4) Implementation Plan

> **For Claude:** The third task-type track (build + debug done). Reuses the C-0 primitives + the debug-track patterns, so it's smaller than C-1. Build via executor (TDD) + review-to-zero. Replaces the B2 `refactor:` router stub. A light critic pass is optional — the design mirrors the proven debug track.

**Goal:** When the user prefixes `refactor:`, autodev runs a behavior-preserving refactor track: **characterize current behavior first, transform, then prove behavior is unchanged (characterization tests green + full suite green).** No refactor declared done if behavior changed.

**Architecture:** A new `_runRefactorTrack(ctx)` parallel to `_runDebugTrack` — same shape (own linear R-counter, full lifecycle bookends, contract/validator pattern, reuses `boundedExec`/`verifier`/`gitOps`/`actionMonitor`). The B2 router currently escalates `refactor:` with a stub; Stage D wires `refactor:` → `_runRefactorTrack`.

## The four steps (each a host steer → validated `.autodev/refactor-output/rN-*.json`)

### R1 — Characterize (the safety net)
- Steer: "Before refactoring, ensure the CURRENT behavior of the target code is pinned by tests. If existing tests already cover it, name them. Otherwise write NEW characterization tests (vitest) that PASS on the current code and capture its observable behavior. Output `{ characterizationSummary, characterizationCommand, characterizationArtifact, coversExisting }`." `characterizationCommand` must be `npx vitest run <file>` (validator rejects non-ALLOWED_BINARIES first-token + shell metacharacters, like D1).
- **Gate (deterministic, BoundedExec, timeout):** run `characterizationCommand` 3× → require consistent **GREEN** (the characterization passes on the UNCHANGED code — that's the baseline). If red/flaky → escalate "characterization not green on current code — cannot establish a behavior baseline". Distinguish harness-error (reuse `isHarnessError`) from a real failure. Snapshot the characterization file's SHA-256 (anti-cheat for R3).

### R2 — Transform
- Steer: "Apply the refactor (the user's `refactor:` request). Preserve observable behavior. Do NOT modify the characterization test (it is the oracle). Output `{ transformSummary, filesChanged }`." Write-confined to repoRoot.
- Gate: ≥1 file changed (via `gitOps.changedFiles`); the characterization artifact NOT in the changed set AND its SHA-256 == the R1 snapshot (you cannot "preserve behavior" by editing the oracle); if changedFiles empty after the transform steer → escalate "no changes made".

### R3 — Verify no behavior change (the core gate)
- Re-run `characterizationCommand` via BoundedExec 3× → require consistent **GREEN** (behavior preserved). Run the full suite via `verifier.runDeterministic('npx vitest run', repoRoot)` → **GREEN** (no regression). Both required.
- If the characterization goes RED → the refactor CHANGED behavior → escalate "refactor altered behavior: <characterization failure>" (do NOT loop-and-retry blindly — a behavior change is a hard stop for a refactor; surface it to the operator). If only the suite regressed (characterization green) → loop back to R2 once (capped MAX_REFACTOR_ROUNDS=2), else operator brief. Distinguish harness-error from a real failure (isHarnessError).

### R4 — Ship
- `gitOps.scopedCommit(message, [...R2.filesChanged, R1.characterizationArtifact])` (commit the refactor AND its characterization tests) + scanSecrets + push. Skip tierDGate for refactor v1. Message derived from transformSummary.

## Tasks (TDD)
1. R1-R4 contract types + validators (`src/refactor/refactor-output.ts`, mirror debug-output.ts): `R1Output{characterizationSummary,characterizationCommand,characterizationArtifact,coversExisting,characterizationGreen}`, `R2Output{transformSummary,filesChanged}`, `R3Output{characterizationStillGreen,suiteGreen,rounds}`, `R4Output{commitSha,pushResult}`. Reuse the metachar + ALLOWED_BINARIES rejection from debug-output. Tests per validator.
2. R-step classes (`src/refactor/r1-characterize.ts`..`r4-ship.ts`, mirror src/debug/d*). Reuse `isHarnessError`. Tests (mock hostAgent).
3. `_runRefactorTrack(ctx)` in controller + router wiring (replace the `refactor:` stub). Own linear R-counter, full bookends (lock released on EVERY terminal), `boundedExec.setRepoRoot` armed at entry, non-resurrectable, journal each R-step, build pipeline P1-P6 NOT entered. UPDATE the B2 `refactor:` stub test.
4. Integration tests (mock host/boundedExec/verifier/gitOps; the lock-disappears driver pattern for speed <10s; reject-loud polls; B1 teardown-settle): happy path R1(green×3)→R2(anti-cheat ok)→R3(char green×3 + suite green)→R4 commit, lock released, P1-P6 not entered; R1 char-not-green → escalate; R2 oracle-altered → escalate; R3 char-goes-red (behavior changed) → escalate "altered behavior"; R3 suite-regress → loop capped 2.
5. `/autodev-status` shows the refactor step.

## Acceptance (default-FAIL)
- `refactor:` runs R1→R4; R1 gates on a consistently-GREEN characterization (baseline); R2 can't edit the oracle (git+SHA anti-cheat); R3 requires characterization-still-green AND suite-green (a behavior change → hard escalate); R4 commits the refactor + its tests. Lock released on every terminal. Build pipeline untouched; the B2 refactor-stub test intentionally replaced. tsc clean; full suite green (+ new); integration file <10s + deterministic (10x); npm audit 0.

## Pre-mortem
1. Characterization not green on current code → can't baseline → escalate (don't refactor blind). 2. Hang → BoundedExec timeout. 3. Oracle edited → git+SHA anti-cheat. 4. Behavior change at R3 → hard escalate (NOT loop — unlike debug, a behavior change is the failure, not a retry signal). 5. Harness-error vs real → isHarnessError. 6. Thin existing coverage → R1 writes characterization tests (the value-add). 7. Non-vitest target → v1 assumes vitest.

## Out of scope
- Auto-detecting refactor opportunities (user requests it explicitly via `refactor:`). Refactor-track gears. Resumable refactor runs.
