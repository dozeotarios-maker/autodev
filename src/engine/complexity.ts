// M3: complexity scorer — pure function, no side effects.
// Score = f(file-estimate, novelty, blast-radius, irreversibility)
// Tiers: XS · S · M · L · XL  (spec §6)

export type Novelty = 'low' | 'med' | 'high'
export type Irreversibility = 'low' | 'med' | 'high'
export type ComplexityTier = 'XS' | 'S' | 'M' | 'L' | 'XL'

// ── Sizing (§6 table) ─────────────────────────────────────────────────────────

export interface Sizing {
  panelPersonas: number
  laneCap: number
  reviewRounds: number
  thinkingLevel: 'low' | 'medium' | 'high' | 'xhigh'
}

const SIZING_TABLE: Record<ComplexityTier, Sizing> = {
  XS: { panelPersonas: 0, laneCap: 1, reviewRounds: 1, thinkingLevel: 'low' },
  S:  { panelPersonas: 2, laneCap: 2, reviewRounds: 1, thinkingLevel: 'medium' },
  M:  { panelPersonas: 4, laneCap: 3, reviewRounds: 2, thinkingLevel: 'high' },
  L:  { panelPersonas: 6, laneCap: 5, reviewRounds: 3, thinkingLevel: 'high' },
  XL: { panelPersonas: 8, laneCap: 5, reviewRounds: 5, thinkingLevel: 'xhigh' },
}

export function tierSizing(tier: ComplexityTier): Sizing {
  return { ...SIZING_TABLE[tier] }
}

export const DEFAULT_SIZING: Sizing = tierSizing('M')

export interface ComplexityInput {
  files: number
  novelty: Novelty
  blastRadius: number   // 1–5 scale
  irreversibility: Irreversibility
}

export interface ComplexityResult {
  tier: ComplexityTier
  score: number
}

const NOVELTY_WEIGHT: Record<Novelty, number> = { low: 0, med: 2, high: 4 }
const IRREV_WEIGHT: Record<Irreversibility, number> = { low: 0, med: 2, high: 4 }

// Spec §6 thresholds (derived from XS/S/M/L/XL descriptions):
// XS ≤ 4, S ≤ 8, M ≤ 13, L ≤ 18, XL > 18
const THRESHOLDS: Array<[number, ComplexityTier]> = [
  [4, 'XS'],
  [8, 'S'],
  [13, 'M'],
  [18, 'L'],
]

// ── B1: Override-gear → tier mapping ─────────────────────────────────────────

export type OverrideGear = 'quick' | 'mid' | 'full'

const OVERRIDE_TIER: Record<OverrideGear, ComplexityTier> = { quick: 'XS', mid: 'M', full: 'XL' }

export function tierFromOverride(prefix: string): ComplexityTier | null {
  return OVERRIDE_TIER[prefix.toLowerCase() as OverrideGear] ?? null
}

// ── B1: ComplexityInput runtime validator ─────────────────────────────────────

const NOVELTY_VALUES = new Set<string>(['low', 'med', 'high'])
const IRREV_VALUES = new Set<string>(['low', 'med', 'high'])

export function isValidComplexityInput(x: unknown): x is ComplexityInput {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o['files'] === 'number' && o['files'] >= 1 && o['files'] <= 50 &&
    typeof o['novelty'] === 'string' && NOVELTY_VALUES.has(o['novelty']) &&
    typeof o['blastRadius'] === 'number' && o['blastRadius'] >= 1 && o['blastRadius'] <= 5 &&
    typeof o['irreversibility'] === 'string' && IRREV_VALUES.has(o['irreversibility'])
  )
}

export function scoreComplexity(input: ComplexityInput): ComplexityResult {
  const fileScore = Math.min(input.files, 20)              // cap raw file count contribution
  const blastScore = Math.min(input.blastRadius, 5) * 1.5
  const noveltyScore = NOVELTY_WEIGHT[input.novelty]
  const irrevScore = IRREV_WEIGHT[input.irreversibility]

  const score = fileScore + blastScore + noveltyScore + irrevScore

  let tier: ComplexityTier = 'XL'
  for (const [threshold, t] of THRESHOLDS) {
    if (score <= threshold) {
      tier = t
      break
    }
  }

  return { tier, score }
}
