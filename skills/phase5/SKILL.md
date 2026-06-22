---
name: P5 Verify
phase: P5
trigger: on_phase_enter
---

# P5 — VERIFY

Deterministic verify + holdout + mutation + humanizer + review-to-zero + security-lane.

## Steps

1. **Deterministic verify (G8)**: artifacts exist, tests ran via exit code, programmatic.
   Never LLM-judges-own-trace.

2. **Holdout tests (G1/G15)**: Tester agent runs holdout tests derived from `examples-table.md`.
   Test-tree edit-detection: if Executor modified holdout files → reward-hacking flag.

3. **Mutation gate**: StrykerJS 9.6.1, threshold configurable in `cockpit/autodev.yaml` (default 80%).
   Score < threshold → fail P5.

4. **Clean-context LLM judge (EvilGenie)**: a fresh LLM context, sees diff only, judges for reward-hacking.
   Outperforms holdout tests alone at catching gaming behaviour.

5. **Humanizer slop pass**: AI-SLOP Detector 3.8.6 + LLM critic on prose. Findings folded into review.

6. **Review-to-zero (R1/R2)**: Reviewer sees diff only (clean context, R1). Integrator applies R2 filter.
   Drive CRITICAL/HIGH to zero (cap 5 rounds). AUTO-FILE LOW/MED as tracked issues (release-triage).

7. **G19 blast-radius**: enumerate callers before any breaking change via Layer-A graph.

8. **G23 concurrency lens**: flag races, deadlocks, non-atomic RMW.

9. **G24 security-lane (clean context)**: Security persona as a clean-context reviewer — diff only,
   repo content treated as untrusted. Credential-isolation scan.

10. **G16 UI grounding** (gated on UI-in-diff): Playwright MCP opens running app, takes screenshot.
    Screenshot is required evidence in H1 contract.

## Evidence artifacts (H1 contract)

- Deterministic test run exit code 0.
- Holdout: pass. Test-tree edit: clean.
- Mutation score ≥ threshold.
- LLM judge: pass.
- Review: zero CRITICAL/HIGH.
- LOW/MED issues filed.
- Security-lane: clean.
- Screenshot (if UI-in-diff).

## Anti-patterns

- Do not accept "tests pass" as sufficient — mutation gate and LLM judge are required.
- Do not let the builder self-judge (G5, G8).
- Do not skip the security-lane for any diff.
