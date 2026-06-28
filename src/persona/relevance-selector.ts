import type { PersonaSessionRunner } from './types.js'
import { PERSONA_REGISTRY } from './persona-registry.js'

/** Always-fire core — never gated out. */
export const CORE_PERSONAS = ['user', 'developer']

const SELECTOR_SYSTEM = 'You select the minimal set of relevant reviewer roles for a software task. Be ruthless: skip roles that do not apply.'

export interface RelevanceDeps {
  runner: PersonaSessionRunner
  log?: (msg: string) => void
}

/**
 * Pick which personas are worth firing for `idea`, capped at `max`.
 * CORE_PERSONAS are always included. The rest are chosen by one cheap LLM call;
 * on any failure or invalid reply, degrade to "first `max` by registry order".
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
    'Which of these reviewer roles are genuinely relevant to THIS task? Skip ones that do not apply (e.g. accessibility for a non-UI task, ops for a pure function).',
    hints,
    '',
    `Reply ONLY as a JSON array of at most ${slots} role names, most relevant first. No prose.`,
  ].join('\n')

  let chosen: string[] = []
  try {
    const res = deps.runner.ask
      ? await deps.runner.ask(SELECTOR_SYSTEM, task)
      : await deps.runner.run(SELECTOR_SYSTEM, task)
    if (res.ok) {
      const m = res.text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/)
      if (m) chosen = (JSON.parse(m[0]) as unknown[]).filter((x): x is string => typeof x === 'string')
    }
  } catch {
    deps.log?.('relevance-selector: degraded to deterministic registry order')
  }

  const valid = chosen.filter((n) => optional.includes(n)).slice(0, slots)
  const picked = valid.length ? valid : optional.slice(0, slots) // deterministic degrade
  return [...core, ...picked]
}
