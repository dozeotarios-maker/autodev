import type { PersonaConfig } from './persona-config.js'
import type { PersonaSessionRunner, PersonaContext, PersonaDebateEntry, HostSynthesize } from './types.js'
import { getPersona } from './persona-registry.js'
import { selectRelevantPersonas } from './relevance-selector.js'

/** After this many consecutive session failures, short-circuit the rest to host-synthesis. */
const CIRCUIT_BREAK_THRESHOLD = 3

export interface PersonaPanelDeps {
  runner: PersonaSessionRunner
  config: PersonaConfig
  /** Host-synthesis fallback (the existing steer path). */
  hostSynthesize: HostSynthesize
  log?: (msg: string) => void
  /** Injectable clock for deterministic budget tests. */
  now?: () => number
}

function buildObjectionTask(ctx: PersonaContext): string {
  const lines = [
    `Idea: ${ctx.idea}`,
    ctx.spec ? `Spec: ${ctx.spec}` : '',
    ctx.stackAdr ? `Stack: ${ctx.stackAdr}` : '',
    ctx.domainModel ? `Domain model: ${ctx.domainModel}` : '',
    ctx.planSummary ? `Plan: ${ctx.planSummary}` : '',
    ctx.research ? `Current best-practice research:\n${ctx.research}` : '',
  ].filter(Boolean)
  return [
    lines.join('\n'),
    '',
    'List your top objections or concerns from your role. If you have none that are concrete and relevant, return an empty array.',
    'Reply ONLY as JSON: {"stance":"<one sentence>","objections":["<objection>", ...]}. No prose, no markdown fence.',
  ].join('\n')
}

/** Tolerant parse of a persona's JSON reply; never throws. */
export function parseObjectionJson(persona: string, text: string, log?: (m: string) => void): PersonaDebateEntry {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as { stance?: unknown; objections?: unknown }
      return {
        persona,
        stance: typeof obj.stance === 'string' ? obj.stance : '',
        objections: Array.isArray(obj.objections) ? obj.objections.filter((o): o is string => typeof o === 'string') : [],
      }
    } catch {
      log?.(`persona-panel: ${persona} returned unparseable JSON`)
    }
  } else {
    log?.(`persona-panel: ${persona} returned no JSON object`)
  }
  return { persona, stance: '', objections: [] }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class PersonaPanel {
  private consecutiveFailures = 0

  constructor(private readonly deps: PersonaPanelDeps) {}

  /**
   * Pick the relevant personas for `idea` (capped at `max`), reusing the panel's runner.
   * Degrades to deterministic registry order when disabled or the selector LLM fails.
   */
  async select(idea: string, candidates: string[], max: number): Promise<string[]> {
    if (!this.deps.config.enabled) return candidates.slice(0, Math.max(0, max))
    return selectRelevantPersonas({ runner: this.deps.runner, log: this.deps.log }, idea, candidates, max)
  }

  /** Dispatch the chosen personas; one debate entry per persona, order preserved. */
  async dispatch(personas: string[], ctx: PersonaContext): Promise<PersonaDebateEntry[]> {
    const { config, log } = this.deps
    if (!config.enabled || personas.length === 0) {
      return personas.length ? this._safeHostSynthesize(personas, ctx) : []
    }

    this.consecutiveFailures = 0
    const now = this.deps.now ?? Date.now
    const start = now()
    const results: (PersonaDebateEntry | null)[] = new Array(personas.length).fill(null)
    const fellBack: number[] = []
    let queue = 0

    const worker = async (): Promise<void> => {
      // `i = queue++` claims an index atomically (no await between read and increment), so
      // concurrent workers never double-claim — including on the synchronous `continue` paths.
      let i: number
      while ((i = queue++) < personas.length) {
        const name = personas[i]
        const spec = getPersona(name)
        if (!spec) { results[i] = { persona: name, stance: '', objections: [] }; continue }
        // Circuit breaker + soft time budget → short-circuit straight to fallback. The
        // breaker is exact at concurrency=1 (the default) and best-effort above it.
        if (this.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD || now() - start > config.budgetMs) {
          fellBack.push(i)
          continue
        }
        const entry = await this.runOne(spec.systemPrompt, name, ctx)
        if (entry) { results[i] = entry; this.consecutiveFailures = 0 }
        else { fellBack.push(i); this.consecutiveFailures++ }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()))

    if (fellBack.length && config.fallbackToHost) {
      log?.(`persona-panel: ${fellBack.length}/${personas.length} fell back to host-synthesis`)
      const names = fellBack.map((i) => personas[i])
      const synth = await this._safeHostSynthesize(names, ctx)
      fellBack.forEach((i, k) => { results[i] = synth[k] ?? { persona: personas[i], stance: '', objections: [] } })
    } else if (fellBack.length) {
      fellBack.forEach((i) => { results[i] = { persona: personas[i], stance: '', objections: [] } })
    }
    return results.map((r, i) => r ?? { persona: personas[i], stance: '', objections: [] })
  }

  /** hostSynthesize must NEVER throw out of the panel — that is the "never block" contract. */
  private async _safeHostSynthesize(personas: string[], ctx: PersonaContext): Promise<PersonaDebateEntry[]> {
    try {
      return await this.deps.hostSynthesize(personas, ctx)
    } catch {
      this.deps.log?.('persona-panel: host-synthesis fallback threw; degrading to empty objections')
      return personas.map((p) => ({ persona: p, stance: '', objections: [] }))
    }
  }

  /** One persona with bounded 429 backoff. Returns null if it should fall back. */
  private async runOne(systemPrompt: string, persona: string, ctx: PersonaContext): Promise<PersonaDebateEntry | null> {
    const { runner, config } = this.deps
    const task = buildObjectionTask(ctx)
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const res = await runner.run(systemPrompt, task)
      if (res.ok) return parseObjectionJson(persona, res.text, this.deps.log)
      if (res.failure === 'rate_limit' && attempt < config.maxRetries) {
        await sleep(500 * 2 ** attempt) // 500ms, 1s, 2s …
        continue
      }
      return null
    }
    return null
  }
}
