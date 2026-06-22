// M1 lifecycle test — written FIRST (D1)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { Lifecycle } from '../../src/engine/lifecycle.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-autodev-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M1: Lifecycle armed/running', () => {
  it('starts in ARMED state', () => {
    const lc = new Lifecycle({ cwd: tmpDir })
    expect(lc.getState()).toBe('ARMED')
  })

  it('transitions to RUNNING on explicit idea input', async () => {
    const lc = new Lifecycle({ cwd: tmpDir })
    const result = await lc.run('add login feature')
    expect(result.ok).toBe(true)
    expect(lc.getState()).toBe('RUNNING')
  })

  it('per-repo run-lock blocks a second RUNNING session', async () => {
    const lc1 = new Lifecycle({ cwd: tmpDir })
    const lc2 = new Lifecycle({ cwd: tmpDir })

    await lc1.run('first idea')
    const second = await lc2.run('second idea')

    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/another session|already running/i)
  })

  it('release() returns to ARMED and removes lock', async () => {
    const lc = new Lifecycle({ cwd: tmpDir })
    await lc.run('some idea')
    expect(lc.getState()).toBe('RUNNING')
    await lc.release()
    expect(lc.getState()).toBe('ARMED')

    // Lock file should be gone — new instance can acquire
    const lc2 = new Lifecycle({ cwd: tmpDir })
    const result = await lc2.run('new idea')
    expect(result.ok).toBe(true)
  })

  it('calls onArmed callback on arm()', async () => {
    let called = false
    const lc = new Lifecycle({ cwd: tmpDir, onArmed: async () => { called = true } })
    await lc.arm()
    expect(called).toBe(true)
  })

  it('calls onRunning callback on run()', async () => {
    let called = false
    const lc = new Lifecycle({ cwd: tmpDir, onRunning: async () => { called = true } })
    await lc.run('idea')
    expect(called).toBe(true)
  })
})
