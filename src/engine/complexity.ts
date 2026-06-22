// M3: complexity scorer — pure function, no side effects.
// Score = f(file-estimate, novelty, blast-radius, irreversibility)
// Tiers: XS · S · M · L · XL  (spec §6)

export type Novelty = 'low' | 'med' | 'high'
export type Irreversibility = 'low' | 'med' | 'high'
export type ComplexityTier = 'XS' | 'S' | 'M' | 'L' | 'XL'

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
