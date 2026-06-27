import { execFile } from 'child_process'

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * Ensure `dir` is a git repository so the release phase (P6) can commit into it.
 *
 * Fresh scratch projects (~/autodev/<slug>) start life as a bare directory; without
 * this, P6's scoped commit fails with "not a git repository". Existing repos are left
 * untouched. A local commit identity is set when none is configured, otherwise the
 * first commit fails with "Author identity unknown" on a clean machine.
 *
 * Returns true if a new repo was initialized, false if `dir` was already one.
 */
export async function ensureGitRepo(dir: string): Promise<boolean> {
  const alreadyRepo = await git(['rev-parse', '--is-inside-work-tree'], dir)
    .then((out) => out.trim() === 'true')
    .catch(() => false)
  if (alreadyRepo) return false

  // `init -b main` needs git ≥ 2.28; fall back to the portable two-step for older git.
  try {
    await git(['init', '-b', 'main'], dir)
  } catch {
    await git(['init'], dir)
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir).catch(() => {})
  }

  const hasIdentity = await git(['config', 'user.email'], dir)
    .then((out) => out.trim().length > 0)
    .catch(() => false)
  if (!hasIdentity) {
    await git(['config', 'user.email', 'autodev@local'], dir)
    await git(['config', 'user.name', 'pi-autodev'], dir)
  }
  return true
}
