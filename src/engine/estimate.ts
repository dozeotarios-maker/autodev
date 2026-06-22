// M3: H8 scope-preview (for L/XL tiers) + H6 sprint contract.
// Sprint contracts enforce per-feature done-definitions; H1 gate rejects claims without one.

import type { ComplexityInput, ComplexityTier } from './complexity.js'

// H8: scope preview — emitted for L/XL tiers before entering RUNNING.
export interface ScopePreview {
  estimatedFiles: number
  estimatedPhases: number
  tier: ComplexityTier
  note: string
}

// H6: sprint contract — per-feature done-definition.
export interface FeatureContract {
  featureId: string
  doneCriteria: string[]
}

export interface ClaimResult {
  allowed: boolean
  reason?: string
}

// Tiers that require a scope preview before go/no-go.
const PREVIEW_REQUIRED: Set<ComplexityTier> = new Set(['L', 'XL'])

// Spec §6: rough estimates per tier.
const TIER_ESTIMATES: Record<ComplexityTier, { files: number; phases: number }> = {
  XS: { files: 1, phases: 3 },
  S: { files: 3, phases: 4 },
  M: { files: 5, phases: 5 },
  L: { files: 8, phases: 6 },
  XL: { files: 15, phases: 6 },
}

export class SprintContractRegistry {
  private contracts = new Map<string, FeatureContract>()

  // H8: emit scope preview for L/XL (returns null for XS/S/M — no preview needed).
  scopePreview(tier: ComplexityTier, _input: ComplexityInput): ScopePreview | null {
    if (!PREVIEW_REQUIRED.has(tier)) return null

    const est = TIER_ESTIMATES[tier]
    return {
      estimatedFiles: est.files,
      estimatedPhases: est.phases,
      tier,
      note: `${tier} complexity — review scope before proceeding`,
    }
  }

  // H6: register a sprint contract for a feature.
  register(contract: FeatureContract): void {
    this.contracts.set(contract.featureId, contract)
  }

  get(featureId: string): FeatureContract | undefined {
    return this.contracts.get(featureId)
  }

  // H6: check if a completion claim is allowed (requires a registered sprint contract).
  canClaim(featureId: string): ClaimResult {
    if (!this.contracts.has(featureId)) {
      return {
        allowed: false,
        reason: `No sprint contract found for feature "${featureId}" — register a done-definition before claiming completion`,
      }
    }
    return { allowed: true }
  }
}
