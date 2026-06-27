// Stale-lock reclaim — the live-debug fix. A pi session that closed/crashed mid-run
// left a running.lock that blocked EVERY future run with "already RUNNING" (autodev
// appeared to never orchestrate). acquireLockAtomic now reclaims a lock whose owner
// process is dead or whose age exceeds any plausible run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Lifecycle } from '../../src/engine/lifecycle.js'

describe('Lifecycle stale-lock reclaim', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const writeLock = async (obj: unknown): Promise<void> => {
    await fs.mkdir(path.join(dir, '.autodev'), { recursive: true })
    await fs.writeFile(path.join(dir, '.autodev', 'running.lock'), JSON.stringify(obj))
  }

  it('acquires the lock in a fresh dir', async () => {
    expect((await new Lifecycle({ cwd: dir }).run('idea')).ok).toBe(true)
  })

  it('reclaims a lock whose owner process is dead', async () => {
    await writeLock({ pid: 999999, idea: 'old', startedAt: new Date().toISOString() })
    expect((await new Lifecycle({ cwd: dir }).run('new idea')).ok).toBe(true)
  })

  it('respects a lock whose owner process is alive', async () => {
    // pid 1 (init) always exists; kill(1,0) → succeeds or EPERM, both mean "alive".
    await writeLock({ pid: 1, idea: 'live', startedAt: new Date().toISOString() })
    expect((await new Lifecycle({ cwd: dir }).run('new idea')).ok).toBe(false)
  })

  it('reclaims a lock older than the max age even if the pid is alive', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    await writeLock({ pid: 1, idea: 'stuck', startedAt: fourHoursAgo })
    expect((await new Lifecycle({ cwd: dir }).run('new idea')).ok).toBe(true)
  })

  it('reclaims a corrupt/unreadable lock', async () => {
    await fs.mkdir(path.join(dir, '.autodev'), { recursive: true })
    await fs.writeFile(path.join(dir, '.autodev', 'running.lock'), 'not json {{{')
    expect((await new Lifecycle({ cwd: dir }).run('new idea')).ok).toBe(true)
  })

  it('release() frees the lock for a subsequent run', async () => {
    const lc = new Lifecycle({ cwd: dir })
    expect((await lc.run('a')).ok).toBe(true)
    await lc.release()
    expect((await lc.run('b')).ok).toBe(true)
  })
})
