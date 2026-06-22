// M1 H1 contract test — written FIRST (D1)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { H1Contract } from '../../src/safety/contract.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-contract-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M1: H1 default-FAIL evidence gate', () => {
  it('initialises all criteria to false', async () => {
    const c = new H1Contract(tmpDir, 'M0')
    await c.init(['compiles', 'loads', 'armed'])
    const data = await c.read()
    expect(data.compiles).toBe(false)
    expect(data.loads).toBe(false)
    expect(data.armed).toBe(false)
  })

  it('denies flip without prior evidence read', async () => {
    const c = new H1Contract(tmpDir, 'M0')
    await c.init(['compiles'])
    const result = await c.flip('compiles')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no evidence/i)
  })

  it('allows flip after recordEvidenceRead', async () => {
    const c = new H1Contract(tmpDir, 'M0')
    await c.init(['compiles'])
    c.recordEvidenceRead('compiles')
    const result = await c.flip('compiles')
    expect(result.ok).toBe(true)
    const data = await c.read()
    expect(data.compiles).toBe(true)
  })

  it('allPassed() returns false while any criterion is false', async () => {
    const c = new H1Contract(tmpDir, 'M0')
    await c.init(['a', 'b'])
    c.recordEvidenceRead('a')
    await c.flip('a')
    expect(await c.allPassed()).toBe(false)
  })

  it('allPassed() returns true when all criteria flipped with evidence', async () => {
    const c = new H1Contract(tmpDir, 'M0')
    await c.init(['a', 'b'])
    c.recordEvidenceRead('a')
    c.recordEvidenceRead('b')
    await c.flip('a')
    await c.flip('b')
    expect(await c.allPassed()).toBe(true)
  })
})
