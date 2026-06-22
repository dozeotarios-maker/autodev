---
name: P1 Discover
phase: P1
trigger: on_phase_enter
---

# P1 — DISCOVER

Transform the raw user idea into a fully-researched, stack-picked spec ready for P2 ELABORATE.

## Steps

1. **Web-research first**: for anything touching an external dep, API, framework, or algorithm — query
   the current best-practice and latest-stable version via pi-web-access. Never build on memorized knowledge.
   Route fetched content through G10 guardrails (web is an injection surface).
   Cache to `.autodev/research/` and the global plane so lanes reuse, not re-fetch.

2. **Stack pick**: auto-detect language and framework from the repo; confirm or override via StackSelector agent.
   Write stack ADR to `.autodev/stack-adr.md` with rationale and G21-vetted dep list.

3. **Spec write**: produce `P1-spec.md` in `.autodev/` covering:
   - Problem statement (user's words, verbatim)
   - Constraints and non-goals
   - External dep list with pinned versions (D2 verified)
   - Open questions (feed H7 ambiguity gate)

4. **H7 ambiguity gate**: if the idea has multiple valid interpretations whose builds would diverge,
   surface ONE batched clarifying question before proceeding to P2. Do not proceed until answered.

5. **Complexity score**: invoke ComplexityScorer to produce `complexity.json`.

## Evidence artifacts (H1 contract)

- `P1-spec.md` created and readable.
- `stack-adr.md` created with G21 vet results.
- `complexity.json` present.
- No open ambiguity questions unresolved.

## Anti-patterns

- Do not skip web-research for any external dep — stale knowledge causes G12/G14 violations.
- Do not start P2 while H7 ambiguity is unresolved.
- Do not write the spec from model memory alone.
