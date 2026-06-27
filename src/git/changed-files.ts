// C-0 Task 0.2: ChangedFiles — implements GitOps.changedFiles
// Returns the union of unstaged (git diff --name-only) and staged (git diff --name-only --staged)
// changed files, repo-relative, deduplicated.

import { execFile } from 'child_process'
import type { GitOps } from '../ports.js'

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, _stderr) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function parseNames(output: string): string[] {
  return output.split('\n').map(l => l.trim()).filter(l => l.length > 0)
}

export class ChangedFiles implements Pick<GitOps, 'changedFiles'> {
  async changedFiles(cwd: string): Promise<string[]> {
    const [unstaged, staged] = await Promise.all([
      git(['diff', '--name-only'], cwd),
      git(['diff', '--name-only', '--staged'], cwd),
    ])
    const all = [...parseNames(unstaged), ...parseNames(staged)]
    // Deduplicate preserving order
    return [...new Set(all)]
  }
}
