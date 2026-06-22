---
name: P2 Elaborate
phase: P2
trigger: on_phase_enter
---

# P2 — ELABORATE

Domain model, persona debate, and convention extraction. No code yet.

## Steps

1. **Domain model**: extract entities, relationships, and invariants from `P1-spec.md`.
   Write to `.autodev/domain-model.md`.

2. **Personas debate**: run the senior panel (top-N personas per complexity tier) in parallel.
   Each reads `P1-spec.md` and raises objections against the proposed approach.
   Feed panel output to Critic agent → aggregated objections.

3. **Convention extraction (brownfield)**: if the repo has existing code, extract the local idiom:
   - Naming conventions (camelCase, snake_case, file naming patterns)
   - Error handling style (Result types, throw/catch patterns)
   - Import style (named vs default, path aliases)
   - Test patterns (describe/it, beforeEach setup patterns)
   Write to `.autodev/style-contract.md` — lanes obey this during P4 BUILD.

4. **Spec update**: fold persona insights and domain model into `P1-spec.md` → produce `P2-spec.md`.
   Address or explicitly accept each persona objection.

## Evidence artifacts (H1 contract)

- `domain-model.md` created.
- `style-contract.md` created (or `style-contract-not-applicable.md` for greenfield).
- `P2-spec.md` created with all P2 objections addressed.

## Anti-patterns

- Do not skip the persona debate — the spec is not ready until objections are surfaced and addressed.
- Do not start P3 with unresolved blocking objections from personas.
- Do not ignore the style contract — local idiom drift is a maintainability violation.
