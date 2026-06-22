// M5 scoped-commit test — D1 test-first
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

// Mock child_process — G12: mock CLI boundary
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

import { ScopedCommit } from '../../src/git/scoped-commit.js'
import { execFile } from 'child_process'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-git-test-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M5: ScopedCommit — stages only allowlisted paths', () => {
  it('stages only allowed paths and commits', async () => {
    // git add <allowed paths>, then git commit → return sha
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))   // git add
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))   // git commit
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(null, 'abc123def456\n', '')  // git rev-parse HEAD
      )

    const sc = new ScopedCommit(tmpDir)
    const result = await sc.commit('feat: add feature', ['src/foo.ts', 'src/bar.ts'])

    expect(result.sha).toMatch(/^[a-f0-9]+$/)

    // First call must be git add with ONLY the allowed paths
    const addCall = mockExecFile.mock.calls[0]
    expect(addCall[0]).toBe('git')
    expect(addCall[1]).toContain('add')
    expect(addCall[1]).toContain('src/foo.ts')
    expect(addCall[1]).toContain('src/bar.ts')
    // Must NOT add '--all' or '.' etc
    expect(addCall[1]).not.toContain('--all')
    expect(addCall[1]).not.toContain('.')
  })

  it('rejects empty allowedPaths', async () => {
    const sc = new ScopedCommit(tmpDir)
    await expect(sc.commit('msg', [])).rejects.toThrow(/allowedPaths must be non-empty/)
  })

  it('passes cwd to git commands', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], opts: { cwd?: string }, cb: Function) => {
        expect(opts.cwd).toBe(tmpDir)
        cb(null, '', '')
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(null, 'deadbeef\n', '')
      )

    const sc = new ScopedCommit(tmpDir)
    await sc.commit('msg', ['src/x.ts'])
  })

  it('rejects path traversal (../../etc/passwd)', async () => {
    const sc = new ScopedCommit(tmpDir)
    await expect(sc.commit('msg', ['../../etc/passwd'])).rejects.toThrow(/escapes working directory/)
  })

  it('rejects absolute path outside cwd (/etc/passwd)', async () => {
    const sc = new ScopedCommit(tmpDir)
    await expect(sc.commit('msg', ['/etc/passwd'])).rejects.toThrow(/escapes working directory/)
  })

  it('accepts a valid relative path inside cwd', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''))
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
        cb(null, 'cafebabe\n', '')
      )

    const sc = new ScopedCommit(tmpDir)
    const result = await sc.commit('msg', ['src/valid.ts'])
    expect(result.sha).toBe('cafebabe')
  })
})
