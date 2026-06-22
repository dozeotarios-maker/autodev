import { execFile } from 'child_process'
import type { GitOps } from '../ports.js'

/**
 * PerPhasePush — implements GitOps.perPhasePush.
 * Only pushes when the current HEAD is on the specified target branch.
 * Throws if HEAD is on a different branch or in detached-HEAD state.
 */

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, _stderr) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export class PerPhasePush implements Pick<GitOps, 'perPhasePush'> {
  constructor(private readonly cwd: string) {}

  async push(branch: string): Promise<void> {
    const stdout = await git(['symbolic-ref', '--short', 'HEAD'], this.cwd)
    const current = stdout.trim()
    if (current !== branch) {
      throw new Error(
        `PerPhasePush: not on branch ${branch} (currently on "${current}") — push blocked`
      )
    }
    await git(['push'], this.cwd)
  }

  async perPhasePush(branch: string): Promise<void> {
    return this.push(branch)
  }
}
