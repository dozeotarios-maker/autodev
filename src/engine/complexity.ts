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
