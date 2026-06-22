---
name: P4 Build
phase: P4
trigger: on_phase_enter
---

# P4 — BUILD

Parallel file-DAG lanes, TDD-first, single integrator, journal/checkpoint, crash-safe.

## Steps

1. **Lane dispatch**: dispatch lanes per `P3-plan.md` file-DAG. Each lane runs in a pi-subagents
   worktree (worktree:true, PI_SUBAGENT_MAX_DEPTH=1). Lane brief: task IDs owned + file allowlist.

2. **TDD-first per lane**: Executor agent, within each lane:
   - Write the failing test FIRST.
   - Watch it fail (run test suite, confirm red).
   - Implement to green.
   - Non-testable work (pure config, scaffolding) is exempt but must name why.

3. **Journal + checkpoint**: every action journaled to `.autodev/journal.jsonl` BEFORE execution.
   Checkpoint written to `.autodev/checkpoint.yaml` AFTER each completed step.

4. **G18 contract registry**: any lane mutating a shared boundary (type, interface, public symbol)
   publishes to ContractRegistry before merge — not after.

5. **Integrator reconciles**: after all lanes complete, Integrator agent reconciles outputs,
   applies R2 filter on Reviewer findings, runs smoke gate, wires port concretes (D4).

6. **H9 still-right judge**: periodically re-anchor active trajectory to frozen P1 spec + G15 examples.
   If diff materially diverges from P3 plan → backedge P4→P3 to re-plan.

## Evidence artifacts (H1 contract)

- All lane test suites green.
- Journal entries for every action (pre-action writes).
- Checkpoint current (post-step writes).
- G18 registry entries for any shared-boundary changes.
- Smoke gate passed.
- H9 check: trajectory aligned with P1 spec.

## Anti-patterns

- Do not implement before writing the failing test.
- Do not write files outside the lane's allowlist.
- Do not swallow exceptions on user paths (G11).
- Do not commit placeholder/TODO code (G12).
- Do not merge a lane that failed its smoke gate.
