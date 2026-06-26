# pi-autodev Project-Dir Resolver + Registry — Implementation Plan

> **For Claude:** Real architectural feature exposed by the live run (autodev built into `/root`). Build via executor lanes, TDD, then post-build review-to-zero. No ralplan (design nailed below; the post-build adversarial review is the gate).

**Goal:** autodev resolves WHERE to build from a memory-backed project registry — never pollutes `$HOME`, no manual `cd`, existing codebases are "known", and all build output is **confined** to the resolved dir.

**Root cause this fixes:** `repoRoot` is hardwired to `process.cwd()` (controller entry), and the host writes code at cwd-relative paths (P4 `artifacts: '<relative path>'`). So when pi launched in `/root`, autodev built into `/root`. `repoRoot` is *already* the single abstraction for `.autodev` + the action-monitor boundary (controller.ts:153-157) — we just need it to be the **resolved** dir and confine writes to it.

**Tech stack:** existing. Registry persists to the global plane (`~/.pi/autodev/global/projects.json`) + Letta. codebase-memory (Layer A) for existing-codebase indexing.

---

## Design (the decisions)

### Resolution order (on ARMED→RUNNING, before P1)
```
1. cwd is a registered project (in the registry)  -> use it
2. cwd is a real repo (git root OR has package.json) -> EXISTING codebase:
       register {name, dir} + index with codebase-memory; use it
3. an active project is set (/autodev-project <name>) -> use its registered dir
4. else (junk cwd, e.g. $HOME / no project)        -> NEW project:
       create ~/autodev/<slug-of-idea>/, register it, use it
GUARDRAIL: resolved dir is NEVER os.homedir() itself, and never a parent of it.
           If resolution would yield $HOME, fall through to step 4 (scoped subdir).
```
`repoRoot := resolvedDir` (replaces `process.cwd()`). All `.autodev`, journal, action-monitor boundary, phases inherit it automatically.

### Write confinement (deterministic — NOT LLM-trust)
The host writes via pi's tools (cwd-relative). To force output into `repoRoot ≠ cwd`:
- **Backstop (deterministic):** wire `ActionMonitor.checkFileWrite` into the `tool_call` handler for write/edit tools — reject any write whose resolved absolute path is outside `repoRoot`. `allowedPaths` is already `[repoRoot]` (controller.ts:154). This makes pollution of `cwd ≠ repoRoot` **impossible**, regardless of what the LLM does.
- **Steer (cooperative):** P4/P5/P6 instructions tell the host to write all files under `<repoRoot>` (absolute) and prefix bash with `cd <repoRoot> &&` (so `npm install`/tests run in the project, not cwd).
- subagent-driver + lane git ops: replace `process.cwd()` (subagent-driver.ts:55) with the injected `repoRoot`.

### Identity (most reliable)
cwd-match + explicit `/autodev-project <name>` switch (persisted active project). **NOT** semantic recall for the write-target — a mis-routed write into the wrong repo is catastrophic; determinism wins. (Recall stays for pulling *context* only.)

---

## Tasks (TDD)

### Lane R — Registry + resolver (src/project/*)
- **R1** `src/project/registry.ts`: `ProjectRegistry` — load/save `{ projects: {name: {dir, stack?, lastRun?}}, active?: string }` to `~/.pi/autodev/global/projects.json` (atomic write, O_EXCL lock like effect-ledger). Methods: `get(name)`, `register(name, dir)`, `setActive(name)`, `findByDir(dir)`, `list()`. Mock-friendly (inject base path). Tests: register/recall/active/persistence round-trip.
- **R2** `src/project/resolver.ts`: `resolveProjectDir(cwd, idea, registry): { dir, name, isNew, isExisting }` implementing the 4-step order + the `$HOME` guardrail. `isGitRepo(dir)` / `hasPackageJson(dir)` helpers. Slug from idea (lowercase, alnum+hyphen, short hash). Tests: each step; cwd=$HOME → step 4 scoped subdir; cwd=git-repo → existing; registered cwd → recall.

### Lane W — Write confinement + repoRoot threading
- **W1** controller entry/wiring: replace `repoRoot = process.cwd()` with `repoRoot = resolveProjectDir(...).dir`, computed at ARMED→RUNNING (resolver needs the idea). Until the idea arrives, default `repoRoot=process.cwd()` for arming/doctor; re-root at run start. Register the project. Tests: mock resolver → controller adopts the resolved repoRoot for the run.
- **W2** `_onToolCall` (controller.ts:325): for write/edit tools (tool name in {write, edit, create_file, ...}), call `actionMonitor.checkFileWrite(absPath)`; if blocked, deny the tool call (return a deny result) + journal it. Tests: a write outside repoRoot is denied; inside is allowed; `$HOME` write denied.
- **W3** P4/P5/P6 instructions (`buildP*Instruction`): root all produced-file paths + bash at `ctx.repoRoot` (absolute); add "write ONLY under `<repoRoot>`; prefix shell with `cd <repoRoot> &&`". Thread `repoRoot` onto the relevant `P*Context`. subagent-driver.ts:55 `process.cwd()` → injected repoRoot. Tests: instruction contains the absolute repoRoot root + cd prefix; degrade if repoRoot is cwd (unchanged behavior).

### Lane C — Commands + existing-codebase indexing
- **C1** `/autodev-project` command (controller.registerCommands): `<name>` sets active + registers cwd if new; no arg → list registered projects + active + dirs. Tests: set/list/switch.
- **C2** existing-codebase indexing: when resolver hits step 2 (existing repo), call `codebaseMemory.ensureIndexed()` (already exists post-MCP-fix) so the graph maps the structure. Guarded (degrade if codebase-mem down). `/autodev-status` shows resolved project + dir. Tests (mock codebaseMemory): ensureIndexed called on an existing-repo resolve; not called for a fresh new-project dir.

## Acceptance (default-FAIL)
- Resolver returns the right dir for all 4 cases; **never `$HOME`**.
- Write confinement: a build CANNOT write outside repoRoot (action-monitor denies it) — proven by a test firing a write to `$HOME` and asserting denial.
- repoRoot = resolved dir flows to `.autodev` + instructions + subagent git.
- Registry persists + recalls across (simulated) sessions; `/autodev-project` lists/switches.
- Existing repo → codebase-mem indexed.
- `tsc` clean; full suite green (+ new tests); npm audit 0.

## Pre-mortem
1. **chdir vs confine** — we do NOT `process.chdir` (would surprise pi). Confinement via the action-monitor backstop + steered absolute paths is deterministic for *writes*; bash cwd is handled by the steered `cd` prefix. Risk: a host bash that ignores the cd prefix runs in cwd — mitigated by the write-confinement backstop (file writes still blocked) + a P5 verify that runs tests under repoRoot.
2. **Re-rooting timing** — repoRoot must be resolved BEFORE P1 writes `.autodev`. Resolve at ARMED→RUNNING using the idea; arming/doctor before that use cwd (read-only, safe).
3. **Existing tests assume repoRoot=cwd** — keep the default (no registry / cwd is a repo) resolving to cwd so current fixtures stay green; only junk-cwd diverges.

## Lane split (build)
- Lane R (registry+resolver, new files) ∥ Lane C (commands+indexing) — disjoint.
- Lane W (confinement + repoRoot threading: controller, p4/p5/p6, subagent-driver) — depends on R's resolver interface; code against the R interface, integrate after.
