import { createAgentSession, ModelRegistry, AuthStorage, SessionManager } from '@earendil-works/pi-coding-agent'
import type { PersonaSessionRunner, PersonaRunResult } from './types.js'

/** Extract concatenated `text` parts from the last assistant message; ignore `thinking` parts. */
export function extractAssistantText(messages: unknown[]): {
  text: string
  stopReason?: string
  errorMessage?: string
} {
  const assistants = (messages as Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }>)
    .filter((m) => m?.role === 'assistant')
  const last = assistants[assistants.length - 1]
  if (!last) return { text: '' }
  const parts = Array.isArray(last.content) ? last.content : []
  const text = parts
    .filter((p): p is { type: string; text: string } =>
      typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text' &&
      typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join('')
  return { text, stopReason: last.stopReason, errorMessage: last.errorMessage }
}

export function classifyFailure(stopReason?: string, errorMessage?: string): PersonaRunResult['failure'] {
  const blob = `${stopReason ?? ''} ${errorMessage ?? ''}`.toLowerCase()
  if (/429|quota|rate.?limit|resource_exhausted/.test(blob)) return 'rate_limit'
  if (/unavailable|econnrefused|enotfound|fetch failed|timeout|etimedout/.test(blob)) return 'unavailable'
  if (stopReason === 'error') return 'error'
  return undefined
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('persona prompt timeout')), ms)
  })
  // Clear the timer on BOTH paths so a fast happy-path response leaves no dangling timer
  // (dozens would otherwise accumulate across personas × retries × rounds).
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export interface PiRunnerOptions {
  /** Explicit model id; empty/undefined → the session's SELECTED/default model. */
  model?: string
  /** Provider for an explicit model ('google' | 'openai' | 'anthropic' …). */
  provider?: string
  /** API key for the explicit provider (e.g. a Gemini key for 'google'). Omit for default auth. */
  apiKey?: string
  thinkingLevel?: 'low' | 'medium' | 'high'
  timeoutMs?: number
}

/**
 * PersonaSessionRunner backed by an isolated pi `createAgentSession`. By DEFAULT it runs the
 * SELECTED model — the one the host pi session uses (Claude when you run Claude) — by omitting
 * the model so createAgentSession resolves it from settings. Set model+provider to override
 * (e.g. a Gemini model). Each run() is a fresh in-memory session, disposed after.
 */
export class PiSessionRunner implements PersonaSessionRunner {
  private readonly auth: AuthStorage
  private readonly registry: ModelRegistry
  private model: ReturnType<ModelRegistry['find']> | undefined
  private hostModel: ReturnType<ModelRegistry['find']> | undefined
  private resolved = false

  constructor(private readonly opts: PiRunnerOptions = {}) {
    this.auth = AuthStorage.create()
    if (opts.provider && opts.apiKey) this.auth.setRuntimeApiKey(opts.provider, opts.apiKey)
    this.registry = ModelRegistry.create(this.auth)
  }

  private resolveModel(): void {
    if (this.resolved) return
    // Explicit override only; otherwise leave undefined so createAgentSession picks the
    // session's selected/default model.
    if (this.opts.model && this.opts.provider) {
      this.model = this.registry.find(this.opts.provider, this.opts.model)
    }
    this.resolved = true
  }

  /** Set by the controller from ctx.model so personas run the operator's chosen session model. */
  setHostModel(model: unknown): void {
    this.hostModel = (model ?? undefined) as ReturnType<ModelRegistry['find']>
  }

  async run(systemPrompt: string, task: string): Promise<PersonaRunResult> {
    this.resolveModel()
    // Priority: explicit AUTODEV_PERSONA_MODEL override > the host session's exact model
    // (ctx.model) > omit (createAgentSession falls back to the settings default).
    const chosen = this.model ?? this.hostModel

    let created
    try {
      created = await createAgentSession({
        ...(chosen ? { model: chosen } : {}),
        modelRegistry: this.registry,
        authStorage: this.auth,
        sessionManager: SessionManager.inMemory(),
        noTools: 'all',
        ...(this.opts.thinkingLevel ? { thinkingLevel: this.opts.thinkingLevel } : {}),
      })
    } catch (e) {
      return { ok: false, text: '', failure: 'unavailable', errorMessage: e instanceof Error ? e.message : String(e) }
    }

    const { session } = created
    try {
      // dispose() in the finally is best-effort: pi exposes no AbortSignal on prompt(), so a
      // timed-out call may still run to completion in the background (bounded by the model).
      // A distinctive separator avoids colliding with `---` rules inside the task text.
      await withTimeout(session.prompt(`${systemPrompt}\n\n=== TASK ===\n\n${task}`), this.opts.timeoutMs ?? 30_000)
      const { text, stopReason, errorMessage } = extractAssistantText(session.messages as unknown[])
      const failure = classifyFailure(stopReason, errorMessage)
      if (failure) return { ok: false, text, failure, errorMessage }
      if (!text.trim()) return { ok: false, text: '', failure: 'empty' }
      return { ok: true, text }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, text: '', failure: /timeout/i.test(msg) ? 'unavailable' : 'error', errorMessage: msg }
    } finally {
      try { session.dispose() } catch { /* best effort */ }
    }
  }

  async ask(systemPrompt: string, task: string): Promise<PersonaRunResult> {
    return this.run(systemPrompt, task)
  }
}
