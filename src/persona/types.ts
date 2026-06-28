// Persona subagent shared types. PersonaDebateEntry is the SAME type the phase output
// uses (re-exported, single source of truth) so panel results write straight into the
// p2/p3 JSON without a structural mismatch.
import type { PersonaDebateEntry } from '../phases/phase-output.js'
export type { PersonaDebateEntry }

/** What the panel is reasoning about for a given phase. */
export interface PersonaContext {
  phase: 'P2' | 'P3'
  idea: string
  spec?: string
  stackAdr?: string
  domainModel?: string
  planSummary?: string
  /** R1: compact digest of P1's already-gathered web research (no live search). */
  research?: string
  /** R8: complexity tier (XS/S/M/L/XL) for future tier-aware behavior. */
  tier?: string
}

export interface PersonaRunResult {
  ok: boolean
  text: string
  /** Set when ok===false. */
  failure?: 'rate_limit' | 'unavailable' | 'empty' | 'error'
  errorMessage?: string
}

/** One isolated reasoning run. Implemented by Gemini (real) or a mock (tests). */
export interface PersonaSessionRunner {
  run(systemPrompt: string, task: string): Promise<PersonaRunResult>
  /** Optional cheap one-shot used by the relevance selector (defaults to run). */
  ask?(systemPrompt: string, task: string): Promise<PersonaRunResult>
}

/** Host-synthesis fallback signature (the existing steer path), injected into the panel. */
export type HostSynthesize = (personas: string[], ctx: PersonaContext) => Promise<PersonaDebateEntry[]>
