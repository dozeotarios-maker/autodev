// R3: the host-synthesis fallback the PersonaPanel calls when Gemini sessions fail, and
// the shared P1-research digest. The closure that actually steers the host lives on the
// Controller (it owns the HostAgent); this module only builds the prompt + parses results.
import type { PersonaContext, PersonaDebateEntry } from './types.js'
import { getPersona } from './persona-registry.js'

/** Compact digest of P1's already-gathered web research, for grounding persona prompts (R1). */
export function digestResearch(
  entries: Array<{ title?: string; summary?: string }> | undefined,
): string {
  if (!entries || entries.length === 0) return ''
  return entries
    .slice(0, 5)
    .map((e) => `- ${e.title ?? 'source'}: ${e.summary ?? ''}`.trim())
    .join('\n')
}

/** Legacy host-synthesis prompt for a persona subset — used as the panel's fallback. */
export function buildHostSynthesisPrompt(personas: string[], ctx: PersonaContext, outputFile: string): string {
  const lines = personas
    .map((p) => {
      const spec = getPersona(p)
      return `- **${p}**${spec ? ` (${spec.relevanceHint})` : ''}: act as a ${p}; list your top concrete objections to the work.`
    })
    .join('\n')
  const context = [
    `Idea: ${ctx.idea}`,
    ctx.spec ? `Spec: ${ctx.spec}` : '',
    ctx.domainModel ? `Domain model: ${ctx.domainModel}` : '',
    ctx.planSummary ? `Plan: ${ctx.planSummary}` : '',
    ctx.research ? `Current best-practice research:\n${ctx.research}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    '## Persona debate (host-synthesised fallback)',
    context,
    '',
    'Adopt each persona below in turn and list their concrete objections:',
    lines,
    '',
    `Write ONLY a JSON array to ${outputFile} of the form:`,
    '[{"persona":"<name>","stance":"<one sentence>","objections":["<objection>"]}]',
    'One array element per persona, in the order listed. Then confirm "persona debate written".',
  ].join('\n')
}

/** Coerce arbitrary parsed JSON into PersonaDebateEntry[] (tolerant, never throws). */
export function coercePersonaDebate(raw: unknown, personas: string[]): PersonaDebateEntry[] {
  const arr = Array.isArray(raw) ? raw : []
  const byName = new Map<string, PersonaDebateEntry>()
  for (const e of arr) {
    if (typeof e !== 'object' || e === null) continue
    const o = e as { persona?: unknown; stance?: unknown; objections?: unknown }
    const persona = typeof o.persona === 'string' ? o.persona : ''
    if (!persona) continue
    byName.set(persona, {
      persona,
      stance: typeof o.stance === 'string' ? o.stance : '',
      objections: Array.isArray(o.objections) ? o.objections.filter((x): x is string => typeof x === 'string') : [],
    })
  }
  // Return one entry per requested persona, preserving order; fill misses with empties.
  return personas.map((p) => byName.get(p) ?? { persona: p, stance: '', objections: [] })
}
