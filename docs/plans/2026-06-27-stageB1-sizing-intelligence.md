# Stage B1 — Sizing Intelligence Implementation Plan

> **For Claude:** Build via executor subagents (TDD), then post-build review-to-zero. No ralplan (concrete extension of existing infra; the post-build adversarial review is the gate). This is the first of three Stage-B increments — see `2026-06-27-gears-and-tracks.md` for the full sub-staging and the no-ask-API finding.

**Goal:** Replace the keyword-heuristic complexity scorer (which over-scored the clamp run to XL → 8 personas) with host-LLM self-assessment, and add explicit override prefixes. Accurate sizing alone makes a trivial task land at tier XS (`panelPersonas:0` → P2/P3 skip their panels, `reviewRounds:1`), which is most of the "quick gear" benefit without yet refactoring the phase loop.

**Architecture:** P1 (discovery) already runs a host-LLM steer that writes a spec. Extend that same steer to also self-assess complexity, and emit it as a new optional field on `P1Output`. The controller's existing post-P1 rescore consumes `p1.complexity` when present (via the existing `scoreComplexity()`), and falls back to the existing `_rescoreFromSpec` keyword heuristic when absent or malformed. Override prefixes are parsed off the idea string at input time and force a tier directly. This reuses the proven phase-output-file mechanism and the existing two-stage sizing flow — no new subagent dispatch (persona/judge subagent types are unreliable; the host LLM with full P1 context is the judge).

**Tech Stack:** existing — TypeScript, vitest. No new deps.

---

## Background facts (verified by exploration)

- `Sizing` (`src/engine/complexity.ts:11`): `{ panelPersonas, laneCap, reviewRounds, thinkingLevel }`. `SIZING_TABLE` maps `ComplexityTier` (XS/S/M/L/XL) → Sizing. `tierSizing(tier)` and `scoreComplexity(input: ComplexityInput)` exist. `ComplexityInput = { files, novelty, blastRadius, irreversibility }`.
- Controller two-stage sizing: run-start `currentSizing = tierSizing('M')` (controller.ts:641); post-P1 `_rescoreFromSpec(spec)` → `scoreComplexity` → maybe upgrade tier + `setThinkingLevel` (controller.ts:669–682).
- `_rescoreFromSpec` (controller.ts:1049) is the keyword heuristic to be superseded (kept as fallback).
- `P1Output` (`src/phases/phase-output.ts:17`): `{ phase:'P1', spec, stackAdr, webResearch }`. Phase outputs are validated by discriminated-union validators in the same file.
- Idea entry: `_onInput` (controller.ts:457); `isIdea` heuristic at :469; `idea` captured at :479; `this.currentIdea = idea` set at :507 after the lock is won.
- P1 instruction is built in `src/phases/p1-discover.ts`; P1 receives `memoryStore`/`embedder` (codebase context) already.

---

## Tasks (TDD — write the failing test first each time)

### Task 1: `ComplexityAssessment` type + override→tier mapping (engine)

**Files:**
- Modify: `src/engine/complexity.ts`
- Test: `tests/engine/complexity.test.ts`

**Step 1 — failing tests:**
```typescript
import { tierFromOverride, isValidComplexityInput, scoreComplexity } from '../../src/engine/complexity'

test('tierFromOverride maps prefixes to tiers', () => {
  expect(tierFromOverride('quick')).toBe('XS')
  expect(tierFromOverride('mid')).toBe('M')
  expect(tierFromOverride('full')).toBe('XL')
  expect(tierFromOverride('bogus')).toBeNull()
})

test('isValidComplexityInput rejects malformed assessments', () => {
  expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(true)
  expect(isValidComplexityInput({ files: 0, novelty: 'low', blastRadius: 1, irreversibility: 'low' })).toBe(false) // files < 1
  expect(isValidComplexityInput({ files: 1, novelty: 'huge', blastRadius: 1, irreversibility: 'low' })).toBe(false) // bad enum
  expect(isValidComplexityInput({ files: 1, novelty: 'low', blastRadius: 9, irreversibility: 'low' })).toBe(false) // blast 1–5
  expect(isValidComplexityInput(null)).toBe(false)
  expect(isValidComplexityInput({ files: 1 })).toBe(false) // missing fields
})

test('a trivial assessment scores XS', () => {
  expect(scoreComplexity({ files: 1, novelty: 'low', blastRadius: 1, irreversibility: 'low' }).tier).toBe('XS')
})
```

**Step 2 — run, expect FAIL** (`tierFromOverride`/`isValidComplexityInput` undefined).

**Step 3 — implement** in `src/engine/complexity.ts`:
```typescript
export type OverrideGear = 'quick' | 'mid' | 'full'
const OVERRIDE_TIER: Record<OverrideGear, ComplexityTier> = { quick: 'XS', mid: 'M', full: 'XL' }

export function tierFromOverride(prefix: string): ComplexityTier | null {
  return OVERRIDE_TIER[prefix.toLowerCase() as OverrideGear] ?? null
}

const NOVELTY_VALUES = new Set(['low', 'med', 'high'])
const IRREV_VALUES = new Set(['low', 'med', 'high'])
export function isValidComplexityInput(x: unknown): x is ComplexityInput {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.files === 'number' && o.files >= 1 && o.files <= 50 &&
    typeof o.novelty === 'string' && NOVELTY_VALUES.has(o.novelty) &&
    typeof o.blastRadius === 'number' && o.blastRadius >= 1 && o.blastRadius <= 5 &&
    typeof o.irreversibility === 'string' && IRREV_VALUES.has(o.irreversibility)
  )
}
```

**Step 4 — run, expect PASS. Step 5 — commit.**

### Task 2: extend `P1Output` with optional `complexity` + validator

**Files:**
- Modify: `src/phases/phase-output.ts` (P1Output interface + its validator)
- Test: `tests/phases/p1-p3.test.ts` (or wherever P1 output validation is tested)

**Step 1 — failing test:** a P1 output JSON that includes a valid `complexity` object validates and round-trips the field; one with a malformed `complexity` still validates the rest (complexity dropped to undefined, not a hard reject — back-compat + defensive). A P1 output with NO `complexity` validates (existing behavior).

**Step 3 — implement:**
```typescript
import type { ComplexityInput } from '../engine/complexity'
export interface P1Output {
  phase: 'P1'
  spec: string
  stackAdr: string
  webResearch: WebResearchEntry[]
  /** Host-LLM self-assessment of complexity (B1). Optional — absent ⇒ controller falls back to keyword heuristic. */
  complexity?: ComplexityInput & { rationale?: string }
}
```
In the P1 validator: if `raw.complexity` is present and `isValidComplexityInput(raw.complexity)`, keep it (plus `rationale` if a string); otherwise omit it (do NOT fail the whole P1 validation). Keep all existing gates (spec ≥20, stackAdr ≥10).

**Step 4 — PASS. Step 5 — commit.**

### Task 3: P1 instruction asks the host to self-assess complexity

**Files:**
- Modify: `src/phases/p1-discover.ts` (the instruction builder + the output schema it tells the host to write)
- Test: `tests/phases/p1-p3.test.ts`

**Step 1 — failing test:** the built P1 instruction string contains the complexity-assessment ask (assert it mentions the four fields `files`/`novelty`/`blastRadius`/`irreversibility` and the `.autodev/phase-output/p1-*.json` `complexity` key). For existing-repo runs, the instruction tells the host to estimate blast radius from the codebase context.

**Step 3 — implement:** append to the P1 instruction a section like:
```
## Complexity self-assessment
After writing the spec, assess this work's complexity honestly and add a `complexity` object to your P1 output JSON:
- files: integer estimate of source files this will create or modify (1 for a single function/script).
- novelty: "low" (routine) | "med" (integration/refactor) | "high" (novel architecture/distributed/ML).
- blastRadius: 1 (isolated) … 5 (cross-service / schema migration / breaking change). For an existing codebase, base this on what the recalled code shows this change touches.
- irreversibility: "low" | "med" (schema/rename) | "high" (data deletion/destructive).
- rationale: one sentence.
Be calibrated: a small standalone utility is files:1, novelty:low, blastRadius:1, irreversibility:low (tier XS). Do NOT inflate.
```
Keep the rest of P1 unchanged (web research, spec, stackAdr). Parse the `complexity` out of the host's JSON into the P1Output (Task 2's validator handles safety).

**Step 4 — PASS. Step 5 — commit.**

### Task 4: controller post-P1 rescore consumes `p1.complexity`

**Files:**
- Modify: `src/host/controller.ts` (the post-P1 rescore block, ~669–682)
- Test: `tests/host/controller.test.ts`

**Step 1 — failing tests:**
- When `phaseStore.p1.complexity` is a valid trivial assessment (`files:1,novelty:low,blast:1,irrev:low`), the run rescbores to **XS** (`currentTier==='XS'`, `currentSizing.panelPersonas===0`) — NOT the keyword-heuristic result.
- When `p1.complexity` is absent, the run falls back to `_rescoreFromSpec` (existing behavior — lock an existing test).
- When `p1.complexity` is malformed (shouldn't happen post-Task-2, but defensively), fall back to the heuristic.

**Step 3 — implement:** replace the rescore source:
```typescript
const assessed = this.phaseStore.p1.complexity
const rescoreInput = (assessed && isValidComplexityInput(assessed))
  ? assessed
  : this._rescoreFromSpec(this.phaseStore.p1.spec)
const rescoreResult = scoreComplexity(rescoreInput)
// …existing tier-change journal + setThinkingLevel…
```
Journal which source was used (`action: 'tier rescore via p1.complexity'` vs `'via keyword heuristic (no p1.complexity)'`).

**Step 4 — PASS. Step 5 — commit.**

### Task 5: override-prefix parsing at idea entry

**Files:**
- Modify: `src/host/controller.ts` (`_onInput` idea capture; add a `_parseOverrides` helper; add `currentTaskType` + `currentForcedTier` fields)
- Test: `tests/host/controller.test.ts`

**Step 1 — failing tests:**
- `quick: add a function` → idea stored as `add a function`, forced tier XS; run-start sizing is XS and the post-P1 rescore is SKIPPED (forced tier wins).
- `full: build a payments system` → forced tier XL, rescore skipped.
- `debug: tests fail in auth` → `currentTaskType==='debug'`, idea stripped to `tests fail in auth`, no forced tier (sizing still rescbores). (Task-type is journalled; consumed by B2.)
- `build: a REST API` → `currentTaskType==='build'`, idea `a REST API`.
- Combined leading prefixes in either order: `quick: build: x` and `build: quick: x` → tier XS + taskType build + idea `x`.
- No prefix: idea unchanged, no forced tier, taskType defaults to `build`.
- A colon mid-sentence with no known leading prefix (`add a thing: with detail`) → unchanged (only KNOWN leading prefixes are stripped).

**Step 3 — implement** a `_parseOverrides(raw): { idea, forcedTier?, taskType }`:
- Loop at most twice, stripping a known leading token matched by `/^(quick|mid|full|build|debug|refactor)\s*:\s*/i`. `quick|mid|full` → set `forcedTier = tierFromOverride(...)`; `build|debug|refactor` → set `taskType`. Default `taskType='build'`.
- Apply in `_onInput` after `isIdea` passes: store stripped idea, `this.currentForcedTier`, `this.currentTaskType`. Journal both.
- In `_runPhases`: if `currentForcedTier` set, `currentTier=forcedTier; currentSizing=tierSizing(forcedTier)` at run-start AND **skip** the post-P1 rescore (guard the rescore block with `if (!this.currentForcedTier)`).

**Step 4 — PASS. Step 5 — commit.**

---

## Acceptance (default-FAIL)
- A trivial-function spec with an honest `p1.complexity` rescbores to **XS** (panelPersonas 0 ⇒ P2/P3 panels skipped, reviewRounds 1) — the clamp over-scoring is fixed at the sizing layer.
- `quick:`/`mid:`/`full:` force XS/M/XL and bypass the rescore; `build:`/`debug:`/`refactor:` set `currentTaskType` and strip cleanly; combined prefixes work in both orders.
- `p1.complexity` absent or malformed ⇒ graceful fall back to the existing keyword heuristic (no behavior change for runs without the new field).
- All existing fixtures stay green (complexity is optional; defaults preserved). `tsc --noEmit` clean; full vitest suite green (+ new tests); `npm audit` 0.

## Out of scope (later increments)
- B2: gears as actual phase-path skipping (quick = skip P1/P2/P3 entirely), task-type ROUTING (debug → Stage C track), FSM generalization.
- B3: intent gate + phase-by-phase (the file-poll-dialogue interaction model).
- Stage C: the debug track (D1–D5).

## Pre-mortem
1. **Host under/over-rates complexity.** Calibration lives in the instruction ("do NOT inflate"; explicit XS exemplar). The keyword heuristic remains as a fallback, and override prefixes give the user a hard manual control. Acceptable; iterate on the wording if live runs miscalibrate.
2. **Back-compat of P1Output.** `complexity` is optional and the validator never hard-fails on a bad complexity object — existing 792 tests must stay green. Verify by running the full suite, not just new tests.
3. **Prefix false-positives.** Only the fixed known-prefix set is stripped, and only as a leading token; mid-sentence colons are untouched. Locked by a test.
4. **Forced-tier vs rescore ordering.** The rescore must be skipped (not just overwritten) when a tier is forced, else the keyword heuristic could clobber the user's explicit `quick:`. Guarded + tested.
