export interface PersonaConfig {
  /** Gemini model id under the 'google' provider. */
  model: string
  /** Max concurrent isolated sessions (rate-limit guard). */
  concurrency: number
  /** Include P1's web-research digest in persona prompts (R1 — not live search). */
  webResearch: boolean
  /** Fall back to host-synthesis when a persona session fails. */
  fallbackToHost: boolean
  /** 429/backoff retries per session before giving up. */
  maxRetries: number
  /** Per-persona prompt timeout (ms). */
  timeoutMs: number
  /** Panel-wide soft time budget (ms); remaining personas fall back once exceeded. */
  budgetMs: number
  /** Run personas as real subagents at all. When false, always host-synthesise. */
  enabled: boolean
}

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  model: 'gemini-2.5-flash',
  concurrency: 1, // R6: free-tier 10 RPM safe
  webResearch: true,
  fallbackToHost: true,
  maxRetries: 2,
  timeoutMs: 30_000,
  budgetMs: 120_000,
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
    concurrency: Math.max(1, num(env['AUTODEV_PERSONA_CONCURRENCY'], DEFAULT_PERSONA_CONFIG.concurrency)),
    webResearch: bool(env['AUTODEV_PERSONA_WEB_RESEARCH'], DEFAULT_PERSONA_CONFIG.webResearch),
    fallbackToHost: bool(env['AUTODEV_PERSONA_FALLBACK'], DEFAULT_PERSONA_CONFIG.fallbackToHost),
    maxRetries: Math.max(0, num(env['AUTODEV_PERSONA_MAX_RETRIES'], DEFAULT_PERSONA_CONFIG.maxRetries)),
    timeoutMs: Math.max(1000, num(env['AUTODEV_PERSONA_TIMEOUT_MS'], DEFAULT_PERSONA_CONFIG.timeoutMs)),
    budgetMs: Math.max(1000, num(env['AUTODEV_PERSONA_BUDGET_MS'], DEFAULT_PERSONA_CONFIG.budgetMs)),
    // enabled defaults true ONLY if a Gemini key exists; else host-synthesis.
    enabled: bool(env['AUTODEV_PERSONA_SUBAGENTS'], !!env['GEMINI_API_KEY']),
  }
}
