---
name: P3 Plan
phase: P3
trigger: on_phase_enter
---

# P3 — PLAN

Scope → slice → plan → panel evaluates → re-plan until 0 objections → sprint contracts.

## Steps

1. **File-DAG**: Planner agent decomposes `P2-spec.md` into a file-touch DAG.
   Each task lists: files modified, dependencies, lane assignment.
   Constraint: no two lanes write the same file. Cap: 5 lanes.
   Write to `.autodev/P3-plan.md`.

2. **Examples table (G15)**: for each feature, write an examples table (input → expected output)
   encoding the business rules. This table drives holdout tests in P5; must be present before BUILD.

3. **Sprint contracts (H6)**: for each feature, write a per-feature done-definition to
   `.autodev/sprint-contracts/<feature>.md`. The H1 gate enforces these — a feature cannot be
   marked complete without its sprint contract criterion being satisfied.

4. **H8 scope-preview (L/XL tiers)**: emit a projected estimate: file count, lane count, wall-clock time.
   Operator must confirm go/no-go for L/XL complexity tiers before P4 starts.

5. **Panel review**: all personas review `P3-plan.md` in parallel. Critic aggregates → re-plan loop
   until 0 blocking objections (cap 3 rounds). Panel sign-off gates P4 BUILD.

## Evidence artifacts (H1 contract)

- `P3-plan.md` with file-DAG and lane assignments.
- `examples-table.md` with input/output pairs per feature.
- Sprint contract files for every feature.
- Panel verdict: zero blocking objections.
- H8 go/no-go confirmed (L/XL tiers only).

## Anti-patterns

- Do not start P4 without panel sign-off.
- Do not skip the examples table — G15 has no fallback.
- Do not assign the same file to two lanes.
- Do not omit sprint contracts — H1 gate will block completion.
