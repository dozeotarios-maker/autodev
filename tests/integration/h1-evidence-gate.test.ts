// M-INT: H1 evidence-gate end-to-end
// contract starts all-false -> attempt flip without evidence (denied) ->
// produce evidence -> flip allowed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { H1Contract } from '../../src/safety/contract.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-h1-gate-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M-INT: H1 evidence-gate end-to-end', () => {
  it('all criteria start false after init', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['compiles', 'tests-pass', 'commit-landed', 'activity-log-full', 'contract-all-true'])

    const data = await contract.read()
    for (const [key, val] of Object.entries(data)) {
      expect(val, `criterion "${key}" should start false`).toBe(false)
    }
    expect(await contract.allPassed()).toBe(false)
  })

  it('flip without evidence is denied', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['compiles'])

    // No recordEvidenceRead call made — flip must be denied.
    const result = await contract.flip('compiles')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no evidence/i)

    // Criterion stays false.
    const data = await contract.read()
    expect(data['compiles']).toBe(false)
  })

  it('flip is allowed after evidence is recorded', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['compiles'])

    // Simulate reading evidence (e.g. reading tsc output file).
    contract.recordEvidenceRead('compiles')

    const result = await contract.flip('compiles')
    expect(result.ok).toBe(true)

    const data = await contract.read()
    expect(data['compiles']).toBe(true)
  })

  it('allPassed() remains false while any criterion is unflipped', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['a', 'b', 'c'])

    contract.recordEvidenceRead('a')
    contract.recordEvidenceRead('b')
    await contract.flip('a')
    await contract.flip('b')
    // 'c' not flipped.

    expect(await contract.allPassed()).toBe(false)
  })

  it('allPassed() returns true only when every criterion has evidence + flip', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    const criteria = ['compiles', 'tests-pass', 'commit-landed', 'activity-log-full', 'contract-all-true']
    await contract.init(criteria)

    // Gate: no evidence → denied.
    for (const c of criteria) {
      const denied = await contract.flip(c)
      expect(denied.ok).toBe(false)
    }

    // Produce evidence for each criterion, then flip.
    for (const c of criteria) {
      contract.recordEvidenceRead(c)
      const allowed = await contract.flip(c)
      expect(allowed.ok).toBe(true)
    }

    expect(await contract.allPassed()).toBe(true)
  })

  it('evidence is criterion-scoped: evidence for A does not ungate B', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['a', 'b'])

    // Record evidence only for 'a'.
    contract.recordEvidenceRead('a')

    const flipA = await contract.flip('a')
    expect(flipA.ok).toBe(true)

    // 'b' has no evidence — must still be denied.
    const flipB = await contract.flip('b')
    expect(flipB.ok).toBe(false)

    const data = await contract.read()
    expect(data['a']).toBe(true)
    expect(data['b']).toBe(false)
  })

  it('canFlip() reflects evidence state accurately', async () => {
    const contract = new H1Contract(tmpDir, 'M-INT')
    await contract.init(['x'])

    expect(contract.canFlip('x')).toBe(false)
    contract.recordEvidenceRead('x')
    expect(contract.canFlip('x')).toBe(true)
  })
})
