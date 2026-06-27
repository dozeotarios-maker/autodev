import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Resolve the test command the verifier should run for a project.
 *
 * The pipeline picks its own stack in P1 (zero-dep `node:test`, vitest, jest, …) and
 * writes the matching `test` script into package.json. Hardcoding `npx vitest run`
 * broke that contract: a node:test project verified under vitest collects zero suites
 * ("No test suite found"), forcing the build to abandon its chosen stack. Honor the
 * project's declared script via `npm test` instead.
 *
 * Falls back to `npx vitest run` when there is no package.json or no `test` script —
 * autodev's own default stack and the historical behavior, so callers and tests that
 * run against a bare directory are unaffected.
 */
export async function resolveTestCommand(repoRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf-8'))
    const testScript = pkg?.scripts?.test
    if (typeof testScript === 'string' && testScript.trim().length > 0) {
      return 'npm test'
    }
  } catch {
    // no package.json / unreadable / malformed — fall through to the default runner
  }
  return 'npx vitest run'
}
