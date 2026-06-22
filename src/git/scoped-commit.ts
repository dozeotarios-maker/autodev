import { execFile } from 'child_process'
import * as path from 'path'
import type { GitOps } from '../ports.js'

/**
 * ScopedCommit — implements GitOps.scopedCommit.
 * Stages ONLY the explicitly allowlisted paths (never `git add .` or `--all`),
 * then commits and returns the resulting SHA.
 */

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, _stderr) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * Validates that every path in allowedPaths resolves strictly inside cwd.
 * Throws if any path escapes via traversal (../../x, /etc/passwd, etc.).
 */
function validatePaths(allowedPaths: string[], cwd: string): void {
  const cwdResolved = path.resolve(cwd)
  for (const p of allowedPaths) {
    const resolved = path.resolve(cwd, p)
    if (!resolved.startsWith(cwdResolved + path.sep) && resolved !== cwdResolved) {
      throw new Error(
        `ScopedCommit: path escapes working directory — rejected: ${p}`
      )
    }
  }
}

export class ScopedCommit implements Pick<GitOps, 'scopedCommit'> {
  constructor(private readonly cwd: string) {}

  async commit(message: string, allowedPaths: string[]): Promise<{ sha: string }> {
    if (!allowedPaths || allowedPaths.length === 0) {
      throw new Error('allowedPaths must be non-empty — scoped commit requires explicit path list')
    }

    // Reject any path that resolves outside cwd (traversal / absolute escape)
    validatePaths(allowedPaths, this.cwd)

    // Stage ONLY the listed paths — never add '.' or '--all'
    await git(['add', '--', ...allowedPaths], this.cwd)

    // Commit
    await git(['commit', '-m', message], this.cwd)

    // Return the new HEAD SHA
    const stdout = await git(['rev-parse', 'HEAD'], this.cwd)
    return { sha: stdout.trim() }
  }

  // Satisfies GitOps port shape
  async scopedCommit(message: string, allowedPaths: string[]): Promise<{ sha: string }> {
    return this.commit(message, allowedPaths)
  }
}
