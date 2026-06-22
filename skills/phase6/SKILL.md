---
name: P6 Release
phase: P6
trigger: on_phase_enter
---

# P6 — RELEASE

Scoped commit → tier-D gate → per-phase push → retro → done.

## Steps

1. **Scoped commit**: GitOps.scopedCommit stages ONLY the allowlisted paths from `P3-plan.md`.
   Never stages secrets or files outside the build scope. gitleaks backstop (v8.30.1) blocks staged secrets.

2. **Tier-D gate**: if the action is push-main / migration / prod-write / mass-delete:
   - Emit H10 brief: change, rationale, risk, rollback path.
   - Block until operator async-approve.
   - G20 ledger: record the effect pre-execute so crash-resurrection never double-fires.

3. **Per-phase push**: GitOps.perPhasePush only when HEAD is on the target branch.
   G22: egress only to the configured remote — no other endpoints.

4. **R5 retro**: extract recurring bug-patterns and wrong conventions from this run.
   Write generalizable lessons to `~/.pi/autodev/global/retro-<date>.md`.
   Makes the "self-improving" claim concrete.

5. **Activity log**: final entry in `.autodev/activity.log` — done/not-done report, commit SHA,
   all criteria true in H1 contract.

6. **H1 contract**: confirm all criteria are `true`. allPassed() must return true.
   If any criterion is false → fail P6, surface what's missing.

## Evidence artifacts (H1 contract)

- Scoped commit SHA (only allowlisted paths staged).
- gitleaks scan: clean.
- Tier-D approval (if applicable).
- G20 ledger entries for external effects.
- Push succeeded to configured remote only.
- Retro file written to global plane.
- H1 contract: allPassed() = true.

## Anti-patterns

- Do not push before gitleaks scan.
- Do not skip the tier-D gate for push-main or migrations.
- Do not skip the retro — it's how the system improves across runs.
- Do not mark done while any H1 criterion is false.
