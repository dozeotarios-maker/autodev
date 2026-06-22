# pi-autodev — Stage-0 Research Findings (2026-06-22)

Four parallel deep-research passes (read-only, web-cited) run before Stage-1 planning, per the
web-currency rule. Every claim below carries a source. Confidence is noted where it matters.
This file is the cache: do not re-fetch these unless stale.

Missions: A = pi runtime/extension API · B = memory stack · D = harness/failure-pattern currency ·
E = build/verify/safety tooling. (Mission C, cost/routing, was dropped — LLM cost is not a factor.)

---

## A. pi runtime + extension API — VERDICT: foundation solid, 5 build-critical fixes

CONFIRMED:
- pi is published by **Earendil Inc.** (creator Mario Zechner). npm: `@earendil-works/pi-coding-agent`.
  GitHub: github.com/earendil-works/pi. **v0.79.9 IS the latest** (June 2026); no breaking
  extension-API changes since. The spec's version pin is correct.
- All §2 events confirmed via the raw extensions.md docs (session_start, agent_end, turn_end, context,
  tool_call, tool_result, tool_execution_end, before_provider_request, session_compact,
  session_shutdown, input). session_start reasons: startup|reload|new|resume|fork.
- All §2 methods confirmed (registerTool/Command/Provider/Flag/Shortcut, sendUserMessage, sendMessage,
  appendEntry, setModel, setThinkingLevel, exec, on).
- All §2 types confirmed (ExtensionAPI, Extension, ExtensionContext, ProviderConfig, ProviderModelConfig).
- `sendUserMessage(deliverAs:"followUp")` confirmed — queues after the agent finishes all tools;
  `"steer"` interrupts after the current tool. This is the self-prompt mechanism §5 relies on.
- `pi-claude-bridge` confirmed (github.com/elidickinson/pi-claude-bridge): serves
  claude-bridge/claude-opus-4-8 (1M context configurable, strongest model), 4-7, 4-6, sonnet-4-6,
  haiku-4-5. Aligns with best-model-everywhere.
- Source of truth for the API: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
  and packages/coding-agent/src/core/extensions/types.ts (installed: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts).

FIXES REQUIRED (build-critical):
1. `ctx.ui.widget` does NOT exist → actual is `ctx.ui.setWidget(key, lines|callback, {placement?})`.
   Fix §2 UI list and all transparency/HUD wiring.
2. `pi-session-hud` does NOT exist → the real HUD package is **`pi-hud`** (publisher ludevdot, v0.9.4).
   Fix §14 and §20.
3. `pi-web-access` → actual scoped name **`@wirebabel/pi-web-access`** (MEDIUM confidence — npm page
   403'd; verify with `npm info @wirebabel/pi-web-access`). Fix §20.
4. `parseFrontmatter` is NOT a verified public export of pi — may be internal. `getAgentDir()` IS
   exported (returns ~/.pi/agent). Plan a fallback to a standard frontmatter parser (`gray-matter`)
   for loading agent markdown. Fix §2.
5. `pi-subagents` (npm, publisher nicopreme, v0.30.0) default depth is **2**, not 1. To enforce the
   §9 "depth=1" claim, set `PI_SUBAGENT_MAX_DEPTH=1` explicitly. `worktree: true` gives each parallel
   child its own git worktree (confirms the worktree-per-lane design).

RISKS:
- `pi-claude-bridge` depends on the Claude Code Agent SDK quota; Anthropic flip-flopped the billing
  policy once (June 2026). Keep a direct Anthropic API provider as a fallback so a bridge break does
  not strand the system. (Reinforces: billing wall is operational, not a code rail — but keep a fallback.)
- `pi-subagents` and `pi-mcp-adapter` are community packages (nicopreme), not first-party Earendil —
  no SLA; they can lag a major pi API bump. Pin versions and watch.
- "pelorus" (a session manager referenced in planning notes) has no public npm/GitHub trace — it is
  the separate deck/cockpit concern, out of scope for this extension.

Pins: @earendil-works/pi-coding-agent ^0.79.9 · pi-subagents ^0.30.0 (env depth=1) ·
pi-mcp-adapter ^2.10.0 · @wirebabel/pi-web-access (verify) · pi-hud ^0.9.4 · pi-claude-bridge (latest).

---

## B. Memory stack — VERDICT: Layer A keep-but-de-risk, Layer B REPLACE (landmine), embeddings swap

LAYER A — codebase-memory-mcp (DeusData, solo dev Martin Vogel): REAL and usable, but the marketing
is inflated. The peer arXiv paper (arxiv.org/abs/2603.27277) says **66 languages** with real semantic
support (not 158 — 158 = vendored tree-sitter grammars), and an honest aggregate of **~10x fewer
tokens at 83% answer quality vs 92%** (the "99% fewer tokens" is one cherry-picked 5-query example).
Sub-ms is vendor-reported, not audited. MIT, single static C binary, SLSA-3 signed releases.
→ KEEP as Layer A (only mature MIT/local code-KG with this breadth), but: pin a release, vendor the
  binary, rewrite the spec's claims to the paper's honest numbers, and keep a tree-sitter + LSP-MCP
  fallback for when the solo maintainer stalls.
→ CONFLICT TO RESOLVE: Mission E independently reported this package as Apache-2.0 / ~900 stars / v1.x
  (Feb 2026) while Mission B reported MIT / 10.4k stars / v0.8.1 (Jun 2026). These contradict. Verify
  license + version + stars directly at build time (`npm info`, `gh api repos/DeusData/codebase-memory-mcp`)
  before pinning. License matters for redistribution.

LAYER B — Cortex: LANDMINE. The spec's attribution is WRONG and the real package is unsafe.
- "Cortex by lleontor705" is a MISATTRIBUTION — lleontor705 ships only `cli-orchestrator-mcp`, not a
  memory tool. The feature-matching project is **`hurttlocker/cortex`**.
- hurttlocker/cortex: MIT, Go single binary (12MB, pure-Go SQLite, zero CGO), KG + vector + temporal
  (Ebbinghaus decay) + importance + entity-linking — but: **29 stars, 0 forks, solo dev, and its own
  README documents a data-corruption bug** (74K facts collapsed to 2.5K after a dedup fix). The
  **"FTS5+Ollama 12–16x" benchmark does not exist** in its docs (fabricated in our spec). Auto-archival
  is actually manual (`cortex stale --days`).
- → DO NOT ship hurttlocker/cortex as the autonomous agent's source-of-truth memory. The spec's own
  "0-star, solo dev" worry was correct and understated.

SAFE LAYER-B REPLACEMENTS (all honor local/private/offline; free/OSS):
- **Letta** (letta-ai/letta, Apache-2.0, 23k★, company-funded, SQLite default, Ollama-local) — strongest
  maintenance; **safest swappable Layer-B backend overall**. RECOMMENDED DEFAULT.
- **engram** (Gentleman-Programming/engram, MIT, 4.6k★, maintained, Go single binary) — closest to
  Cortex's "single Go binary" ethos, but FTS5-only (no vector/KG/temporal) → add embeddings at the
  port layer. Pick this if a tiny self-contained binary matters more than KG features.
- **Graphiti** (getzep/graphiti, Apache-2.0, 27.7k★) — best temporal knowledge graph, but Python +
  needs a graph-DB server (Neo4j/FalkorDB); embedded Kuzu path is deprecated. Not "thin."
- **mem0** (Apache-2.0, ~48k★) — most-adopted bolt-on memory layer; weaker long-horizon accuracy than Zep.
- Paid/cloud quality leader: Zep (63.8% LongMemEval vs mem0 49.0%) — but cloud breaks the 100%-local
  privacy guarantee; not recommended for a tool that reads private source.
- Pragmatic: keep the thin MemoryStore port; ship **Letta** (or engram) as default; if you want Cortex's
  temporal/importance features, trial Cortex BEHIND the port but never as the only copy until its
  corruption fix has soak time.

EMBEDDINGS — switch the local default. nomic-embed-text has **no published code benchmark** and
near-zero cross-lingual. For a CODE agent:
- **qwen3-embedding:0.6b** (Apache-2.0, ~639MB, CPU, Matryoshka dims 32–1024, 100+ langs incl. code) —
  best small-model code retrieval. RECOMMENDED.
- embeddinggemma (~622MB, CPU) — 2nd on code, but Gemma license (usage restrictions) — portability caveat.
- nomic-embed-text — keep only if 8k context + smallest footprint dominate.
- Cloud (text-embedding-3-large / voyage-3 / cohere embed-v4): top MTEB, but the gap over qwen3-0.6b
  does not justify shipping private source to a third party. Privacy > marginal quality here.

Note: both B and E could not auth the GitHub contributor API via WebFetch — exact last-commit / maintainer
counts must be confirmed with `gh api` at build time.

---

## D. Harness + failure-pattern currency — VERDICT: design is current; 3 citation fixes + 1 missing pillar

PRIMARY SOURCES CONFIRMED:
- Anthropic "Harness design for long-running application development" (Mar 24 2026) — Planner/Generator/
  Evaluator 3-agent, separate judge ("agents confidently praise their own work"), and **re-simplify-on-
  upgrade verbatim** ("as models improve, your harness should get simpler… remove one component at a
  time"). H5 confirmed. anthropic.com/engineering/harness-design-long-running-apps
- Anthropic "Effective harnesses for long-running agents" (Nov 26 2025) — confirms the default-FAIL
  JSON feature-list (`passes:false`). H1 contract confirmed.
- Cognition "Multi-Agents: What's Actually Working" (Apr 22 2026, cognition.com/blog/multi-agents-working)
  — clean-context reviewer VERBATIM: "**~2 bugs per PR, ~58% severe**"; builder-side filter; "map-reduce-
  and-manage"; "writes stay single-threaded." R1/R2/R4 confirmed.
- SpecBench (arXiv 2605.21384, May 2026) — visible-suite saturation + "+28pp gap per 10x code size" confirmed.

THREE CITATION FIXES (load-bearing — wrong as written in the spec):
1. **DAPLab "silent-error-suppression is their #1 finding" is REFUTED.** DAPLab's ranking: #1 UI/Presentation
   Grounding, #2 State Mgmt, #3 Business Logic, #4 Data Mgmt, #5 API/External Integration, #6 Security,
   #7 Repeated Code, #8 Codebase-Awareness/Refactoring, **#9 Exception/Error Handling (silent suppression)**.
   It is #9, not #1. Also the study is dated **Jan 8 2026**, not Nov 2025.
   daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html
   → Fix §11 G11 wording ("their #1 finding" → "one of their nine patterns (#9)") and §21 date.
2. **The "~50% cost / +2.6% solve-rate" stat is MISATTRIBUTED.** It is **JetBrains "The Complexity Trap"
   (arXiv 2508.21433, NeurIPS-2025)**, and it is observation **MASKING**, not compaction/summarization,
   measured on **Qwen3-Coder-480B specifically** (model-dependent). The paper's point: masking ≈ LLM-
   summarization at lower complexity → **prefer masking; don't stack a summarizer on top expecting gains**.
   → Fix §12 G9: re-attribute to JetBrains, relabel "masking" (not compaction), note model-specificity.
3. **"Hidden holdout tests are non-negotiable" is INCOMPLETE.** EvilGenie (arXiv 2511.21654, Nov 2025) finds
   a clean-context **LLM judge OUTPERFORMS held-out tests** at catching reward hacking ("minimal improvement
   from held-out test cases"), plus **test-file-edit detection** catches the exact SpecBench exploit (agent
   editing/hardcoding tests). → Upgrade §11: holdout + clean-context LLM judge (primary) + test-tree
   edit-detection, not holdout alone.

MY 6 ROUND-2 ADDITIONS — ALL VALIDATED ("none of the six are misguided"), with named sources:
- G18 mid-build shared-contract broker → **CooperBench (arXiv 2601.13295)** "curse of coordination":
  ~30% avg / ~50% at 2-agent success drop; "merge everything at the end" is the named anti-pattern.
  STRONGEST-evidenced addition.
- G19 brownfield blast-radius → "blast radius" now an industry term (Amazon Mar-2026 memo); Cortex-2026
  CFR +~30%, CodeRabbit ~1.7x AI-code defect rate; enumerate-callers-first is the prescribed mitigation.
- G20 external-effect idempotency → durable-execution / idempotency-keys (agent-ledger, Temporal/Restate).
  NUANCE: ledger gives at-most-once; true exactly-once for payments/migrations needs compensating actions.
- H7 ambiguity gate → standard 2026 HITL (ask when underspecified/irreversible/uncertain); keep it ONE
  question, not an interview, to avoid over-gating.
- H9 still-right judge → **ICLR-2026 "Asymmetric Goal Drift in Coding Agents Under Value Conflict"
  (arXiv 2603.03456)**: models drift off the system prompt under comment-based adversarial pressure +
  accumulated context; **re-anchoring** is the named mitigation. Drift ("still-right") and completion
  ("done?") confirmed as orthogonal axes — keeping them separate is correct.
- H10 gate decision-brief → HITL governance best practice (preview diffs, classify reversible/
  compensatable/final, record approval in audit trail).

THE ONE MISSING PILLAR (HIGH) — Security / adversarial-pressure + credential isolation:
- No explicit security primitive in the design. ICLR-2026 shows system-prompt constraints get overridden
  under **comment-based adversarial pressure** (prompt injection via repo content/issues/comments).
  DAPLab ranks Security #6 of 9. AI code runs ~1.7x defect rate.
- Anthropic Managed Agents' (anthropic.com/engineering/managed-agents) headline reliability primitive is
  **token vaults + proxies that structurally separate credentials from sandbox execution** — defeats
  prompt-injection credential exfiltration. This is STRONGER than the G22 egress rail I added — it is
  structural isolation, not just an allowlist.
- → ADD a security harness primitive: (a) treat all repo content / issue text / comments as UNTRUSTED
  input that can hijack goals (feed the G10 guardrail + H9 still-right judge); (b) credential structural
  isolation — tokens live in a vault/proxy, never in model context or tool-execution scope (upgrades G22
  and §17); (c) a dedicated security-lane reviewer in P5.

OTHER FORWARD NOTES:
- Prefer observation MASKING over summarization-compaction (JetBrains); if "rolling last-N" is masking, good.
- Unify the crash-resurrection event log (§10) with the G20 idempotency ledger — same durable substrate.
- Opus-4.8 "absorbs harness" (third-party commentary, directional): the model internalizes verification/
  orchestration, so GENERIC critic/orchestration scaffolding becomes dead weight — keep domain-specific
  gates, retire generic ones. Operationalizes H5: after each model release, re-test which gates are
  still load-bearing.

---

## E. Build / verify / safety tooling — VERDICT: clear picks, pin these

| Need | Tool (June 2026) | Version | License | Notes |
|------|------------------|---------|---------|-------|
| Mutation — TS/JS | StrykerJS (`@stryker-mutator/core`) | 9.6.1 | Apache-2.0 | programmatic `new Stryker(cfg).runMutationTest()`; `thresholds.break` gate |
| Mutation — Python | mutmut | 2.x | MIT | `mutmut run`; `mutmut results --json` |
| Mutation — Go | go-mutesting (avito-tech fork) | 2025+ | MIT | `gomu` (sivchari) is a newer alt to watch |
| Mutation — Rust | cargo-mutants | 25.x | MIT | `cargo mutants --output json`; Thoughtworks Trial |
| Secrets — pre-commit | gitleaks | v8.30.1 | MIT | `gitleaks protect --staged`; exit 1 on leak. §17 backstop |
| Secrets — CI deep | trufflehog | v3.x | AGPL-3.0 | `--results=verified` |
| Dep CVE | osv-scanner | v2.4.0 | Apache-2.0 | `scan --format json`; exit 1 on vuln |
| Dep license+CVE+supply | trivy | v0.6x | Apache-2.0 | `fs --scanners vuln,license` one pass. G21 |
| Dep first-pass | npm audit | built-in | — | misses transitive/license; layer with trivy/osv |
| UI visual grounding | @playwright/mcp | latest | Apache-2.0 | navigate→screenshot→accessibility-snapshot. G16 |
| Caller enumeration | codebase-memory-mcp `find_callers` | (verify) | (verify) | ast-grep complement; LSP accurate-but-slow. G19 |
| AI-slop structural | AI-SLOP Detector | v3.8.6 | MIT | 27 checks; `--ci-mode hard`. Prose slop still needs an LLM critic |

Integration: pre-commit gate = gitleaks + slop-detector (fast, blocking). P5 VERIFY parallel lanes =
mutation gate · osv+trivy · playwright-MCP UI · blast-radius find_callers · slop check. All gate on
non-zero exit. Prose-slop (hedge comments, narration, emoji) has NO deterministic linter — LLM critic
is the only method; rule-tools + LLM critic in combination is the SOTA.

---

## Required spec changes (summary)

CLEAR FACTUAL FIXES (no judgment — research found the spec's facts wrong):
- §2: `ctx.ui.widget` → `setWidget`; `parseFrontmatter` → mark unverified + gray-matter fallback.
- §9: pi-subagents depth=2 default → set PI_SUBAGENT_MAX_DEPTH=1.
- §14/§20: `pi-session-hud` → `pi-hud`; `pi-web-access` → `@wirebabel/pi-web-access` (verify).
- §4: rewrite Layer-A claims to honest numbers (66 langs, 10x@83%); fix Cortex attribution.
- §11 G11: "DAPLab #1" → "DAPLab #9"; §21 date Nov 2025 → Jan 2026.
- §12 G9: re-attribute masking stat to JetBrains; relabel masking; note model-specificity.
- §11: add clean-context LLM judge (primary) + test-tree edit-detection alongside holdout.
- Embedding default: nomic-embed-text → qwen3-embedding:0.6b.
- §21 ledger: add citations to G18 (CooperBench), G19 (blast-radius/Amazon), H9 (ICLR-2026 goal-drift).

DECISIONS FOR THE OPERATOR:
1. Layer-B memory backend: **Letta** (recommended default, best-maintained) vs **engram** (Cortex-like
   single Go binary, FTS5-only) vs trial-Cortex-behind-port. Cortex-as-source-of-truth is OFF the table.
2. Security pillar scope: add credential structural isolation (vault/proxy) + untrusted-repo-content
   handling + a security-lane reviewer? (Recommended: yes — it is the one missing SOTA pillar.)
3. Resolve the codebase-memory-mcp license/version/stars conflict at build time before pinning.
