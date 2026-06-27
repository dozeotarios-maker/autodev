import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ensureGitRepo } from '../../src/git/ensure-repo.js'

const exec = promisify(execFile)

describe('ensureGitRepo', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-repo-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('initializes a fresh directory as a git repo on branch main', async () => {
    const created = await ensureGitRepo(dir)
    expect(created).toBe(true)
    await expect(fs.access(path.join(dir, '.git'))).resolves.toBeUndefined()
    const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })
    expect(stdout.trim()).toBe('main')
  })

  it('leaves the repo committable — first commit succeeds (identity configured)', async () => {
    await ensureGitRepo(dir)
    await fs.writeFile(path.join(dir, 'f.txt'), 'hi')
    await exec('git', ['add', 'f.txt'], { cwd: dir })
    // Would throw "Author identity unknown" on a clean machine without ensureGitRepo's config.
    await expect(exec('git', ['commit', '-m', 'first'], { cwd: dir })).resolves.toBeDefined()
  })

  it('no-ops on a directory that is already a repo', async () => {
    await ensureGitRepo(dir)
    expect(await ensureGitRepo(dir)).toBe(false)
  })
})
