# pi-autodev Control-Loop Fix — Implementation Plan

> **For Claude:** Foundation fix exposed by the first live run. Build via executor, TDD, then post-build review. No ralplan (concrete, diagnosed bugs with exact fixes).

**Goal:** Make the steer-and-observe loop survive a real pi session so P1→P6 runs without tangling. The first live run stalled after P1 because autodev mistook its own steer messages for user input.

**Root cause (confirmed live + in code):** `HostAgent.steer` drives the host via `pi.sendUserMessage(...)`. pi echoes that text back through the `input` event with `source: "extension"`. `Controller._onInput` (src/host/controller.ts:277) has **no source check** — the steer text ("## Role: Discovery Agent (P1)…") passes the `isIdea` heuristic (line 281) and starts a bogus run on autodev's own steer → "Already RUNNING" spam → escalate. The 607 mock-based tests never echoed steers back, so this was invisible.

**Key fact:** pi's `InputEvent.source: InputSource = "interactive" | "rpc" | "extension"`. Genuine user ideas are `"interactive"` (TUI) or `"rpc"` (print/API). Self-injected steers are `"extension"`.

**Tech stack:** existing. No new deps.

---

## Fix 1 — filter self-originated steers (CRITICAL)
**File:** `src/host/controller.ts` `_onInput` (line 277).
- At the very top of `_onInput`, before the `isIdea` check: if `e.source === 'extension'`, log `"input ignored (self-steer, source=extension)"` and `return`. These are autodev's own `sendUserMessage` steers — the host LLM acts on them; the controller observes the result via `agent_end`, NOT via `input`.
- This eliminates the bogus-run + "Already RUNNING" tangle entirely (bug #3 is subsumed).

## Fix 2 — tolerate "nothing to compact" (MEDIUM)
**File:** `src/host/controller.ts` `compactAsync` (line ~55).
- `ctx.compact({ onError })` rejects with `Error: Nothing to compact (session too small)` on a small session at a phase boundary → `_runPhases` catches it → `ESCALATE [P1]: Unexpected error: Nothing to compact`. A benign "nothing to compact" must NOT halt the run.
- In the `onError` callback, if the error message matches `/nothing to compact|too small/i`, `resolve()` (skip compaction) instead of `reject()`. Real compaction failures still reject.

## Fix 3 — run-lock robustness (subsumed by Fix 1)
- With self-steers filtered, only genuine user ideas (`interactive`/`rpc`) reach the run-lock. Verify the escalate→ARMED path still accepts a fresh user idea afterward (no stuck lock). Covered by a test.

---

## Tests (these reproduce the LIVE bug the mocks missed)
**File:** `tests/host/controller.test.ts`
1. **Self-steer ignored:** fire `_onInput` with `{ type:'input', text:'## Role: Discovery Agent (P1) …', source:'extension' }` → assert NO `ARMED→RUNNING`, no `lifecycle.run` call, controller stays in its current state.
2. **Real idea runs:** `{ text:'add a slugify function …', source:'interactive' }` → assert it DOES start a run.
3. **rpc idea runs:** same with `source:'rpc'` → starts a run.
4. **Compaction skip:** `compactAsync` with a mock ctx whose `compact` invokes `onError(new Error('Nothing to compact (session too small)'))` → assert the promise RESOLVES (not rejects). A different error still rejects.
5. **Lock frees after escalate:** after a run escalates back to ARMED, a fresh `interactive` idea starts a new run.

## Acceptance (default-FAIL)
- `_onInput` ignores `source:'extension'`; accepts `interactive`/`rpc`. `compactAsync` resolves on "nothing to compact". Existing suite stays green; +5 regression tests. `tsc` clean.
- **Note:** a live end-to-end P1→P6 is gated on the model billing wall (operator must add usage) — these unit tests are the verification that the loop bug is fixed, since they reproduce the exact echo-back the live run hit.

## Out of scope (the long-horizon roadmap, separate)
context-mgmt depth, error-recovery/resurrection hardening, parallel-lane scale, iterative re-planning, budget — tracked for after the loop is proven.
