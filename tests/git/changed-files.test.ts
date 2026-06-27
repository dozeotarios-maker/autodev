// C-0 Task 0.2: GitOps.changedFiles — returns union of unstaged + staged changes
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { ChangedFiles } from '../../src/git/changed-files.js'

const execFile = promisify(execFileCb)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd })
  return stdout
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'changed-files-test-'))
  // Init a bare git repo
  await git(['init'], tmpDir)
  await git(['config', 'user.email', 'test@test.com'], tmpDir)
  await git(['config', 'user.name', 'Test'], tmpDir)
  // Initial commit so HEAD exists
  await fs.writeFile(path.join(tmpDir, 'init.txt'), 'init')
  await git(['add', 'init.txt'], tmpDir)
  await git(['commit', '-m', 'initial'], tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ChangedFiles', () => {
  it('returns [] on a clean tree', async () => {
    const cf = new ChangedFiles()
    const result = await cf.changedFiles(tmpDir)
    expect(result).toEqual([])
  })

  it('includes an unstaged modified file', async () => {
    await fs.writeFile(path.join(tmpDir, 'init.txt'), 'modified')
    const cf = new ChangedFiles()
    const result = await cf.changedFiles(tmpDir)
    expect(result).toContain('init.txt')
  })

  it('includes a staged file', async () => {
    await fs.writeFile(path.join(tmpDir, 'staged.txt'), 'staged')
    await git(['add', 'staged.txt'], tmpDir)
    const cf = new ChangedFiles()
    const result = await cf.changedFiles(tmpDir)
    expect(result).toContain('staged.txt')
  })

  it('returns [] for a non-git directory without throwing', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'))
    try {
      const cf = new ChangedFiles()
      const result = await cf.changedFiles(nonGitDir)
      expect(result).toEqual([])
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true })
    }
  })

  it('deduplicates a file that is both staged and unstaged', async () => {
    // Stage a file then modify it again (so it appears in both outputs)
    await fs.writeFile(path.join(tmpDir, 'init.txt'), 'staged-version')
    await git(['add', 'init.txt'], tmpDir)
    await fs.writeFile(path.join(tmpDir, 'init.txt'), 'also-unstaged')
    const cf = new ChangedFiles()
    const result = await cf.changedFiles(tmpDir)
    const count = result.filter(f => f === 'init.txt').length
    expect(count).toBe(1)
  })
})
