# pi-autodev — Consolidated Spec (state snapshot 2026-06-22)

Single source of truth for the pi-autodev extension. Mirrors the running decisions in
`/root/.claude/projects/-root/memory/session-2026-06-21-pi-autodev-plan-RECOVERED.md`.
Companion product (the deck cockpit) is built in a separate session — see that memory file.

## 1. Identity
One pi extension (npm package), installs to `~/.pi/agent/extensions/autodev`. Drop into any repo,
give it an idea/bug/feature, and it auto-detects the project, learns the codebase, plans like a
senior team, builds in parallel, tests against gaming, reviews to zero, and ships to main —
autonomous, crash-proof, self-improving. Pure pi, model-agnostic. Proper compiled-TypeScript
runtime, NOT a skill-markdown pack. Agents and phase skills are markdown DATA the TS engine loads.

## 2. Verified pi API (pi 0.79.9, dist/core/extensions/types.d.ts) — verified June 2026; 2 fixes folded
- Events used: session_start, agent_end, turn_end, context, tool_call, tool_result,
  tool_execution_end, before_provider_request, session_compact, session_shutdown, input.
- Methods: registerTool, registerCommand, registerProvider, registerFlag, registerShortcut,
  sendUserMessage, sendMessage, appendEntry, setModel, setThinkingLevel, exec, on.
- Types: ExtensionAPI, Extension, ExtensionContext, ProviderConfig, ProviderModelConfig.
- UI (HUD/transparency real): ctx.ui.select/confirm/input/notify/setStatus/setWorkingMessage/
  setWidget(key, lines|callback, {placement}). [FIX 2026-06-22: method is setWidget, NOT widget]
- Extension shape: `export default function autodevExtension(pi: ExtensionAPI): void { ... }`
  (name arbitrary). Agents = md+frontmatter via getAgentDir (returns ~/.pi/agent, confirmed);
  parseFrontmatter is NOT a verified public export → use gray-matter to parse frontmatter. [FIX 2026-06-22]

## 3. Model routing
DECISION 2026-06-22: LLM cost is NOT a factor — use the BEST model for every role; no cheap-tier split,
no cost-driven escalation. Quality is the only objective in model selection.
default_model = inherit pi active model at runtime (no hardcode; pi-claude-bridge serves it).
role→model map all `~` → pi active (today: provider=claude-bridge, defaultModel=claude-opus-4-8,
thinking=xhigh). EVERY role (planner, architect, critic, executor, reviewer, tester, integrator, …)
runs on this best model. No DeepSeek, no weak-primary, no difficulty escalation — the system is already
on the strong model, so there is nothing to escalate to.
Billing wall: the pi account's "out of extra usage" wall is now an OPERATIONAL fix — lift it by
paying/upgrading the pi account, or point the bridge at a non-walled key, BEFORE a real run. It is no
longer a design constraint and requires no cost-routing code rail.
DEFERRED (optional, QUALITY not cost): cross-frontier capability-routing (send a task to whichever
frontier model is strongest at it, e.g. Claude + GPT) — only worthwhile if a second frontier key
exists and measurably beats the primary on some task class. Not a milestone-1 concern.

## 4. Memory — two layers, fully local, MCP
- Layer A (code structure): codebase-memory-mcp (DeusData/Martin Vogel, single static C binary).
  HONEST CLAIMS per arXiv 2603.27277 (NOT README marketing): ~66 langs with real semantic support
  (158 = vendored grammars), ~10x fewer tokens at ~83% answer quality vs 92% full-read, sub-ms
  (vendor-reported). Wrap via pi-mcp-adapter. Always on, core. VERIFY license + version + stars at
  build (research found conflicting MIT/10.4k vs Apache/900). Fallback if the solo maintainer stalls:
  tree-sitter + LSP MCP tools.
- Layer B (decision/fact memory): LETTA (letta-ai/letta, Apache-2.0, SQLite default + Ollama-local,
  company-maintained) behind a thin MemoryStore port. REPLACES Cortex — the spec's "Cortex by
  lleontor705" was a misattribution, and the feature-matching hurttlocker/cortex has a self-documented
  data-corruption bug + a fabricated "12-16x" benchmark + 29 stars; NOT safe as source-of-truth memory.
  Semantic recall + contradiction-detect via Letta. Optional: trial Cortex BEHIND the port for
  temporal/importance only, never the sole copy, only after its corruption fix soaks.
- Embeddings: CLOUD via the swappable embedding port (operator decision 2026-06-22: cloud, free/no-limits).
  Default adapter = Google Gemini embedding (gemini-embedding-001) — strong free tier + high limits, and
  pi already integrates Gemini (pi-web-access). SWAPPABLE to any provider via the port (operator may pin
  a specific one). VERIFY current free-tier limits at build (web-currency rule). TRADEOFF ACCEPTED BY
  OPERATOR: drops the prior "100% local" privacy guarantee — memory-derived text (incl. code snippets) is
  sent to the cloud provider; the local fallback (qwen3-embedding:0.6b via Ollama) stays in the port for
  repos that must run offline/private.
- Planes: ~/.pi/autodev/global/ (cross-project prefs/style/habits) + <repo>/.autodev/ (per-codebase
  graph + Letta DB + conventions + journal + checkpoint + cockpit).
- De-risk: pin versions; thin MemoryStore port (swap Letta/engram/Graphiti/files = adapter swap);
  crash resurrection stays OUR files NOT the memory backend; session_start health-check → degrade
  gracefully if backend down.

## 5. Engine — 6-phase state machine (in CODE, not model-decided)
USER drops idea (only human input) → COMPLEXITY SCORE (tier XS..XL sizes everything) →
P1 DISCOVER (ALWAYS web-research current best-practice + latest-stable versions + newest technique
for anything touching an external dep/API/framework/algorithm — via pi-web-access, screened through
G10 guardrails, cached to .autodev + global plane so lanes reuse not re-fetch; never build on
stale/memorized knowledge; write spec; STACK-PICK lang/fw auto + ADR) →
P2 ELABORATE (domain model, personas debate spec) →
P3 PLAN (scope→slice→plan → PANEL evaluates → re-plan loop until 0 objections) →
P4 BUILD (file-DAG parallel lanes, TDD-first — test anything testable BEFORE implementing it:
write the failing test, watch it fail, then implement to green; non-testable work (pure config/docs/
scaffolding) is exempt but must name why — single integrator) →
P5 VERIFY (deterministic verify + holdout tests + humanizer + review-to-zero) →
P6 RELEASE (scoped commit, per-phase push, tier-D gate).
Self-prompt: after each agent_end/turn_end engine writes its own next instruction via
sendUserMessage(deliverAs:"followUp"). No slash command. Surfaces to human only on tier-D gate,
budget cap, all-done, hard block.

## 5b. Harness lifecycle — armed vs running (auto-on safety)
The extension auto-activates when pi loads it (no slash command), but "auto-on" means the harness is
ARMED, not BUILDING. Two explicit states:
- ARMED (on session_start): health-check deps, load memory, run crash-resurrection READ-ONLY, then
  idle-wait. No writes, no mutation. This is the default state on every load.
- RUNNING: entered only by explicit human idea/task input. Then autonomous per §5.
RATIONALE / RISK: an always-on harness must never mutate code the moment pi opens any repo. Without
the armed/running split, opening an unrelated repo would auto-replay a stale §10 checkpoint and edit
the wrong project. Crash-resurrection therefore reconstructs and reports state when ARMED, but the
actual resume (replaying work) is gated behind explicit operator confirmation — resurrection never
auto-runs destructive or write steps on load.
Harness primitives (Anthropic "Effective/Harness Design for Long-Running Agents", Nov 2025 / Mar 2026):
- H1 default-FAIL contract + evidence-gate: a results file (e.g. .autodev/contract.json) starts with
  every criterion false; a pi tool_call hook DENIES any write to that file unless the agent has first
  Read a matching evidence artifact (screenshot, log, test output). Structural enforcement, not
  prompt-asked — the agent cannot claim success it has not observed.
- H2 separate cheap "done?" judge: a cheap/fast pi model checks the completion condition each
  turn_end (like Claude Code /goal), instead of letting the expensive builder self-judge. Cheaper
  and unbiased.
- H4 operator controls without restart: STEER.md surfaced once to the agent then cleared (mid-run
  redirect), and an AGENT_STOP kill-file that halts all tool calls. Matches §14 silent-execution
  (operator SEES, redirects when needed, is never PINGED).
- H6 sprint contract: builder and evaluator agree per-feature on what "done" means, written to a file
  the H1 gate enforces — tightens the P3→P5 handoff.

## 6. Complexity scaling (sizer gate)
Score = f(file-estimate, novelty, blast-radius, irreversibility).
XS 1-file: panel 0, lanes 1, review 1, thinking low. S few: 2/2/1/med. M feature: 4/3/2/high.
L subsystem: 6/5/3/high. XL new system: 8/5/5/xhigh + extra ELABORATE.

## 7. Senior panel — 10 personas, consensus gate (= ralplan scaled)
Architect (structure + dependency-direction inward + next-feature test) · Security
(injection/authz/secrets/supply-chain; G24: also runs as a CLEAN-CONTEXT security-lane reviewer in P5
per R1 — diff-only, repo content treated as untrusted) · Performance (N+1, hot-path, scaling cliffs;
G23 concurrency lens — races/deadlocks/non-atomic RMW) ·
Simplicity/YAGNI · Testing/QA · Maintainability/DX · Domain-expert · SRE/Ops (extended to own the
silent-failure / error-surfacing lens, G11) · Data/Persistence (NEW — schema design, migrations,
query correctness, data-model drift; covers G13) · Designer/UI-UX (gated on UI-in-diff; a11y/WCAG,
component states loading/empty/error/disabled, token drift, responsive, design-system consistency —
reuse DSAF rubric; pairs with the browser-verified evaluator from G16).
Same model, 10 persona prompts. Tier picks top-N. Panel reads plan parallel → objections → critic
aggregates → 0 unresolved = proceed else re-plan.

## 8. Role agents (md+frontmatter, TS engine loads)
planner · architect · critic · executor · reviewer · tester · integrator · stack-selector ·
complexity-scorer · humanizer · designer. (vs installed-now pi-subagents generics: oracle,
researcher, reviewer, scout, context-builder, worker, delegate, planner.)
R1 clean-context reviewer (Cognition, 2026): the reviewer/critic MUST share ZERO context with the
builder — it sees the diff only, no spec, no builder trace. Clean context dodges context-rot and
forces the reviewer to reason backward from the implementation, questioning things the builder
overlooked (incl. a user instruction that asked for an insecure pattern). Cognition measured ~2 bugs
caught per PR, ~58% severe, with this exact setup. R2 bridge: the builder then uses its full context
to FILTER reviewer findings (scope, user intent) to prevent looping / over-scope / disobeying the
user — the integrator owns this reconciliation.

## 9. Parallelism — lanes (P4)
File-DAG partitioner: no two lanes write same file, cap 5, pi-subagents worktree-per-lane
(worktree:true confirmed), depth=1 — pi-subagents DEFAULT depth is 2, so set PI_SUBAGENT_MAX_DEPTH=1.
G7 (Cognition "Don't Build Multi-Agents"): file-DAG stops FILE clash NOT decision clash → PLAN
pre-specs style/patterns/edge-cases (lanes don't improvise) + single integrator reconciles lanes.

## 10. Crash resurrection (project-level; pi sessions isolated)
.autodev/journal.jsonl (append-only WAL: every transition/task/decision/next_skill) +
.autodev/checkpoint.yaml (latest snapshot: phase, plan, task statuses, in-flight, last-good commit).
Write order: journal BEFORE action, checkpoint AFTER completed step. Crash mid-action → "was about
to do X" no completion → mark suspect. session_start reconstructs → mark half-done interrupted →
resume from checkpoint → replay nothing destructive → surface 1 line. Idempotency = safe redo;
interrupted TDD test still red → redo safe; per-story commits = rollback.

## 11. Verification — anti-gaming (P5)
- G8 deterministic verify: artifacts exist, tests ran via exit-code, programmatic. Never
  LLM-judges-own-trace (90% false-positive when trace faked).
- G1 holdout/hidden tests (agent never sees) · mutation testing · test-author ≠ impl-author.
  Reinforced by SpecBench (2026): every model can saturate the VISIBLE test suite — holdout tests are
  necessary but INCOMPLETE alone. EvilGenie (arXiv 2511.21654): a clean-context LLM judge OUTPERFORMS
  held-out tests at catching reward-hacking, and test-tree edit-detection catches the agent
  hardcoding/editing tests. Use holdout + clean-context LLM judge (primary) + test-edit detection.
- Humanizer slop-detector on diff (over-commenting, narration, defensive noise, emoji, ceremony
  names, one-caller helpers, hedge comments) → findings → fold into review-to-zero.
- Review-to-zero: rounds until zero CRITICAL/HIGH findings (cap 5); LOW/MED auto-filed as tracked
follow-up issues (release-triage RESOLVED 2026-06-22 — ship on zero-CRIT/HIGH+filed, not all-severities).
New failure-pattern checks (DAPLab 9-failure study, Nov 2025 — agents prioritize RUNNABLE over
CORRECT, and the bugs are SILENT):
- G11 silent-error suppression (DAPLab pattern #9 of 9 — NOT their #1, which is UI/presentation
  grounding; study dated Jan 8 2026): ban empty / log-only catch on a user path;
  require a failure-path test; errors must surface to the caller/UI, not be swallowed.
- G12 fake integration / placeholder keys: integration-contract test must hit the real-or-mocked
  boundary; scan the diff for placeholder/TODO/hardcoded-stub responses and invented env vars/keys;
  ask for the real value, never fabricate it.
- G13 schema/data-model drift: schema-aware via Layer A graph; a model change REQUIRES a migration;
  data-integrity assertions (e.g. correct ID/foreign key passed).
- G14 reinvent-vs-reuse: dependency-search before any custom implementation; flag hand-rolled algos
  that a known library already provides.
- G15 business-rule mismatch: PLAN carries an examples table (input → expected output) encoding the
  rules; acceptance/holdout tests are derived from it so "runs" cannot pass as "correct".
- G16 UI visual grounding: browser-verified evaluator (Playwright MCP) opens the running app itself
  rather than trusting builder screenshots; the render screenshot is required evidence in the H1
  default-FAIL contract. (G17 state-reconciliation folds into Testing/QA on the frontend tier only —
  deferred, low priority.)

## 12. Safety rails (mandatory)
Runaway backstop (max iterations/tokens per run → halt + escalate; a SAFETY stop against infinite
loops/thrash, NOT cost-minimization — cost is not a factor per §3) · loop-detect (same task fails N → stop, no blind retry) ·
max iterations/phase · tier-D gate (push-main/migrate/prod-write/mass-delete = async approve) ·
G2 action monitor (block recursive-delete/out-of-bounds-write/pipeline-break at EXEC time) ·
G10 guardrails (screen repo/web content before context — prompt-injection/session-contamination;
G24 SECURITY-PILLAR: treat ALL repo content/issues/comments as UNTRUSTED goal-hijack vectors per
ICLR-2026 arXiv 2603.03456 — feed the H9 still-right judge so comment-based adversarial pressure
cannot override the frozen spec) ·
G9 observation MASKING (rolling last-N tool results; prefer masking over summarization-compaction —
JetBrains "Complexity Trap" arXiv 2508.21433: ~52% cheaper + ~2.6% solve-rate, measured on
Qwen3-Coder-480B so model-specific; do NOT stack a summarizer expecting gains).

## 13. deepseek-optimized — REMOVED 2026-06-22 (cost not a factor, see §3)
Ditched: LLM cost is not a constraint, so the DeepSeek/Kimi cheap-model optimizations have no purpose.
The 7 vendored modules, PI_HARNESS_MODEL_PATTERN gating, cache-prefix (120x-cheaper), and hashline
edit_lines are all removed; the `src/deepseek/` tree is dropped from §19 (the §19 listing below is
superseded on that line). RETAINED GENERICALLY: "storm-breaker" was the one module with model-independent
value (it breaks tool-failure loops); that FUNCTION now lives in the §12 loop-detect / action-monitor
rails, not as a DeepSeek-gated module. plan-mode-always-on is already covered by the §5 P3 PLAN phase.

## 14. Transparency / observability (operator always SEES, never PINGED)
Passive watch, reconcile silent_execution. Live HUD (pi-hud): phase, active task, lane
status, model, cost burn, tokens, last decision. .autodev/activity.log tail-able human line per
action. tmux panes = visible lanes. appendEntry per transition (resumable, NOT sent to LLM). Two
planes: MAIN AGENT (phase/plan/gate/integrate) vs WORKERS (lane task/tool/test). G6 metrics:
cost-attribution per role/task/cache-bucket, solve-rate, time-to-merge, change-failure-rate (CFR).

## 15. Speed (DORA elite)
Trunk-based + small commits, CI per commit (smoke-gate), severity-tagged review, cap reviewers,
CFR sub-10% target, deploy decoupled from release (feature-flag risky merges).

## 16. Humanized code (clarity-bounded brevity)
"No line that isn't earning its place" not min-chars. No comment unless WHY non-obvious; one-line
docstring only on API surface; YAGNI; no defensive boilerplate (validate only at boundaries); short
readable names; delete dead paths; match learned local idiom.

## 17. Token handling
Global + editable + project-aware auto-detect (remote URL, fallback repo-root hash).
~/.pi/autodev/tokens.yaml (0600) or /autodev-tokens. Ask-once per project if missing. Never in
model context, never committed (gitleaks v8.30.1 backstop), never logged (redacted). Fine-grained PAT,
repo-scoped. G24 SECURITY-PILLAR (2026-06-22): credential STRUCTURAL isolation — tokens live in a
vault/proxy, injected at the tool/exec boundary ONLY, never in model context or sub-agent scope (per
Anthropic Managed Agents; stronger than the G22 egress allowlist alone — defeats prompt-injection
exfiltration). NOTE: two live tokens were leaked in chat during planning — both MUST be revoked before
any git/token milestone (hard gate, unaffected by the cost decision).

## 18. Manageability
One config cockpit/autodev.yaml (models, tiers, caps, budget). Commands /autodev-status
/autodev-config /autodev-tokens /autodev-pause /autodev-resume. /autodev-doctor health-checks deps
(Letta, codebase-memory-mcp, Ollama) → up/down. Zero-config start (sensible defaults). Swappable
layers (memory port, model map). Easy install/update (install.mjs + version pin).
H5 re-simplify on model upgrade (Anthropic harness papers): after each model release, /autodev-doctor
prompts to comment out harness pieces one at a time and see what is still load-bearing — newer models
drift less and self-scope better, so harness scaffolding should shrink over time. Supports the
"self-improving" claim and guards against permanent over-engineering.

## 19. File tree
```
pi-autodev/
  install.mjs                  # copy → extensions + register in settings
  src/extension/index.ts       # default fn(pi: ExtensionAPI): registerProvider/Tool/Command + on(...)
  src/engine/                  # 6-phase FSM + self-prompt + complexity scorer
  src/lanes/                   # file-DAG partitioner + integrator
  src/memory/                  # MemoryStore port + Letta/codebase-memory adapters + hooks
  src/git/                     # scoped commit + per-phase push + tier-D + token store
  src/safety/                  # budget, loop-detect, action-monitor, guardrails, compaction
  src/verify/                  # P5 pipeline: deterministic, holdout, mutation, reviewer, blast-radius, security-lane
  src/transparency/            # activity.log + HUD wiring + appendEntry + metrics(G6)
  agents/                      # 11 role agents + 9 panel personas (md+frontmatter)
  skills/                      # one SKILL.md per phase
  cockpit/                     # autodev.yaml, models.yaml, state
```

## 20. Composes (installed)
pi-subagents (parallel workers, depth=1 via PI_SUBAGENT_MAX_DEPTH=1) · pi-mcp-adapter (wrap Letta +
codebase-memory-mcp) · @wirebabel/pi-web-access (librarian + doc lookup; verify scoped name) ·
pi-hud (HUD). New dep: Ollama (OPTIONAL — local-embedding fallback only; default embeddings are cloud via the port).

## 21. Gaps folded so far
G1 test-gaming · G2 op-safety · G3 context-frag · G4 success-faking · G5 verification-gamed (never
self-report) · G6 observability/metrics · G7 parallel-writer decision collision · G8 LLM-judge
gamed · G9 context compaction · G10 input/output guardrails. Plus senior-dev 5 buckets, DORA speed,
UI/UX persona, manageability.
Added 2026-06-22 (web research pass): G11 silent-error suppression · G12 fake integration/placeholder
keys · G13 schema/data-model drift · G14 reinvent-vs-reuse · G15 business-rule mismatch · G16 UI
visual grounding · G17 state-reconciliation (deferred). Plus R1 clean-context reviewer · R2 builder-
side finding filter · R3 smart-friend escalation (budget) · R4 map-reduce-manage (no swarm). Harness
primitives H1 default-FAIL contract · H2 cheap done-judge · H4 STEER/kill-switch · H5 re-simplify ·
H6 sprint contract. New persona: Data/Persistence; SRE/Ops extended to silent-failure lens.
Sources: DAPLab 9 Critical Failure Patterns; Cognition "Multi-Agents: What's Actually Working";
Anthropic cwc-long-running-agents + Harness Design papers; SpecBench reward-hacking.
Added 2026-06-22 (round 2 — agentic + senior-dev gap pass):
- G18 mid-build shared-contract change between lanes: a lane mutating a shared boundary (type,
  interface, public symbol) publishes to a contract registry and brokers through the integrator
  BEFORE merge, not after. Closes the parallel-writer decision-collision that G7 only reconciles at
  integration time. Wires into §9 lanes.
- G19 brownfield blast-radius handling: before mutating a shared symbol, enumerate callers via the
  Layer-A graph, then choose additive-vs-breaking and emit a deprecation/migration path. Generalizes
  G13 (which covered only schema) to signatures, APIs, and shared types. Wires into §11 verify and the
  Architect persona.
- G20 external-effect idempotency ledger: migrations, network writes, releases, and emails are
  recorded pre-execute so crash-resurrection (§10) never double-fires a non-idempotent effect. The
  existing "idempotency = safe redo" claim holds only for the filesystem; this covers external effects.
- G21 dependency-vetting gate: at add-dependency time, gate on license compatibility, maintenance
  health (last commit, maintainer count), osv/CVE, and transitive size. Applies to the USER's project
  the same diligence the spec already self-applies to Cortex. Wires into §11/§12 and the Security persona.
- G22 egress/exfiltration rail in the action monitor: token never leaves the process, network egress
  allowlist, push only to the configured remote. Extends G2 (which blocks delete/out-of-bounds-write
  but not egress) and G10 (which screens input only). Reinforces §17 token handling.
- G23 concurrency-correctness lens: races, deadlocks, and non-atomic read-modify-write in generated
  code. A facet of the Performance persona plus a targeted verify check; these are silent bugs that
  holdout tests rarely catch, and autodev itself is concurrent.
Harness primitives (round 2):
- H7 ambiguity gate: if an idea's ambiguity exceeds a threshold (multiple valid interpretations whose
  builds diverge), surface ONE batched clarifying question before entering RUNNING. Pairs with H4 and
  the §5b armed/running split.
- H8 pre-run estimate + go/no-go: at the armed→running transition, L/XL tier emits a projected
  cost/time estimate and takes a single go/no-go. Proactive complement to the reactive budget cap (§12),
  directly relevant to the §3 billing wall.
- H9 still-right judge: periodically re-anchor the active trajectory to the frozen P1 spec and the G15
  examples table, plus a mid-build architectural-coherence check; when the diff materially diverges from
  the approved P3 plan, take a backedge P4→P3 to re-plan. Complements H2 (which judges "done?" but
  presupposes the goal did not drift).
- H10 gate decision-brief: every tier-D gate carries a PR-grade brief (change, rationale, risk,
  rollback) so operator approval is informed, not a rubber-stamp.
Research-backed (round 2):
- R5 post-run retro: after each run, extract recurring bug-patterns and wrong-conventions and write
  them to the GLOBAL plane (~/.pi/autodev/global/) so the next run on any repo improves. Makes the
  "self-improving" claim real beyond H5's model-upgrade re-simplification.
Also folded (lower tier): partial-delivery coherent-state on halt — budget/block halts always land on
a coherent commit with a done/not-done report (§5b/§10) · convention-extraction for brownfield idiom
into a style-contract the lanes obey (P1/P2 + §16) · product observability baked into shipped code
(SRE/Ops persona) · per-repo RUNNING-lock so two concurrent sessions cannot both build the same repo
(§5b) · rollback policy revert-vs-forward-fix (§10) · flaky/slow/order-dependent test detection (P5).
Operating rule (2026-06-22, web-currency): ALWAYS web-research the newest best-practice/technique/
latest-stable version for anything touching an external dep/API/framework/algorithm before building;
never rely on memorized or stale knowledge (model cutoffs drift, libraries move fast — this spec's own
G11-G16/R1-R4 came from a web pass). Smart-always not dumb-always: route fetched content through G10
guardrails (web is an injection surface), cache to .autodev + the global plane so lanes reuse rather
than re-fetch, and gate on version-sensitivity so trivial purely-internal work (rename, internal
refactor) is not taxed. Wires into P1 DISCOVER, G14 reuse-search, and G21 dep-vetting.
DECISION 2026-06-22 (release-triage — RESOLVED below; was an open decision contradicting CLAUDE.md's
all-severities rule): release-readiness triage context — real senior teams ship on zero-CRITICAL/HIGH with
LOW/MED filed as tracked follow-ups, whereas
§11 review-to-zero and CLAUDE.md post_plan_review both require all severities driven to zero. For the
shipped product's own autonomy, all-to-zero burns budget on cosmetics and fights DORA velocity.
RESOLVED 2026-06-22 (operator: go): pi-autodev's P6 RELEASE ships on zero-CRITICAL/HIGH with LOW/MED
auto-filed as tracked follow-up issues; OMC's own dev work keeps all-severities-to-zero (CLAUDE.md
post_plan_review unchanged). The two policies are scoped to two different codebases — no conflict.
Sources (round 2): same corpus, adversarial re-read for control-loop, brownfield, and human-decision-edge
coverage.
DECISION 2026-06-22 (cost-not-a-factor): LLM cost is not a constraint → use the best model for every
role (§3 rewritten). Ditched the DeepSeek cost machinery — R3 cheap-primary/strong-escalation and the
§13 deepseek-optimized modules are removed (storm-breaker's loop-break function retained generically in
§12; plan-mode covered by P3). H8 demoted from cost-estimate to an optional scope-preview (its cost
rationale is gone; the H7 ambiguity gate already guards "building the right thing"). Budget cap demoted
to a runaway-iteration backstop (safety, not cost). Billing wall (§3) reclassified: OPERATIONAL
pay/upgrade of the pi account, not a milestone-1 code rail. NOTE: the §17 leaked-PAT revocation gate is
UNAFFECTED by this decision — it remains a hard security gate on any git/token milestone.
Stage-0 research corrections folded 2026-06-22 (docs/research/2026-06-22-stage0-research.md, all cited):
pi package fixes — ctx.ui.setWidget (not widget); pi-hud (not pi-session-hud); @wirebabel/pi-web-access;
parseFrontmatter unverified → gray-matter; pi-subagents depth default 2 → set PI_SUBAGENT_MAX_DEPTH=1.
Layer-B memory: Cortex REPLACED by Letta (operator decision) — hurttlocker/cortex has a self-documented
data-corruption bug + fabricated 12-16x benchmark; "Cortex by lleontor705" was a misattribution. Layer-A
claims corrected to arXiv 2603.27277 (66 langs, 10x@83%). Embeddings nomic → qwen3-embedding:0.6b.
Harness citation fixes: DAPLab silent-suppression is #9 not #1 (study Jan 2026); G9 masking stat is
JetBrains arXiv 2508.21433 (masking, Qwen-specific) not Anthropic; holdout augmented with EvilGenie
clean-context LLM judge + test-edit detection.
Round-2 additions VALIDATED vs named sources: G18 → CooperBench arXiv 2601.13295 (curse of coordination,
strongest evidence); G19 → "blast radius" industry term; G20 → durable-execution/idempotency (at-most-once
via ledger; exactly-once needs compensation for payments/migrations); H7 → HITL; H9 → ICLR-2026 arXiv
2603.03456 asymmetric goal-drift (re-anchoring); H10 → HITL governance. None misguided.
G24 SECURITY PILLAR (operator decision: add full): (a) untrusted repo content/issues/comments feed G10 +
the H9 still-right judge; (b) credential structural isolation via vault/proxy (§17, upgrades G22); (c) a
clean-context security-lane reviewer in P5 (extends §7 Security with R1). Sources: Anthropic Managed
Agents + ICLR-2026 + DAPLab #6.
Build tooling pinned: StrykerJS 9.6.1 · mutmut · cargo-mutants · gitleaks 8.30.1 · osv-scanner 2.4.0 +
trivy · @playwright/mcp (G16) · AI-SLOP Detector 3.8.6 (+ LLM critic for prose slop).

## 22. Next
Stage-1 plan doc (build milestones + file-DAG lanes + acceptance) → ralplan critic → omc-teams build.
