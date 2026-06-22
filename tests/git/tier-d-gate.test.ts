// M5 tier-D gate test — D1 test-first
// H10: surfaces change/why/risk/rollback brief, blocks until async approve
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { TierDGate } from '../../src/git/tier-d-gate.js'

describe('M5: TierDGate — H10 brief + block-until-approve', () => {
  it('returns the emitted brief with all 4 required fields', async () => {
    const gate = new TierDGate()
    // inject an approval provider that immediately approves
    gate.setApprovalProvider(async (_brief) => true)

    const emitted: unknown[] = []
    gate.onBrief((brief) => emitted.push(brief))

    const approved = await gate.request('push to prod', {
      change: 'Deploy v2.0',
      why: 'Fixes critical bug',
      risk: 'Possible downtime 30s',
      rollback: 'git revert HEAD~1 && git push --force-with-lease',
    })

    expect(approved).toBe(true)
    expect(emitted).toHaveLength(1)
    const brief = emitted[0] as Record<string, string>
    expect(brief).toHaveProperty('change')
    expect(brief).toHaveProperty('why')
    expect(brief).toHaveProperty('risk')
    expect(brief).toHaveProperty('rollback')
    expect(brief.change).toBe('Deploy v2.0')
  })

  it('blocks (returns false) when approval provider rejects', async () => {
    const gate = new TierDGate()
    gate.setApprovalProvider(async (_brief) => false)

    const approved = await gate.request('dangerous action', {
      change: 'Wipe DB',
      why: 'Migration',
      risk: 'Irreversible',
      rollback: 'Restore from backup',
    })

    expect(approved).toBe(false)
  })

  it('blocks (returns false) when approval provider times out', async () => {
    const gate = new TierDGate({ timeoutMs: 50 })
    // provider never resolves within timeout
    gate.setApprovalProvider(() => new Promise(() => {}))

    const approved = await gate.request('timed-out action', {
      change: 'Something',
      why: 'Reason',
      risk: 'High',
      rollback: 'None',
    })

    expect(approved).toBe(false)
  })

  it('throws when no approval provider is set', async () => {
    const gate = new TierDGate()
    await expect(
      gate.request('action', {
        change: 'c',
        why: 'w',
        risk: 'r',
        rollback: 'rb',
      })
    ).rejects.toThrow(/no approval provider/)
  })
})
