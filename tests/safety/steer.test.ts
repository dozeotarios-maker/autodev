// M1 steer/H4 test — written FIRST (D1)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { SteerController } from '../../src/safety/steer.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-steer-test-'))
  await fs.mkdir(path.join(tmpDir, '.autodev'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M1: H4 SteerController', () => {
  it('checkStop() returns false when AGENT_STOP absent', async () => {
    const sc = new SteerController(tmpDir)
    expect(await sc.checkStop()).toBe(false)
  })

  it('checkStop() returns true when AGENT_STOP present', async () => {
    const sc = new SteerController(tmpDir)
    await fs.writeFile(path.join(tmpDir, '.autodev', 'AGENT_STOP'), 'halt')
    expect(await sc.checkStop()).toBe(true)
  })

  it('consumeSteer() returns content and deletes file', async () => {
    const sc = new SteerController(tmpDir)
    await fs.writeFile(path.join(tmpDir, '.autodev', 'STEER.md'), 'Focus on login only')
    const content = await sc.consumeSteer()
    expect(content).toBe('Focus on login only')
    // File should be gone now
    await expect(
      fs.access(path.join(tmpDir, '.autodev', 'STEER.md'))
    ).rejects.toThrow()
  })

  it('consumeSteer() returns undefined when STEER.md absent', async () => {
    const sc = new SteerController(tmpDir)
    const content = await sc.consumeSteer()
    expect(content).toBeUndefined()
  })

  it('check() returns halted=true when AGENT_STOP present', async () => {
    const sc = new SteerController(tmpDir)
    await fs.writeFile(path.join(tmpDir, '.autodev', 'AGENT_STOP'), '')
    const result = await sc.check()
    expect(result.halted).toBe(true)
  })

  it('check() returns steerContent when STEER.md present and not halted', async () => {
    const sc = new SteerController(tmpDir)
    await fs.writeFile(path.join(tmpDir, '.autodev', 'STEER.md'), 'Pivot to auth module')
    const result = await sc.check()
    expect(result.halted).toBe(false)
    expect(result.steerContent).toBe('Pivot to auth module')
  })
})
