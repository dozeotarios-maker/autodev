// M5 per-phase-push test — D1 test-first
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

import { PerPhasePush } from '../../src/git/per-phase-push.js'
import { execFile } from 'child_process'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-push-test-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M5: PerPhasePush — branch-gated push', () => {
  it('pushes when HEAD is on the target branch', async () => {
    // git rev-parse returns target branch name, then git push succeeds
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(null, 'main\n', '')
      ) // git symbolic-ref --short HEAD
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(null, '', '')
      ) // git push

    const ppp = new PerPhasePush(tmpDir)
    await expect(ppp.push('main')).resolves.toBeUndefined()

    const pushCall = mockExecFile.mock.calls[1]
    expect(pushCall[0]).toBe('git')
    expect(pushCall[1]).toContain('push')
  })

  it('rejects push when HEAD is NOT on target branch', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
      cb(null, 'feature/other\n', '')
    )

    const ppp = new PerPhasePush(tmpDir)
    await expect(ppp.push('main')).rejects.toThrow(/not on branch main/)
  })

  it('rejects push when git symbolic-ref fails (detached HEAD)', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
      cb(new Error('fatal: HEAD is detached'), '', '')
    )

    const ppp = new PerPhasePush(tmpDir)
    await expect(ppp.push('main')).rejects.toThrow()
  })

  it('passes cwd to all git calls', async () => {
    let seenCwd: string | undefined
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], opts: { cwd?: string }, cb: Function) => {
        seenCwd = opts.cwd
        cb(null, 'main\n', '')
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))

    const ppp = new PerPhasePush(tmpDir)
    await ppp.push('main')
    expect(seenCwd).toBe(tmpDir)
  })
})
