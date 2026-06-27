# Stage E — Hardcoded Minimalism + Craftsmanship Principles

> **For Claude:** Concrete cross-cutting instruction-injection. Build via executor (TDD) + review-to-zero. No ralplan.

**Goal:** Autodev always produces (1) the **minimum code that actually does the job** — what's needed or asked for, nothing more; AND (2) code that reads like a **senior human dev wrote it** — idiomatic, style-matched, well-named, no AI-slop. Both hardcoded (always on, not configurable). They pair: minimal + senior-craft = clean human code.

**Architecture:** Autodev never writes code itself — it steers the host model. So minimalism is enforced two ways (steer + gate, mirroring the rest of the system):
1. A **directive** injected into every code-PRODUCING steer (P3 plan, P4 build, quick-seed, D3 fix, R2 transform) so the model aims minimal.
2. A **review lens** injected into P5's clean-context reviewer so over-engineering becomes a review finding — then the existing review-to-zero loop simplifies it away (the deterministic backstop; prompts alone aren't trusted).

**Tech Stack:** existing. No new deps.

## Tasks (TDD)

### Task 1: shared principle constants
- Create `src/principles.ts` with FOUR exported non-empty string constants:
  - `MINIMALISM_DIRECTIVE` (for code-producing steers):
    "MINIMALISM (hard requirement): produce the SMALLEST implementation that fully satisfies the spec and passes the tests — what is needed or explicitly asked for, nothing more. NO speculative generality, NO unused parameters/flags/abstractions, NO features not requested, NO premature optimization, NO gold-plating. Prefer the simplest data structure, the fewest files, and the standard library over new dependencies. If a line isn't required by a spec point or exercised by a test, don't write it. YAGNI + DRY."
  - `CRAFTSMANSHIP_DIRECTIVE` (for code-producing steers — write like a senior human):
    "CRAFTSMANSHIP (hard requirement): write code a senior engineer would be happy to ship — and that looks human-written, not AI-generated. MATCH the surrounding codebase's conventions, naming, structure, and error-handling patterns (this is the strongest signal). Names reveal intent — no data2/tmp/result3/foo/helper junk. Comments explain WHY, never restate WHAT the code already says; no step-by-step narration, no banner/decoration comment blocks. NO AI-slop tells: no preamble, no emoji, no defensive try/catch on everything, no needless abstraction layers, no over-explaining. Handle the REAL edge cases, not theoretical ones. Small focused functions, clear control flow."
  - `MINIMALISM_REVIEW_LENS` (for the P5 reviewer):
    "MINIMALISM CHECK: flag as a finding any code not required by the spec or exercised by a test — unused exports, speculative abstractions, dead/over-broad parameters, needless configuration, premature optimization, or dependencies that stdlib/existing code already covers. Over-engineering is a defect; recommend the smaller equivalent."
  - `CRAFTSMANSHIP_REVIEW_LENS` (for the P5 reviewer):
    "CRAFTSMANSHIP CHECK: flag code that reads as AI-generated or below senior-human standard — redundant/narrating comments, banner comment blocks, intent-hiding names (data2/tmp/foo), style that diverges from the surrounding code, needless abstraction, defensive boilerplate, or emoji. Recommend the idiomatic, style-matched rewrite."
- Test: the module exports all four non-empty strings, each containing its key phrases (e.g. MINIMALISM "smallest"/"YAGNI"; CRAFTSMANSHIP "senior"/"AI-slop"/"match"; the lenses "flag").

### Task 2: inject BOTH directives into code-producing steers
- Append `MINIMALISM_DIRECTIVE` + `CRAFTSMANSHIP_DIRECTIVE` (both) to the built instruction in: `src/phases/p3-plan.ts` (plan), `src/phases/p4-build.ts` (build), the **quick-gear seed** instruction (`src/host/controller.ts` `_runPhasesQuick` / its helper), `src/debug/d3-fix.ts` (D3 fix — replace its ad-hoc "minimal fix" line with the shared constants), `src/refactor/r2-transform.ts` (R2 transform).
- Tests: each built instruction `toContain` a distinctive phrase from BOTH (e.g. "YAGNI" and "senior"). Keep existing instruction-content assertions green.

### Task 3: inject BOTH review lenses into P5
- `src/phases/p5-verify.ts`: append `MINIMALISM_REVIEW_LENS` + `CRAFTSMANSHIP_REVIEW_LENS` to the clean-context reviewer instruction, so the reviewer reports over-engineering AND AI-slop/below-senior code as findings — the existing review-to-zero loop then fixes them. Do NOT add a NEW hard deterministic gate (both are subjective; would false-block) — they ride the existing review-finding path.
- Test: the P5 reviewer instruction contains both lens phrases.

## Acceptance (default-FAIL)
- Every code-producing steer (P3, P4, quick-seed, D3, R2) carries BOTH `MINIMALISM_DIRECTIVE` + `CRAFTSMANSHIP_DIRECTIVE`; P5's reviewer carries BOTH review lenses. All from the single shared `src/principles.ts` (DRY — one wording, many call sites).
- Always on (no flag). Existing instruction-content tests stay green. tsc clean; full suite green (+ new); deterministic; npm audit 0.

## Pre-mortem
1. Prompt-only isn't enough (model may ignore) → that's why the P5 review lens + review-to-zero loop is the real enforcement (catch + simplify). The directive biases; the review gates.
2. Over-aggressive minimalism could drop needed error handling / tests → the directive says "satisfies the spec AND passes the tests"; tests + spec define the floor, so it can't strip required behavior without failing P5's deterministic test gate.
3. Wording drift across call sites → single shared constant avoids it.
