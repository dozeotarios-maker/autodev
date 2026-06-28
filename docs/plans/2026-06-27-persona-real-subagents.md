# Persona Real-Subagents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution is via omc-teams Sonnet executors after a ralplan critic pass, then post-plan code review.

**Goal:** Replace pi-autodev's host-synthesised persona debate with real, context-isolated persona subagents (each its own `createAgentSession` running a non-Claude/Gemini model), role-grounded, web-research-grounded, relevance-gated, with the `legal` persona dropped and an `autonomous-engineer` persona added — degrading gracefully to host-synthesis when Gemini is unavailable, and keeping the 1115-test suite green.

**Architecture:** A new `src/persona/` module owns persona dispatch. A `PersonaSessionRunner` port wraps the pi SDK `createAgentSession` (real impl = Gemini; tests inject a mock — CI never hits the network). A `PersonaRegistry` maps each persona name to a senior role-grounding system prompt + relevance hint. A `RelevanceSelector` (one cheap LLM call) picks which personas are worth firing for a given idea; the complexity tier still caps the count. `PersonaPanel.dispatch()` runs the selected personas concurrently (capped), each optionally doing a brief web-research step first, with 429 backoff and a per-persona fallback to the existing host-synthesis path. P2 and P3 run the panel **before** their host steer and hand the host the panel's verbatim objections to write into the JSON file — preserving the existing steer-then-verify + file contract. Everything is config-driven and env-overridable.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `@earendil-works/pi-coding-agent` SDK (`createAgentSession`, `ModelRegistry`, `AuthStorage`, `SessionManager`), Gemini via the `google` provider (default `gemini-2.5-flash`).

---

## Spike-Proven Facts (do not re-derive)

- `createAgentSession({ model, modelRegistry, authStorage, sessionManager: SessionManager.inMemory(), noTools: 'all', thinkingLevel })` creates a fully isolated in-process agent.
- Model wiring:
  ```ts
  const auth = AuthStorage.create()
  auth.setRuntimeApiKey('google', process.env['GEMINI_API_KEY']!)
  const registry = ModelRegistry.create(auth)
  const model = registry.find('google', 'gemini-2.5-flash') // FOUND; 2.0-flash 429'd; 3.1-pro-preview empty
  ```
- Run + extract: `await session.prompt(text)`, then read `session.messages`, take the **last** `role==='assistant'` message. Its `content` is an array of parts. Collect parts where `part.type==='text'` (IGNORE `part.type==='thinking'`). If the assistant message has `stopReason==='error'`, it failed (`errorMessage` holds the API error, e.g. a 429 quota body). `session.dispose()` when done.
- `GEMINI_API_KEY` already loads via `loadDotEnv()` in `src/extension/index.ts`.
- `DeterministicVerifier` allowlist already permits `node`/`npm` — irrelevant here but confirms the env runs Node 22.

## File-Touch DAG (for omc-teams lane assignment)

```
Lane A (foundation — MUST land first, single worker):
  src/persona/types.ts
  src/persona/persona-config.ts
  src/persona/persona-registry.ts
  src/persona/session-runner.ts        (Gemini createAgentSession adapter + InjectableRunner port)
Lane B (depends on A):                 Lane C (depends on A):
  src/persona/persona-panel.ts           src/persona/relevance-selector.ts
Lane D (depends on B+C):               Lane E (depends on B+C):
  src/phases/p2-elaborate.ts (wire)      src/phases/p3-plan.ts (wire)
Lane F (depends on D+E):
  src/host/controller.ts (construct panel from config, pass to P2/P3 — 6 sites)
  src/extension/index.ts  (build PersonaPanel in buildExtension, thread to controller opts)
Tests travel with each lane.
```
Parallelism: A is the barrier. After A, {B,C} run concurrently. After both, {D,E} run concurrently. F last. No two lanes write the same file.

---

## Task 1: Persona types + config (Lane A)

**Files:**
- Create: `src/persona/types.ts`
- Create: `src/persona/persona-config.ts`
- Test: `tests/persona/persona-config.test.ts`

**Step 1 — Write `src/persona/types.ts`:**
```ts
// Shared persona types. PersonaDebateEntry MUST stay structurally identical to
// PhaseOutput's PersonaDebateEntry so panel results write straight into p2/p3 JSON.
export interface PersonaDebateEntry {
  persona: string
  stance: string
  objections: string[]
}

/** What the panel is reasoning about for a given phase. */
export interface PersonaContext {
  phase: 'P2' | 'P3'
  idea: string
  spec?: string
  stackAdr?: string
  domainModel?: string
  planSummary?: string
}

/** One isolated reasoning run. Implemented by Gemini (real) or a mock (tests). */
export interface PersonaSessionRunner {
  /** Run `task` under `systemPrompt` in an isolated context. */
  run(systemPrompt: string, task: string): Promise<PersonaRunResult>
  /** Optional cheap one-shot used by the relevance selector. */
  ask?(systemPrompt: string, task: string): Promise<PersonaRunResult>
}

export interface PersonaRunResult {
  ok: boolean
  text: string
  /** Set when ok===false: 'rate_limit' | 'unavailable' | 'empty' | 'error'. */
  failure?: 'rate_limit' | 'unavailable' | 'empty' | 'error'
  errorMessage?: string
}

/** Host-synthesis fallback signature (the existing steer path), injected into the panel. */
export type HostSynthesize = (personas: string[], ctx: PersonaContext) => Promise<PersonaDebateEntry[]>
```

**Step 2 — Write `src/persona/persona-config.ts`:**
```ts
export interface PersonaConfig {
  /** Gemini model id under the 'google' provider. */
  model: string
  /** Max concurrent isolated sessions (rate-limit guard). */
  concurrency: number
  /** Per-persona web-research step before objecting. */
  webResearch: boolean
  /** Fall back to host-synthesis when a persona session fails. */
  fallbackToHost: boolean
  /** 429/backoff retries per session before giving up. */
  maxRetries: number
  /** Run personas as real subagents at all. When false, always host-synthesise. */
  enabled: boolean
}

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  model: 'gemini-2.5-flash',
  concurrency: 2,
  webResearch: true,
  fallbackToHost: true,
  maxRetries: 2,
  enabled: true,
}

/** Build config from env, falling back to defaults. All keys optional. */
export function loadPersonaConfig(env: NodeJS.ProcessEnv = process.env): PersonaConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const bool = (v: string | undefined, d: boolean): boolean =>
    v === undefined ? d : /^(1|true|yes|on)$/i.test(v)
  return {
    model: env['AUTODEV_PERSONA_MODEL'] || DEFAULT_PERSONA_CONFIG.model,
    concurrency: num(env['AUTODEV_PERSONA_CONCURRENCY'], DEFAULT_PERSONA_CONFIG.concurrency),
    webResearch: bool(env['AUTODEV_PERSONA_WEB_RESEARCH'], DEFAULT_PERSONA_CONFIG.webResearch),
    fallbackToHost: bool(env['AUTODEV_PERSONA_FALLBACK'], DEFAULT_PERSONA_CONFIG.fallbackToHost),
    maxRetries: num(env['AUTODEV_PERSONA_MAX_RETRIES'], DEFAULT_PERSONA_CONFIG.maxRetries),
    // enabled defaults true ONLY if a Gemini key exists; else host-synthesis.
    enabled: bool(env['AUTODEV_PERSONA_SUBAGENTS'], !!env['GEMINI_API_KEY']),
  }
}
```

**Step 3 — Test (`tests/persona/persona-config.test.ts`):** assert defaults; assert env overrides parse (model, concurrency int, booleans for `1/true/yes/on`); assert `enabled` is false when no `GEMINI_API_KEY` and no explicit override; assert explicit `AUTODEV_PERSONA_SUBAGENTS=1` forces enabled.

**Step 4 — Run:** `npx vitest run tests/persona/persona-config.test.ts` → PASS.

**Step 5 — Commit:** `feat(persona): persona types + env-driven config`

---

## Task 2: Persona registry — role grounding (Lane A)

**Files:**
- Create: `src/persona/persona-registry.ts`
- Test: `tests/persona/persona-registry.test.ts`

Each persona gets a senior, specific role-grounding system prompt and a one-line relevance hint (used by the selector). Drop `legal`. Add `autonomous-engineer`.

**Step 1 — Write `src/persona/persona-registry.ts`:**
```ts
export interface PersonaSpec {
  name: string
  /** Senior role-grounding system prompt — what this role knows, cares about, objects to. */
  systemPrompt: string
  /** One line the relevance selector uses to decide if this persona is worth firing. */
  relevanceHint: string
}

// Senior personas. Each systemPrompt is written so an isolated model with no codebase
// context still reasons like that specialist. Keep them concrete, not generic.
export const PERSONA_REGISTRY: Record<string, PersonaSpec> = {
  user: {
    name: 'user',
    relevanceHint: 'end-user-facing behavior, ergonomics, surprising defaults',
    systemPrompt:
      'You are a demanding end user of the software being designed. You judge it purely by how it behaves for you: predictable outputs, sane defaults, clear errors, no data loss, no surprises on messy real-world input. You do not care about implementation. Raise concrete objections a real user would hit. Be specific, not generic.',
  },
  developer: {
    name: 'developer',
    relevanceHint: 'API ergonomics, maintainability, testability, edge cases',
    systemPrompt:
      'You are a senior software engineer who will maintain this code. You care about clear contracts, naming, testability, edge cases, error handling, and not painting the codebase into a corner. You object to ambiguous specs, missing edge-case handling, and designs that will be hard to test or extend. Cite the specific gap.',
  },
  security: {
    name: 'security',
    relevanceHint: 'untrusted input, injection, secrets, authz, supply chain',
    systemPrompt:
      'You are a senior application security engineer (OWASP-fluent). You hunt for injection, unsafe deserialization, ReDoS, path traversal, SSRF, secret leakage, authz gaps, and supply-chain risk. You assume all input is hostile. Raise only objections grounded in a concrete attack path for THIS design.',
  },
  ops: {
    name: 'ops',
    relevanceHint: 'deploy, runtime footprint, observability, failure modes',
    systemPrompt:
      'You are a senior SRE/operations engineer. You care about deployability, runtime footprint, configuration, observability (logs/metrics), failure modes, resource limits, and rollback. You object when a design is undeployable, unobservable, or has no failure story. If the work has zero runtime/infra footprint, say "no objections".',
  },
  'product-manager': {
    name: 'product-manager',
    relevanceHint: 'scope, user value, success metrics, missing requirements',
    systemPrompt:
      'You are a pragmatic senior product manager. You care that the work solves the real problem, has a clear success metric, and is not over- or under-scoped. You object to gold-plating, missing acceptance criteria, and scope that misses the stated user need.',
  },
  architect: {
    name: 'architect',
    relevanceHint: 'system boundaries, coupling, data flow, future cost',
    systemPrompt:
      'You are a senior software architect. You care about module boundaries, coupling, data flow, and the long-term cost of the chosen structure. You object to leaky abstractions, hidden coupling, and decisions that will be expensive to reverse. Prefer the simplest structure that holds.',
  },
  qa: {
    name: 'qa',
    relevanceHint: 'test coverage, regressions, untested paths, flakiness',
    systemPrompt:
      'You are a senior QA/test engineer. You care that every behavior and invariant is covered by a deterministic test, that edge cases are exercised, and that the suite is not flaky. You object to untested paths, missing negative tests, and assertions that do not actually lock the behavior.',
  },
  accessibility: {
    name: 'accessibility',
    relevanceHint: 'UI/UX, screen readers, keyboard, contrast — UI work only',
    systemPrompt:
      'You are a senior accessibility specialist (WCAG-fluent). You care about keyboard navigation, screen-reader semantics, focus management, contrast, and inclusive defaults. Only relevant when the work has a user interface. If there is no UI, say "no objections".',
  },
  performance: {
    name: 'performance',
    relevanceHint: 'hot paths, complexity, allocations, scaling limits',
    systemPrompt:
      'You are a senior performance engineer. You care about algorithmic complexity, allocations, hot paths, and scaling limits. You object to accidental O(n^2), unbounded work, and designs that will not scale to the stated load. Do not micro-optimize what is not hot.',
  },
  'autonomous-engineer': {
    name: 'autonomous-engineer',
    relevanceHint: 'agentic/automation/pipeline work, idempotency, retries, human-in-loop',
    systemPrompt:
      'You are a senior engineer who builds autonomous and agentic automation pipelines. You care about idempotency, retry/backoff, partial-failure recovery, rate limits, observability of long-running jobs, safe side effects, and where a human must stay in the loop. You object to automation that can silently corrupt state, storm an API, or has no recovery path. Only fire for agentic/automation/pipeline/scheduled work.',
  },
}

export const ALL_PERSONA_NAMES = Object.keys(PERSONA_REGISTRY)

export function getPersona(name: string): PersonaSpec | undefined {
  return PERSONA_REGISTRY[name]
}
```

**Step 2 — Test (`tests/persona/persona-registry.test.ts`):** assert `legal` is absent; assert `autonomous-engineer` present; assert every spec has a non-empty `systemPrompt` (>= 80 chars) and `relevanceHint`; assert `user` and `developer` exist (the always-relevant core); assert `ALL_PERSONA_NAMES` has no duplicates.

**Step 3 — Run** → PASS. **Step 4 — Commit:** `feat(persona): role-grounding registry; drop legal, add autonomous-engineer`

---

## Task 3: Gemini session runner + injectable port (Lane A)

**Files:**
- Create: `src/persona/session-runner.ts`
- Test: `tests/persona/session-runner.test.ts`

Wrap `createAgentSession`. Real impl = `GeminiSessionRunner`. Tests inject a fake `PersonaSessionRunner`; CI never hits the network.

**Step 1 — Write `src/persona/session-runner.ts`:**
```ts
import { createAgentSession, ModelRegistry, AuthStorage, SessionManager } from '@earendil-works/pi-coding-agent'
import type { PersonaSessionRunner, PersonaRunResult } from './types.js'

/** Extract concatenated text parts from the last assistant message; ignore thinking parts. */
export function extractAssistantText(messages: unknown[]): { text: string; stopReason?: string; errorMessage?: string } {
  const assistants = (messages as Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }>)
    .filter((m) => m?.role === 'assistant')
  const last = assistants[assistants.length - 1]
  if (!last) return { text: '' }
  const parts = Array.isArray(last.content) ? last.content : []
  const text = parts
    .filter((p): p is { type: string; text: string } =>
      typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text')
    .map((p) => p.text)
    .join('')
  return { text, stopReason: last.stopReason, errorMessage: last.errorMessage }
}

function classifyFailure(stopReason?: string, errorMessage?: string): PersonaRunResult['failure'] {
  const blob = `${stopReason ?? ''} ${errorMessage ?? ''}`.toLowerCase()
  if (/429|quota|rate.?limit|resource_exhausted/.test(blob)) return 'rate_limit'
  if (/unavailable|econnrefused|enotfound|fetch failed|timeout/.test(blob)) return 'unavailable'
  if (stopReason === 'error') return 'error'
  return undefined
}

export interface GeminiRunnerOptions {
  model: string
  apiKey: string
  thinkingLevel?: 'low' | 'medium' | 'high'
}

export class GeminiSessionRunner implements PersonaSessionRunner {
  private auth: AuthStorage
  private registry: ModelRegistry
  private model: ReturnType<ModelRegistry['find']> | undefined
  private ready = false

  constructor(private readonly opts: GeminiRunnerOptions) {
    this.auth = AuthStorage.create()
    this.auth.setRuntimeApiKey('google', opts.apiKey)
    this.registry = ModelRegistry.create(this.auth)
  }

  private resolveModel(): void {
    if (this.ready) return
    this.model = this.registry.find('google', this.opts.model)
    this.ready = true
  }

  async run(systemPrompt: string, task: string): Promise<PersonaRunResult> {
    this.resolveModel()
    if (!this.model) return { ok: false, text: '', failure: 'unavailable', errorMessage: `model ${this.opts.model} not in registry` }
    let session
    try {
      session = await createAgentSession({
        model: this.model,
        modelRegistry: this.registry,
        authStorage: this.auth,
        sessionManager: SessionManager.inMemory(),
        noTools: 'all',
        ...(this.opts.thinkingLevel ? { thinkingLevel: this.opts.thinkingLevel } : {}),
      })
    } catch (e) {
      return { ok: false, text: '', failure: 'unavailable', errorMessage: e instanceof Error ? e.message : String(e) }
    }
    try {
      // Persona system prompt is delivered as the first message (createAgentSession has no
      // direct systemPrompt option without a resourceLoader; prepending is sufficient).
      await session.session.prompt(`${systemPrompt}\n\n---\n\n${task}`)
      const { text, stopReason, errorMessage } = extractAssistantText(session.session.messages)
      const failure = classifyFailure(stopReason, errorMessage)
      if (failure) return { ok: false, text, failure, errorMessage }
      if (!text.trim()) return { ok: false, text: '', failure: 'empty' }
      return { ok: true, text }
    } catch (e) {
      return { ok: false, text: '', failure: 'error', errorMessage: e instanceof Error ? e.message : String(e) }
    } finally {
      try { session.session.dispose() } catch { /* best effort */ }
    }
  }

  async ask(systemPrompt: string, task: string): Promise<PersonaRunResult> {
    return this.run(systemPrompt, task)
  }
}
```
> NOTE for executor: the exact `createAgentSession` return shape is `{ session: AgentSession }`. The spike used `const { session } = await createAgentSession(...)` then `session.prompt(...)` / `session.messages` / `session.dispose()`. Adjust the `.session.` access above to match (verify against `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` — `CreateAgentSessionResult.session`). Keep `extractAssistantText` and `classifyFailure` pure and unit-tested.

**Step 2 — Test (`tests/persona/session-runner.test.ts`):** unit-test the **pure** helpers only (never call the SDK in CI):
- `extractAssistantText`: returns joined text parts; ignores `thinking` parts; returns last assistant when multiple; surfaces `stopReason`/`errorMessage`; empty when no assistant.
- `classifyFailure`: `429`/`quota`/`resource_exhausted` → `rate_limit`; `fetch failed` → `unavailable`; `stopReason==='error'` → `error`; clean → undefined.

**Step 3 — Run** → PASS. **Step 4 — Commit:** `feat(persona): Gemini session runner + pure output/failure parsers`

---

## Task 4: PersonaPanel — dispatch, concurrency, backoff, fallback (Lane B)

**Files:**
- Create: `src/persona/persona-panel.ts`
- Test: `tests/persona/persona-panel.test.ts`

**Step 1 — Write `src/persona/persona-panel.ts`:**
```ts
import type { PersonaConfig } from './persona-config.js'
import type { PersonaSessionRunner, PersonaContext, PersonaDebateEntry, HostSynthesize } from './types.js'
import { getPersona } from './persona-registry.js'

export interface PersonaPanelDeps {
  runner: PersonaSessionRunner
  config: PersonaConfig
  /** Host-synthesis fallback (existing steer path). */
  hostSynthesize: HostSynthesize
  /** Optional structured logger/journal hook. */
  log?: (msg: string) => void
}

const OBJECTION_TASK = (ctx: PersonaContext): string => {
  const context = [
    `Idea: ${ctx.idea}`,
    ctx.spec ? `Spec: ${ctx.spec}` : '',
    ctx.stackAdr ? `Stack: ${ctx.stackAdr}` : '',
    ctx.domainModel ? `Domain model: ${ctx.domainModel}` : '',
    ctx.planSummary ? `Plan: ${ctx.planSummary}` : '',
  ].filter(Boolean).join('\n')
  return [
    context,
    '',
    'List your top objections or concerns from your role. If you have none that are concrete and relevant, reply with an empty array.',
    'Reply ONLY as JSON: {"stance":"<one sentence>","objections":["<objection>", ...]}. No prose, no markdown fence.',
  ].join('\n')
}

function parseObjectionJson(persona: string, text: string): PersonaDebateEntry {
  // Tolerant parse: strip fences, find the first {...} block.
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  let stance = ''
  let objections: string[] = []
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1))
      stance = typeof obj.stance === 'string' ? obj.stance : ''
      objections = Array.isArray(obj.objections) ? obj.objections.filter((o: unknown) => typeof o === 'string') : []
    } catch { /* fall through to empty */ }
  }
  return { persona, stance, objections }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class PersonaPanel {
  constructor(private readonly deps: PersonaPanelDeps) {}

  /** Dispatch the chosen personas; returns one debate entry per persona (order preserved). */
  async dispatch(personas: string[], ctx: PersonaContext): Promise<PersonaDebateEntry[]> {
    const { config, hostSynthesize, log } = this.deps
    if (!config.enabled || personas.length === 0) {
      return personas.length ? hostSynthesize(personas, ctx) : []
    }

    const results: (PersonaDebateEntry | null)[] = new Array(personas.length).fill(null)
    const fellBack: number[] = []
    let queue = 0
    const worker = async (): Promise<void> => {
      while (queue < personas.length) {
        const i = queue++
        const name = personas[i]
        const spec = getPersona(name)
        if (!spec) { results[i] = { persona: name, stance: '', objections: [] }; continue }
        const entry = await this.runOne(spec.systemPrompt, name, ctx)
        if (entry) results[i] = entry
        else fellBack.push(i)
      }
    }
    const workers = Array.from({ length: Math.max(1, config.concurrency) }, () => worker())
    await Promise.all(workers)

    // Any persona that failed all retries → host-synthesise as a group (single steer).
    if (fellBack.length && config.fallbackToHost) {
      log?.(`persona-panel: ${fellBack.length}/${personas.length} fell back to host-synthesis`)
      const fallbackNames = fellBack.map((i) => personas[i])
      const synthesized = await hostSynthesize(fallbackNames, ctx)
      fellBack.forEach((i, k) => { results[i] = synthesized[k] ?? { persona: personas[i], stance: '', objections: [] } })
    } else if (fellBack.length) {
      fellBack.forEach((i) => { results[i] = { persona: personas[i], stance: '', objections: [] } })
    }
    return results.map((r, i) => r ?? { persona: personas[i], stance: '', objections: [] })
  }

  /** One persona with bounded 429 backoff. Returns null if it should fall back. */
  private async runOne(systemPrompt: string, persona: string, ctx: PersonaContext): Promise<PersonaDebateEntry | null> {
    const { runner, config } = this.deps
    const task = OBJECTION_TASK(ctx)
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const res = await runner.run(systemPrompt, task)
      if (res.ok) return parseObjectionJson(persona, res.text)
      if (res.failure === 'rate_limit' && attempt < config.maxRetries) {
        await sleep(500 * 2 ** attempt) // 500ms, 1s, 2s …
        continue
      }
      return null // unavailable/error/empty/exhausted → caller decides fallback
    }
    return null
  }
}
```

**Step 2 — Test (`tests/persona/persona-panel.test.ts`)** with a mock runner (no network):
- All personas succeed → one entry each, objections parsed from JSON, order preserved.
- A persona returns `rate_limit` twice then ok → retried, succeeds (assert backoff via fake timers or a call counter).
- A persona always fails → falls back; assert `hostSynthesize` called with exactly the failed persona names, results spliced into the right slots.
- `config.enabled=false` → `hostSynthesize` called for all, runner never called.
- `config.fallbackToHost=false` + failure → empty objections, `hostSynthesize` not called.
- Concurrency cap respected (instrument the mock to record max simultaneous in-flight).
- Tolerant JSON parse: fenced JSON, leading prose, malformed → empty objections (never throws).

**Step 3 — Run** → PASS. **Step 4 — Commit:** `feat(persona): PersonaPanel with concurrency cap, 429 backoff, host fallback`

---

## Task 5: RelevanceSelector — fire only when necessary (Lane C)

**Files:**
- Create: `src/persona/relevance-selector.ts`
- Test: `tests/persona/relevance-selector.test.ts`

**Step 1 — Write `src/persona/relevance-selector.ts`:**
```ts
import type { PersonaSessionRunner } from './types.js'
import { PERSONA_REGISTRY } from './persona-registry.js'

/** Always-fire core — never gated out. */
export const CORE_PERSONAS = ['user', 'developer']

export interface RelevanceDeps {
  runner: PersonaSessionRunner
  log?: (msg: string) => void
}

/**
 * Pick which personas are worth firing for `idea`, capped at `max`.
 * CORE_PERSONAS are always included. The rest are chosen by one cheap LLM call;
 * on any failure, degrade to "first `max` by registry order" (deterministic).
 */
export async function selectRelevantPersonas(
  deps: RelevanceDeps,
  idea: string,
  candidates: string[],
  max: number,
): Promise<string[]> {
  if (max <= 0) return []
  const core = CORE_PERSONAS.filter((c) => candidates.includes(c)).slice(0, max)
  const optional = candidates.filter((c) => !core.includes(c))
  const slots = max - core.length
  if (slots <= 0 || optional.length === 0) return core

  const hints = optional.map((n) => `- ${n}: ${PERSONA_REGISTRY[n]?.relevanceHint ?? ''}`).join('\n')
  const task = [
    `Task idea: ${idea}`,
    '',
    'Which of these reviewer roles are genuinely relevant to THIS task? Skip ones that do not apply (e.g. accessibility for a non-UI task).',
    hints,
    '',
    `Reply ONLY as a JSON array of at most ${slots} role names, most relevant first. No prose.`,
  ].join('\n')

  const runner = deps.runner.ask ?? deps.runner.run
  let chosen: string[] = []
  try {
    const res = await runner.call(deps.runner, 'You select the minimal set of relevant reviewer roles for a software task.', task)
    if (res.ok) {
      const m = res.text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/)
      if (m) chosen = (JSON.parse(m[0]) as unknown[]).filter((x): x is string => typeof x === 'string')
    }
  } catch { /* degrade below */ }

  const valid = chosen.filter((n) => optional.includes(n)).slice(0, slots)
  const picked = valid.length ? valid : optional.slice(0, slots) // deterministic degrade
  return [...core, ...picked]
}
```

**Step 2 — Test:** core always included; respects `max`; valid LLM picks honored; invalid/failed LLM call → deterministic first-N degrade; `max=0` → empty; never returns a non-candidate.

**Step 3 — Run** → PASS. **Step 4 — Commit:** `feat(persona): relevance selector (core + LLM-gated extras, deterministic degrade)`

---

## Task 6: Wire PersonaPanel into P2 (Lane D)

**Files:**
- Modify: `src/phases/p2-elaborate.ts`
- Test: `tests/persona/p2-panel-wiring.test.ts` (+ keep `tests/phases/p1-p3.test.ts` green)

**Approach:** add an optional `panel?: PersonaPanel` + `selector?` deps to `P2Elaborate`. When present and `panelPersonas>0`, run the panel BEFORE the steer, then feed the host the verbatim objections to write into `personaDebate`. When absent (or panel disabled), behavior is exactly today's host-synthesis prompt (back-compat — existing tests pass unchanged).

**Step 1 — Add a constructor dep (optional, defaulted):**
```ts
constructor(
  private readonly hostAgent: HostAgent,
  private readonly outputDir: string,
  private readonly timeoutMs?: number,
  private readonly panel?: PersonaPanel,        // NEW — undefined => legacy host-synthesis
) {}
```

**Step 2 — In `execute`,** when `this.panel && panelPersonas>0`:
1. Select personas: `const personas = await selectRelevantPersonas(...candidates = ALL_PERSONAS, max = panelPersonas)`.
   (Selector lives in the panel deps; expose `panel.select(idea, candidates, max)` thin wrapper, or pass selector in. Keep ALL_PERSONAS as the P2 candidate set.)
2. `const debate = await this.panel.dispatch(personas, { phase:'P2', idea: ctx.p1.idea ?? ctx.p1.spec, spec: ctx.p1.spec, stackAdr: ctx.p1.stackAdr })`.
3. Build the instruction with a NEW branch: instead of "adopt each persona", say *"The persona panel (independent reviewers) returned these objections — write them VERBATIM into personaDebate, then build the domainModel:"* + `JSON.stringify(debate)`. Host still writes the file (steer-then-verify preserved).
4. The gate is unchanged (personaDebate non-empty when panelPersonas>0).

`hostSynthesize` passed to the panel = a closure that runs the **current** host-synthesis prompt for the given personas (reuse `buildP2Instruction`'s panel section logic for the fallback subset). Factor the host-synthesis prompt into a small helper so both the panel-fallback and the legacy path share it.

**Step 3 — Tests:** new `tests/persona/p2-panel-wiring.test.ts` with a mock panel asserts: panel.dispatch called with the selected personas; the steer prompt contains the verbatim objections; output personaDebate equals the panel result; XS (panelPersonas=0) skips the panel entirely; when `panel` undefined the legacy prompt is used (snapshot the "host-synthesised" string). Keep `tests/phases/p1-p3.test.ts` green (legacy path unchanged when no panel injected).

**Step 4 — Run** `npx vitest run tests/persona tests/phases/p1-p3.test.ts` → PASS. **Step 5 — Commit:** `feat(persona): P2 runs the real panel, host writes verbatim objections`

---

## Task 7: Wire PersonaPanel into P3 (Lane E)

**Files:**
- Modify: `src/phases/p3-plan.ts`
- Test: `tests/persona/p3-panel-wiring.test.ts` (+ keep `tests/phases/p1-p3.test.ts` green)

Same pattern as Task 6, plus the re-plan loop:
- Candidate set = `ALL_PLAN_PERSONAS` minus `legal` (already removed in the registry; update `ALL_PLAN_PERSONAS` to drop `legal` and add `autonomous-engineer`, OR derive the P3 candidate list from `ALL_PERSONA_NAMES`). Max = `min(panelPersonas*2, ALL candidates)`.
- Each re-plan round: re-dispatch the panel with the revised plan summary in `PersonaContext.planSummary` so personas object against the **current** plan. `panelObjCount` = total objections across the returned debate. Convergence + `MAX_REPLAN_ROUNDS=3` + operatorBrief unchanged.
- XS (panelPersonas=0) still skips the panel and sets `panelObjCount=0`.
- Legacy path (no panel injected) unchanged.

**Tests:** panel called each round with the revised plan; `panelObjCount` equals summed objections; zero objections → accept; persistent objections → cap at 3 + operatorBrief; XS skip; legacy path intact. Keep `tests/phases/p1-p3.test.ts` and `tests/engine/complexity.test.ts` green.

**Commit:** `feat(persona): P3 panel feeds panelObjCount + re-plan loop; drop legal, add autonomous-engineer`

---

## Task 8: Controller + extension wiring (Lane F)

**Files:**
- Modify: `src/host/controller.ts` (construct/ hold a `PersonaPanel`, pass to the 6 `new P2Elaborate(...)` / `new P3Plan(...)` sites)
- Modify: `src/extension/index.ts` (`buildExtension`: load `PersonaConfig`, build `GeminiSessionRunner` when a key exists, build `PersonaPanel` with the host-synthesis closure, thread into controller opts)
- Test: `tests/host/persona-wiring.test.ts` (+ keep `tests/host/controller.test.ts`, `tests/integration/e2e-pi-loop.test.ts` green)

**Step 1 — Controller:** add `personaPanel?: PersonaPanel` to `ControllerOptions`. Store `this.personaPanel = opts.personaPanel`. Pass it as the new 4th arg to every `new P2Elaborate(...)` and `new P3Plan(...)` (6 sites: 912, 939, 1031, 1594, 2378, 2387). When `undefined`, phases use the legacy host-synthesis path (all existing controller tests stay green — they inject no panel).

**Step 2 — Extension (`buildExtension`):**
```ts
import { loadPersonaConfig } from '../persona/persona-config.js'
import { GeminiSessionRunner } from '../persona/session-runner.js'
import { PersonaPanel } from '../persona/persona-panel.js'
// after loadDotEnv():
const personaConfig = loadPersonaConfig()
let personaPanel: PersonaPanel | undefined
const geminiKey = process.env['GEMINI_API_KEY']
if (personaConfig.enabled && geminiKey) {
  const runner = new GeminiSessionRunner({ model: personaConfig.model, apiKey: geminiKey, thinkingLevel: 'low' })
  personaPanel = new PersonaPanel({
    runner,
    config: personaConfig,
    hostSynthesize: /* closure that steers the host with the legacy persona prompt */,
    log: (m) => { /* journal/activity log */ },
  })
}
// pass personaPanel into controller opts
```
The `hostSynthesize` closure runs the host (existing `HostAgent.steer`) with the legacy persona prompt and parses the resulting `personaDebate`. Keep it small; reuse the P2/P3 host-synthesis helper from Tasks 6/7.

**Step 3 — Tests:** `tests/host/persona-wiring.test.ts`: controller with an injected mock panel routes P2/P3 through it; controller with no panel uses legacy. `buildExtension` builds a panel when `GEMINI_API_KEY` set + `enabled`, and `undefined` when no key. Keep `tests/host/controller.test.ts` + `tests/integration/e2e-pi-loop.test.ts` green.

**Step 4 — Run full suite** `npx vitest run` → all green (1115 + new). **Step 5 — Commit:** `feat(persona): wire PersonaPanel through controller + extension (degrades without GEMINI key)`

---

## Task 9: Cleanup + live-test readiness

**Files:**
- Remove: `persona-spike.mjs` (throwaway).
- Modify: `docs/` runbook note + `/autodev-doctor` (add a `persona-subagents: enabled/disabled (model)` line so the operator can see panel status).
- Modify: `.env.example` (if present) / README — document `AUTODEV_PERSONA_*` env knobs.

**Step 1 — `rm persona-spike.mjs`.**
**Step 2 — Add a doctor probe line** showing persona-subagent status + model + whether the Gemini key resolved (no secret printed).
**Step 3 — `npx tsc --noEmit && npm run build && npx vitest run`** → green.
**Step 4 — `pi install /root/pi-autodev`.**
**Step 5 — Commit:** `chore(persona): doctor status, docs, remove spike`

---

## Acceptance Criteria (live test)

After `pi install` + restart, run a meatier idea that sizes M+ (e.g. `build a token-bucket rate limiter with sliding-window mode and tests`):
- `.autodev/journal.jsonl` shows the panel dispatching real persona subagents (not "host-synthesised").
- `p2-domain.json` / `p3-plan.json` contain `personaDebate` objections that read like distinct, role-grounded reviewers.
- With `GEMINI_API_KEY` unset → run still completes via host-synthesis (no hard stall).
- Force a 429 (tiny concurrency + many personas) → panel backs off then falls back; run still completes.
- Full suite stays green (`npx vitest run`).

## Risks / Mitigations

- **Gemini rate limits** → concurrency cap (default 2) + backoff + host fallback; never hard-stall.
- **`createAgentSession` return-shape drift** → executor verifies `.session` access against `sdk.d.ts` before finishing Task 3; pure parsers are unit-tested independently.
- **Cost/latency of web research per persona** → `webResearch` toggle (Task 1 config); default may be turned off if live latency is too high (operator-tunable without a rebuild).
- **Existing tests assume host-synthesis** → panel is opt-in via injection; legacy path byte-for-byte unchanged when no panel is wired, so `tests/phases/p1-p3.test.ts` stays green; new behavior covered by new test files.

## Deferred (NOT in this plan)
- Per-persona LIVE web search (needs a custom `web_search` ToolDefinition + a search-API key, e.g. Brave/Serper/Tavily — pi has no built-in web tool and no Gemini grounding; confirmed by exploration). This pass grounds personas in P1's already-gathered research instead.
- n8n / n8n-mcp integration (separate follow-up F2).
- Per-persona model heterogeneity (all personas share one model here).

---

# Critic-Driven Revisions (v2 — BINDING; these override the tasks above where they conflict)

A ralplan-style critic pass (architect + critic + web-search feasibility explorer) returned REJECT on v1 with 2 CRITICAL + 4 MAJOR findings. The following revisions are binding for execution.

**R1 — Web research = inject P1 research, NOT in-session search (fixes CRITICAL C1).**
pi ships NO built-in web tool, and pi's Google provider does NOT expose Gemini grounding (verified in `node_modules/.../pi-ai/dist/providers/google*.js`). Persona sessions run `noTools:'all'` so they cannot search. Therefore: the panel grounds personas in P1's already-gathered `webResearch[]` (the spec's `{url,title,summary}[]`, which P1 always produces). `PersonaContext` gains `research?: string` (a compact digest of P1's webResearch summaries). `buildExtension`/phases pass it. `PersonaConfig.webResearch` now means "include P1 research digest in persona prompts" (default `true`, cheap, no API key). True per-persona live search is deferred (custom `web_search` ToolDefinition + search-API key — documented in Deferred).

**R2 — Own the test changes; `agents/*.md` is a SEPARATE namespace (fixes CRITICAL C2).**
The new `PERSONA_REGISTRY` is ONLY the P2/P3 host-synthesis/panel namespace. DO NOT touch `agents/*.md` or `tests/agents/agents.test.ts` (those 10 agent files are an unrelated subagent-definition namespace). Task 7 MUST explicitly edit `src/phases/p3-plan.ts:23` to derive `ALL_PLAN_PERSONAS` from `ALL_PERSONA_NAMES` (registry), and Tasks 6/7 MUST update the assertions in `tests/phases/p1-p3.test.ts` that reference the old persona lists (remove `legal` expectations; the XL "10 personas" count still holds — 10 registry entries; if any test asserts exact ordering, re-derive from registry order: user, developer, security, ops, product-manager, architect, qa, accessibility, performance, autonomous-engineer).

**R3 — Build PersonaPanel INSIDE the Controller; concrete `hostSynthesize` (fixes MAJOR M3 circular dep).**
Do NOT build the panel in `buildExtension`. Instead: `ControllerOptions` gains `personaRunner?: PersonaSessionRunner` and `personaConfig?: PersonaConfig` (built in `buildExtension` from env). The Controller constructs `this.personaPanel = new PersonaPanel({ runner, config, hostSynthesize: this._personaHostSynthesize.bind(this), log })` in its constructor, where `_personaHostSynthesize(personas, ctx)` is a private method that calls `this.hostAgent.steer()` with the legacy persona prompt (built by a shared helper `src/persona/host-synthesis-fallback.ts → buildHostSynthesisPrompt(personas, ctx, outputFile)`), then reads + parses the written `personaDebate`. This resolves the circular dependency (panel needs hostAgent, which lives on the Controller).

**R4 — Panel-direct write of `personaDebate` (fixes MAJOR M4 double-source-of-truth).**
When the panel is active, the phase does NOT trust the host to transcribe objections. Flow: (1) run `panel.dispatch(...)` → `panelDebate`; (2) build the host instruction WITHOUT the persona section (host only produces `domainModel` for P2 / plan artifacts for P3); (3) after the steer writes the file, the phase code re-reads it, sets `raw.personaDebate = panelDebate` (P2) or recomputes `panelObjCount` from `panelDebate` (P3), writes it back, THEN validates. The host never authors the objections when the panel is active.

**R5 — `selectRelevantPersonas` delegation + Gemini session shape (fixes MAJOR M6).**
Replace the `.call()` pattern with: `const res = deps.runner.ask ? await deps.runner.ask(sys, task) : await deps.runner.run(sys, task)`. In `GeminiSessionRunner.run`, destructure `const { session } = await createAgentSession(...)` and use `session.prompt(...)`, `session.messages`, `session.dispose()` (NOT `session.session.*` — the v1 code double-nested). Wrap `session.prompt` in a per-call timeout (default 30s via `Promise.race` with an abort) so a hung Gemini call cannot stall the phase.

**R6 — Rate-limit hardening (fixes MAJOR M5).**
`DEFAULT_PERSONA_CONFIG.concurrency = 1` (free-tier 10 RPM safe). Add a circuit breaker to `PersonaPanel`: after `CIRCUIT_BREAK_THRESHOLD = 3` consecutive session failures, short-circuit all remaining personas straight to host-synthesis (skip per-persona retry/backoff). Add a panel-wide soft time budget (`AUTODEV_PERSONA_BUDGET_MS`, default 120000); when exceeded, remaining personas go to fallback. Document honestly in Risks: on free-tier Gemini, M+ runs will mostly fall back to host-synthesis (adds latency, guarantees no regression); the panel's full value lands on paid-tier or low-persona (S/M) runs.

**R7 — Feed real objection text into P3 re-plan rounds (fixes MAJOR finding 4).**
When the panel is active, `lastObjections` must serialize the actual objections, not just the count: `Round N panel objections:\n` + `debate.map(d => '- ' + d.persona + ': ' + d.objections.join('; '))`. The host needs the concrete objections to revise the plan.

**R8 — Minor hardening.**
`parseObjectionJson` logs via `deps.log?` on parse failure. `PersonaContext` gains `tier?: ComplexityTier` (for future tier-aware behavior; populate from sizing). `PersonaDebateEntry` is defined ONCE — move the canonical definition to `src/persona/types.ts` and re-export from `phase-output.ts` (or import the existing one into persona/types and re-export; pick the import-existing direction to minimize churn: `src/persona/types.ts` re-exports `PersonaDebateEntry` from `../phases/phase-output.js`).

**Execution note:** v1's Tasks 1-9 remain the skeleton; apply R1-R8 as you implement each. The DAG is unchanged except the panel is constructed in the Controller (Lane F), not the extension.
