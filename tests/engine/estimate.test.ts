import { describe, it, expect } from 'vitest'
import { SprintContractRegistry, FeatureContract } from '../../src/engine/estimate.js'
import { H1Contract } from '../../src/safety/contract.js'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'

describe('M3: H8 scope-preview + H6 sprint contract', () => {
  it('emits a scope preview for L/XL tiers', () => {
    const registry = new SprintContractRegistry()
    const preview = registry.scopePreview('XL', {
      files: 20,
      novelty: 'high',
      blastRadius: 5,
      irreversibility: 'high',
    })
    expect(preview).toBeTruthy()
    expect(typeof preview!.estimatedFiles).toBe('number')
    expect(typeof preview!.estimatedPhases).toBe('number')
  })

  it('no preview required for XS/S tiers (returns null)', () => {
    const registry = new SprintContractRegistry()
    const preview = registry.scopePreview('XS', {
      files: 1,
      novelty: 'low',
      blastRadius: 1,
      irreversibility: 'low',
    })
    expect(preview).toBeNull()
  })

  it('registers a sprint contract (H6) for a feature', () => {
    const registry = new SprintContractRegistry()
    const contract: FeatureContract = {
      featureId: 'feat-login',
      doneCriteria: ['login endpoint returns 200', 'JWT issued', 'test passing'],
    }
    registry.register(contract)
    const retrieved = registry.get('feat-login')
    expect(retrieved).toBeDefined()
    expect(retrieved!.doneCriteria).toHaveLength(3)
  })

  it('H6: completion claim rejected when no sprint contract exists', async () => {
    const registry = new SprintContractRegistry()
    const result = registry.canClaim('feat-unknown')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/sprint contract/i)
  })

  it('H6: completion claim allowed when contract exists', () => {
    const registry = new SprintContractRegistry()
    registry.register({
      featureId: 'feat-auth',
      doneCriteria: ['auth works'],
    })
    const result = registry.canClaim('feat-auth')
    expect(result.allowed).toBe(true)
  })

  it('H6: H1 gate integration — completion requires evidence', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-test-'))
    const contract = new H1Contract(tmpDir, 'sprint-test')
    await contract.init(['feat-auth-done'])

    const denied = await contract.flip('feat-auth-done')
    expect(denied.ok).toBe(false)

    contract.recordEvidenceRead('feat-auth-done')
    const allowed = await contract.flip('feat-auth-done')
    expect(allowed.ok).toBe(true)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
