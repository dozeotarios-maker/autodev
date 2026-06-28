export interface PersonaConfig {
  /** Explicit model id; '' = the session's SELECTED/default model (Claude when you run Claude). */
  model: string
  /** Provider for an explicit model ('google'|'openai'|'anthropic'); '' = inferred / selected. */
  provider: string
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
  model: '', // selected/session model
  provider: '',
  concurrency: 1, // safe for rate-limited providers
  webResearch: true,
  fallbackToHost: true,
  maxRetries: 2,
  timeoutMs: 30_000,
  budgetMs: 120_000,
  enabled: true,
}

/** Infer the provider from a model id when not explicitly set. */
function inferProvider(model: string): string {
  if (/gemini/i.test(model)) return 'google'
  if (/^(gpt|o\d)/i.test(model)) return 'openai'
  if (/claude/i.test(model)) return 'anthropic'
  return ''
}

/** Build config from env, falling back to defaults. All keys optional. */
export function loadPersonaConfig(env: NodeJS.ProcessEnv = process.env): PersonaConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = v === undefined ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const bool = (v: string | undefined, d: boolean): boolean =>
    v === undefined ? d : /^(1|true|yes|on)$/i.test(v)
  const model = env['AUTODEV_PERSONA_MODEL'] || ''
  return {
    model,
    provider: env['AUTODEV_PERSONA_PROVIDER'] || inferProvider(model),
    concurrency: Math.max(1, num(env['AUTODEV_PERSONA_CONCURRENCY'], DEFAULT_PERSONA_CONFIG.concurrency)),
    webResearch: bool(env['AUTODEV_PERSONA_WEB_RESEARCH'], DEFAULT_PERSONA_CONFIG.webResearch),
    fallbackToHost: bool(env['AUTODEV_PERSONA_FALLBACK'], DEFAULT_PERSONA_CONFIG.fallbackToHost),
    maxRetries: Math.max(0, num(env['AUTODEV_PERSONA_MAX_RETRIES'], DEFAULT_PERSONA_CONFIG.maxRetries)),
    timeoutMs: Math.max(1000, num(env['AUTODEV_PERSONA_TIMEOUT_MS'], DEFAULT_PERSONA_CONFIG.timeoutMs)),
    budgetMs: Math.max(1000, num(env['AUTODEV_PERSONA_BUDGET_MS'], DEFAULT_PERSONA_CONFIG.budgetMs)),
    // Default ON: personas use the selected/session model, which is always available.
    // Disable with AUTODEV_PERSONA_SUBAGENTS=0.
    enabled: bool(env['AUTODEV_PERSONA_SUBAGENTS'], true),
  }
}
