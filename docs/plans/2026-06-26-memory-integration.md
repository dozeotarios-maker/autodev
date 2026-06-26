# pi-autodev Memory Integration Implementation Plan (A + B)

> **For Claude:** Build via executor subagents (Sonnet), TDD per task, then the mandated post-build review-to-zero. NO ralplan (operator-approved skip: A is mechanical against a now-known API; B is covered by careful design + the binding post-build review + the 559-test regression net).

**Goal:** Make autodev's memory layer real — fix the codebase-memory adapter to speak the actual MCP protocol (A), and make phases P1–P6 actually consume memory (B). Today the adapters are connected to the Controller but inert.

**Architecture:** Two file-disjoint lanes. Lane A rewrites only `src/memory/codebase-memory-adapter.ts` (+ its test). Lane B threads optional memory fields through `PhaseContext` and adds consumption at P1 + the retro, touching `src/phases/phase-output.ts`, `src/phases/p1-discover.ts`, `src/host/controller.ts` (+ tests). No shared files → safe to parallelize. B codes against the existing adapter *interfaces*, so it does not depend on A's implementation landing first.

**Tech stack:** TypeScript, vitest, MCP (JSON-RPC 2.0 over stdio), Letta HTTP, Gemini embeddings. Live services already up: Letta :8283, codebase-memory-mcp 0.10.0 on PATH, `GEMINI_API_KEY` in env.

**Baseline:** 32 commits on `main`, 559 tests green, tsc clean. Extension loads + arms in pi. Letta + Gemini doctor-green; codebase-mem doctor-red (this plan fixes it).

---

## Part A — codebase-memory adapter → real MCP protocol

### Live facts (probed against codebase-memory-mcp 0.10.0)
- Binary with no args = MCP server on stdio. Handshake: `initialize` → `notifications/initialized` → then `tools/call`.
- Call shape: `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}`; result returns in `result.content` (MCP content array; text payloads are JSON strings to parse).
- 14 tools. Relevant ones + their required args:
  - `index_repository` {repo_path} (+ mode, persistence) — builds/updates the graph; returns the project name.
  - `index_status` {project} — is the repo indexed.
  - `list_projects` {} — known projects (use for healthCheck + project discovery).
  - `trace_path` {function_name, project} (+ direction, depth) — **this is caller-finding** (direction toward callers).
  - `search_graph` {project} (+ query, name_pattern, relationship, semantic_query, …).
  - `get_code_snippet` {qualified_name, project}; `get_architecture` {project}; `search_code` {pattern, project}.
- There is **no** `find_callers` and **no** `health_check` — the current adapter's two fictional methods (hence RPC -32601).

### Design decisions
1. **Persistent MCP session.** The current adapter spawns the binary per RPC and sends a bare method name. Rewrite to: lazily spawn ONE long-lived child, do the `initialize` + `initialized` handshake once, then multiplex `tools/call` requests by JSON-RPC id over the kept-open stdio. Add a `close()`/dispose path. (An MCP server is meant to be initialized once and called many times; per-call spawn also loses the in-memory project context.)
2. **Project identity.** Tools need a `project`. On first use, call `index_status`/`list_projects`; if the repo isn't indexed, call `index_repository{repo_path}` and read the returned project name. Cache it on the adapter. `repo_path` = the adapter's configured repo root (constructor arg; default `process.cwd()`).
3. **`findCallers(symbol)`** → `trace_path{function_name: symbol, project, direction: <callers>, depth: 2}`. Confirm the exact `direction` enum value by reading one `tools/list` schema or a probe call; map the result content to the existing `CallerRef[]` shape. Keep the public method signature unchanged (B + tests depend on it).
4. **`healthCheck()`** → handshake + `list_projects` (or `tools/list`); `{ok:true}` if the server responds, `{ok:false, details}` on spawn/parse/timeout error. Must stay fail-conservative (no false green).
5. **Keep mock mode** (`CODEBASE_MEMORY_MOCK=1`) returning deterministic stubs so unit tests need no live binary.

### Tasks (TDD; each: write failing test → run red → implement → run green → commit)
- **A1** — MCP transport: rewrite the private `_rpc` into a persistent `initialize`+`tools/call` MCP client (handshake once, id-multiplexed, timeout, `close()`). Test with a stubbed child process asserting the handshake + `tools/call` envelope.
- **A2** — project bootstrap: `ensureIndexed()` (index_status → index_repository if needed; cache project). Test the index-once + cache path.
- **A3** — `findCallers` → `trace_path` mapping (+ result→`CallerRef[]` parse). Test against a recorded `trace_path` response fixture.
- **A4** — `healthCheck` → `list_projects`. Test ok + fail-conservative on error.
- **A5** — live smoke (NOT in vitest; a `scripts/` or manual node check): against the real binary on `/root/pi-autodev`, `healthCheck()` returns ok and `findCallers('execute')` returns ≥1 caller. Document in the task as the acceptance probe.

---

## Part B — phases consume memory

### Spec design (docs/pi-autodev-spec.md §4, §87, §311)
- **Layer A (codebase-mem):** code structure — used in **P1 DISCOVER** to ground the spec in the real repo (architecture + key symbols) before planning.
- **Layer B (Letta):** decision/fact memory — **recall** prior related decisions/conventions in P1 (and optionally P2/P3); **store** the run lesson at the retro (R5).
- **G10:** recalled/retrieved text is an injection surface — screen it through `securityLane.screenContent(..., 'repo')` before injecting into any model instruction.

### Design decisions
1. **Thread memory as OPTIONAL context fields.** Add `memoryStore?`, `embedder?`, `codebaseMemory?` to `P1Context` (and the union as needed) in `src/phases/phase-output.ts`. Optional → every existing test fixture that omits them still compiles and passes (559 stays green). Consumers use `ctx.memoryStore?.…`.
2. **Controller populates them.** The Controller already holds `opts.memoryStore/embedder/codebaseMemory` (from the wiring commit). When it builds the P1 context (controller.ts:~409), pass them through. (Start with P1 only; P2/P3 are a follow-up — YAGNI.)
3. **Consumption (minimal, high-value):**
   - **P1 DISCOVER** — before building the P1 instruction: (a) `codebaseMemory.ensureIndexed()` + a cheap structural pull (`get_architecture` or a `search_graph` summary) to ground the spec; (b) `memoryStore.recall(idea, 3)` for prior related decisions. Screen both via `securityLane.screenContent`. Cap total injected memory (e.g. ≤1500 chars). Inject the screened, capped block into the P1 instruction. All guarded by `?.` + try/catch → if memory is absent or a backend is down, P1 proceeds exactly as today (degrade, never hard-fail).
   - **Retro (controller, after P6 success AND on halt/escalate)** — in addition to the existing `RetroWriter` file write, call `memoryStore.store(runId, lesson, {tier, outcome})` so the lesson is semantically recallable next run. Guard with `?.` + try/catch.
4. **Token budget + safety:** top-3 recall, truncate each hit, hard char cap on the injected block. Never inject unscreened content.
5. **No hard dependency:** memory is strictly additive; a run with all backends down behaves like today.

### Tasks (TDD)
- **B1** — context fields: add optional `memoryStore?/embedder?/codebaseMemory?` to `P1Context` (+ the `PhaseContext` union if needed). Test: existing P1 fixtures still typecheck; a fixture WITH memory is accepted.
- **B2** — controller passes memory into the P1 context. Test (mock pi + mock adapters): P1 receives the adapters.
- **B3** — P1 recall + ground + screen + cap + inject. Test: with a mock memoryStore returning a hit and a mock securityLane, P1's instruction contains the screened hit; with `screenContent` flagging it unsafe, the hit is dropped; with memory undefined, P1 instruction is unchanged from baseline.
- **B4** — retro → Letta store on success and on halt. Test (mock RetroWriter + mock memoryStore): `store` called once per terminal path with the run summary; absence of memoryStore does not throw.
- **B5** — degrade test: a backend `healthCheck`/`recall` that throws does not break P1 or the run (caught, logged, proceed).
- **B6** — live round-trip (manual/script, not vitest): `store` a lesson to real Letta, `recall` it back in a fresh adapter; assert the value returns. Document as acceptance probe.

---

## Acceptance (default-FAIL — all must hold)
- **A:** adapter speaks MCP (`initialize`+`tools/call`); `findCallers` returns real callers on the indexed `/root/pi-autodev`; `healthCheck` green via `list_projects`. **Live `/autodev-doctor` shows `codebase-memory: OK`.**
- **B:** P1 recalls + screens + injects memory (verified on mock + one live round-trip); retro stores to Letta on success and halt; phases degrade cleanly when memory is absent/down.
- **Global:** `npx tsc --noEmit` clean, `npx vitest run` ≥559 green, `npm audit` 0. No file touched by both lanes.

## Pre-mortem (short)
1. **MCP handshake/`direction` enum guessed wrong** → A3 fails on the live probe. *Mitigation:* A1 + A5 probe the real binary; the executor reads one `tools/list` schema before mapping, not from memory.
2. **Recalled-content injection** (G10) — recalled memory could carry a prompt-injection payload. *Mitigation:* mandatory `screenContent` gate in B3 with a drop-on-flag test.
3. **Breaking the 559 green** — adding required context fields would break fixtures. *Mitigation:* fields are OPTIONAL; B1 test asserts old fixtures still pass.

## Lane split (build)
- **Lane A** (1 executor): A1→A5 on `src/memory/codebase-memory-adapter.ts` + test.
- **Lane B** (1 executor): B1→B6 on `phase-output.ts`, `p1-discover.ts`, `controller.ts`, retro + tests.
- Disjoint files → run concurrently. Each lane keeps the suite green on its own commits.

## Rigor follow-up (operator principle — NOT in this plan)
autodev already throttles review rigor by task risk via the complexity scorer (novelty+blast+irreversibility → tier → panel/rounds; XS skips the panel). Candidate upgrade: replace the keyword/word-count scorer heuristic with an LLM judgment ("mechanical vs novel/risky") so autodev decides when to engage the senior-dev panel as deliberately as we just skipped ralplan. Track separately.
