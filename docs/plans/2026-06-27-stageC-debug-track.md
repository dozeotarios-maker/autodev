# Stage C — Debug Track (D1–D5) — REVISED after critic gate (split into C-0 + C-1)

> **For Claude:** Architect+critic review found the original plan asserted APIs that don't exist (same B3-class defect). It is split into **C-0 (foundation)** and **C-1 (the debug track)**. Build C-0 first, reviewed-to-zero, then C-1. See `2026-06-27-gears-and-tracks.md`.

## What the critic gate corrected (read first)
The original plan rested on three false "reuse X" claims, verified against source:
- **`verifier.runDeterministic` cannot run an arbitrary repro command.** `DeterministicVerifier.run` (`src/verify/deterministic.ts:10`) enforces a hard `ALLOWED_BINARIES` allowlist (`npm,npx,vitest,jest,node,pnpm,yarn,true`) and **rejects (throws)** anything else; naive `split(' ')` breaks quoted/spaced args. A `bash repro.sh` / `python` / `./repro.sh` repro is rejected before running.
- **No timeout anywhere in the exec path** (`deterministic.ts` has zero `setTimeout`/`kill`/`AbortSignal`). A hanging repro hangs the controller forever — re-introducing the exact A1 unbounded-hang that already killed a live run.
- **`codebaseMemory.trace_path` does not exist.** The only public method is `findCallers(symbol)`, and the controller's injected `codebaseMemory` type (`controller.ts:175-180`) exposes only `healthCheck/ensureIndexed/setRepoRoot` — not even `findCallers`.
- Anti-cheat had **no changed-files source** (relied on host self-reported `filesChanged` — bypassable). "Reuse P6 release" would commit `.autodev/phase-output/` (P6Release hardcodes that), not the fix. `checkBashCommand` only fires on the host's `tool_call` event, never on a controller-run command.

Goal unchanged: `debug:` runs a disciplined D1→D5 track — **no fix without a confirmed-red repro; no "fixed" without repro-green AND suite-green** — but built on real, safe primitives.

---

# Stage C-0 — Foundation (build + review-to-zero FIRST)

These are cross-cutting capabilities (ports + extension wiring + every controller-test mock). Land them alone so the debug track builds on something real.

### Task 0.1 — `BoundedExec` port (the untrusted-repro runner)
- `src/ports.ts`: `interface BoundedExec { run(cmd: string, cwd: string, opts: { timeoutMs: number }): Promise<{ passed: boolean; exitCode: number | null; output: string; timedOut: boolean; blocked: boolean }> }`.
- Impl (`src/verify/bounded-exec.ts`): (1) call `actionMonitor.checkBashCommand(cmd)` FIRST → if `!allowed` return `{blocked:true, passed:false, …}`; (2) `spawn(cmd, { cwd, shell:true, detached:true })` so arbitrary interpreters/pipelines work; (3) enforce `timeoutMs` — on expiry `process.kill(-child.pid, 'SIGKILL')` (kill the process group so vitest/node subprocesses die too) and resolve `{timedOut:true, passed:false}`; (4) `passed = exitCode === 0 && !timedOut && !blocked`. Capture combined stdout+stderr (cap length).
- Wire into `src/extension/index.ts` (construct with the real action-monitor); inject via `ControllerOptions.boundedExec?`. Add a null/mock to EVERY controller test helper (`makeNull*` / the inline option objects) so existing tests compile — default mock returns `{passed:false, blocked:false, timedOut:false, exitCode:1, output:''}` or is omitted (optional).
- Tests: a `node -e 'process.exit(0)'` → passed; `node -e 'process.exit(1)'` → not passed; a sleep/`while true` style command → timedOut after a short `timeoutMs` AND the child is actually killed (no lingering process); a command that `checkBashCommand` blocks (e.g. writes outside repoRoot / hits PROTECTED_PATHS) → `blocked:true`, not executed. Bound every test's `timeoutMs` small (e.g. 1000ms) so the suite stays fast.

### Task 0.2 — `gitOps.changedFiles(cwd)` (deterministic anti-cheat source)
- Add to the GitOps port + impl: `changedFiles(cwd: string): Promise<string[]>` = union of `git diff --name-only` (unstaged) + `git diff --name-only --staged`, repo-relative paths. Add to mocks (`makeNullGitOps` → returns `[]` or a settable value).
- Tests: returns the modified set; empty on a clean tree.

### Task 0.3 — Widen `ControllerOptions.codebaseMemory` to expose `findCallers`
- Add `findCallers?(symbol: string): Promise<Array<{ file: string; symbol: string }>>` to the injected `codebaseMemory` option type (`controller.ts:175-180`). The concrete `CodebaseMemoryAdapter` already implements it (`codebase-memory-adapter.ts:525`). Degrade gracefully (optional; D2 tolerates absence/throw). Mocks updated.
- Test: the controller can call `this.opts.codebaseMemory?.findCallers?.(sym)` when present; absent → undefined.

### C-0 acceptance
- BoundedExec runs a command with a real timeout (kills the process group) + checkBashCommand pre-flight (blocked commands never exec); `changedFiles` returns git diff; `codebaseMemory.findCallers` reachable through the injected type. All existing tests green (additive ports + optional options). tsc clean; deterministic; npm audit 0.

---

# Stage C-1 — Debug Track (build AFTER C-0 converges)

### D1 — Reproduce (discipline gate, on real primitives)
- Steer: "Write a NEW DEDICATED repro file (a vitest test at a fresh path — do NOT edit an existing test) that fails, demonstrating the reported bug. Output `{ reproSummary, reproCommand, reproArtifact }` where reproCommand is `npx vitest run <reproArtifact>` (vitest only) and reproArtifact is the new file path." Task-1 validator REJECTS a reproCommand whose first token ∉ ALLOWED_BINARIES and a reproArtifact that is an existing file (must be new).
- **Gate (deterministic, BoundedExec, timeout):** run reproCommand **3×**; require **consistent RED** (fails all 3). Distinguish a true assertion failure from an import/collection error by inspecting `output` (a setup/import error → escalate "repro harness broken", NOT "reproduced"). If consistently red → proceed. If green (any run passes) or flaky → `_operatorBrief('D1', 'could not reproduce consistently — repro green or flaky')` and stop. **No fix without a stable repro.**
- **Faithfulness judge:** a clean-context `Judge` (reuse the P5 reviewer-subagent pattern) receives the bug report + the repro and rules "does this repro demonstrate the reported symptom?" If no → escalate. (Defends against a trivially-weak repro.)
- Snapshot the repro artifact's content hash at end-of-D1 (for the D3/D4 anti-cheat).

### D2 — Root-cause (competing hypotheses + findCallers)
- Extract candidate symbols from the repro output; call `codebaseMemory.findCallers(symbol)` (when available) to get inbound callers; provide to the steer. Steer demands ≥2 competing hypotheses (claim + evidence-for + evidence-against) and a selected rootCause + rootCauseLocation. Degrade to host-only reasoning if findCallers absent/throws (still require ≥2 hypotheses).

### D3 — Fix (deterministic anti-cheat)
- Steer: implement the minimal fix for rootCause; do NOT edit the repro file.
- **Anti-cheat (deterministic, not host self-report):** after the steer, compute `gitOps.changedFiles(repoRoot)`; assert the **repro artifact is NOT in the changed set** AND its **content hash equals the D1 snapshot** (the repro was not weakened). If violated → escalate "repro was modified during fix".

### D4 — Verify (repro-green + suite-green, stable)
- Re-run reproCommand via BoundedExec **3×** → require consistent **GREEN**. Run the full suite via `verifier.runDeterministic('npx vitest run', repoRoot)` → **GREEN**. Both required.
- If repro still red, flaky, OR suite regressed → loop back to D2/D3, capped `MAX_DEBUG_ROUNDS = 3`. On cap → `_operatorBrief('D4', …)` with accumulated evidence.

### D5 — Ship
- `gitOps.scopedCommit(message, allowedPaths)` (the PORT, not the P6Release class) with `allowedPaths = [...D3.changedFiles, D1.reproArtifact]` (commit the fix AND the repro test). Derived message from rootCause+fixSummary. Secrets scan + push. Decide tierDGate: SKIP for debug v1 (consistent with silent-execution; a bugfix auto-commits) — document it.

### C-1 controller wiring
- Replace the B2 `debug:` router stub (`_escalate('ROUTER', 'debug track not yet implemented…')`) with `await this._runDebugTrack(ctx)`. Own linear D-counter (NOT the P1-P6 FSM — keep independent, mirrors the gear methods; the in-code warning at controller.ts:1845 confirms reusing the FSM pollutes backedgeCount). Full lifecycle bookends (try/catch → escalate → release+restoreCwd; success → retro+store+release+restoreCwd). Per-run state reset.
- **Debug runs are NOT resurrectable in v1** (resurrection.ts assumes P-phase vocabulary) — journal the D-steps for post-mortem, but a crashed debug run restarts from a fresh repro. State this explicitly.

### Tests to UPDATE (legitimate changes, NOT regressions)
- `tests/host/controller-b2-gears.test.ts`: the `debug: → escalates with stub` test (asserts 'debug track not yet implemented' + sendUserMessage NOT called) and the run-id test asserting the same stub string — these MUST change to assert the new debug-track behavior (the stub is being replaced). The `task-type: debug` journal test likely survives — verify. List these so they aren't mistaken for regressions.

### C-1 acceptance
- `debug:` runs D1→D5; D1 gates on a consistently-red NEW repro file + faithfulness; D3 anti-cheat via git changedFiles + hash (not host self-report); D4 requires stable repro-green + suite-green; D5 commits fix+repro via gitOps.scopedCommit. Lock released on every terminal path. Build pipeline P1-P6 tests pass untouched; the B2 debug-stub tests are intentionally replaced. tsc clean; full suite green; deterministic (10x, B1 teardown-settle); npm audit 0.

## Consolidated pre-mortem
1. Repro flakiness → run 3× require consistent red/green (D1/D4). 2. Hang → BoundedExec timeout kills the process group. 3. Destructive repro → checkBashCommand pre-flight + repoRoot cwd + ALLOWED-binary (vitest-only) constraint; residual in-process risk acknowledged. 4. Import-error vs assertion-failure → inspect output at D1. 5. Weak/overfit repro → faithfulness judge + suite-green backstop (residual accepted v1). 6. Anti-cheat → git changedFiles + content-hash, deterministic. 7. codebase-mem down → degrade to host-only, still ≥2 hypotheses. 8. Non-vitest target project → v1 assumes vitest; detect-or-document. 9. Crash mid-debug → non-resumable v1, journalled.

## Out of scope
- Refactor track (the third task-type). Debug-track gears (single-depth full methodology in v1). Resumable debug runs.
