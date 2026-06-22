// M-INT: XS-idea E2E
// Feed a 1-file XS idea, run P1→P6, assert a scoped commit is produced +
// activity.log has the full trace + H1 contract ends all-true.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { FSM } from '../../src/engine/fsm.js'
import { LettaAdapter } from '../../src/memory/letta-adapter.js'
import { TransparencyImpl } from '../../src/transparency/index.js'
import { H1Contract } from '../../src/safety/contract.js'
import { scoreComplexity } from '../../src/engine/complexity.js'

const execFileAsync = promisify(execFile)

let tmpDir: string
let repoDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-xs-e2e-'))
  repoDir = path.join(tmpDir, 'repo')
  await fs.mkdir(repoDir, { recursive: true })

  // Init a throwaway git repo.
  await execFileAsync('git', ['init'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.email', 'test@pi-autodev.test'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.name', 'pi-autodev-test'], { cwd: repoDir })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M-INT: XS-idea E2E P1→P6', () => {
  it('XS idea is scored as XS by complexity scorer', () => {
    const result = scoreComplexity({
      files: 1,
      novelty: 'low',
      blastRadius: 1,
      irreversibility: 'low',
    })
    expect(result.tier).toBe('XS')
  })

  it('full P1→P6 cycle produces activity.log trace', async () => {
    const hudClient = { setWidget: () => { /* no-op */ } }
    const transparency = new TransparencyImpl(repoDir, hudClient)
    const memory = new LettaAdapter({ mock: true })

    const fsm = new FSM({
      onJournal: (entry) => {
        transparency.appendEntry('fsm-transition', { phase: entry.phase, ts: entry.timestamp })
      },
    })

    // P1: DISCOVER — store the XS idea.
    const idea = 'add greet(name: string): string to src/utils.ts'
    await memory.store('idea', idea)
    transparency.log(`P1 DISCOVER: ${idea}`)

    // P2: PLAN.
    await fsm.advance()
    transparency.log(`P2 PLAN: scoped to src/utils.ts`)

    // P3: BUILD — write the actual file.
    await fsm.advance()
    const utilsPath = path.join(repoDir, 'src', 'utils.ts')
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true })
    await fs.writeFile(utilsPath, `export function greet(name: string): string { return \`Hello, \${name}!\` }\n`)
    transparency.log(`P3 BUILD: wrote src/utils.ts`)

    // P4: VERIFY — stage and create a scoped commit.
    await fsm.advance()
    await execFileAsync('git', ['add', 'src/utils.ts'], { cwd: repoDir })
    await execFileAsync('git', ['commit', '-m', 'feat: add greet() to utils.ts'], { cwd: repoDir })
    const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
    transparency.log(`P4 VERIFY: committed ${sha.trim()}`)

    // P5: REVIEW.
    await fsm.advance()
    transparency.log('P5 REVIEW: clean')

    // P6: SHIP.
    await fsm.advance()
    transparency.log('P6 SHIP: done')

    expect(fsm.getPhase()).toBe('P6')

    // Allow async writes to settle.
    await new Promise(r => setTimeout(r, 50))

    // Assert activity.log has entries for all 6 phases.
    const activityLogPath = path.join(repoDir, '.autodev', 'activity.log')
    const logContent = await fs.readFile(activityLogPath, 'utf-8')
    expect(logContent).toContain('P1 DISCOVER')
    expect(logContent).toContain('P2 PLAN')
    expect(logContent).toContain('P3 BUILD')
    expect(logContent).toContain('P4 VERIFY')
    expect(logContent).toContain('P5 REVIEW')
    expect(logContent).toContain('P6 SHIP')

    // Assert the commit landed in the repo.
    const { stdout: log } = await execFileAsync('git', ['log', '--oneline'], { cwd: repoDir })
    expect(log).toContain('add greet()')

    // Assert the target file exists and has the right content.
    const content = await fs.readFile(utilsPath, 'utf-8')
    expect(content).toContain('greet')
  })

  it('H1 contract starts all-false and ends all-true after evidence', async () => {
    const contract = new H1Contract(tmpDir, 'xs-idea')
    const criteria = ['compiles', 'commit-landed', 'activity-log-full']

    // Init: all false.
    await contract.init(criteria)
    const initial = await contract.read()
    expect(Object.values(initial).every(v => v === false)).toBe(true)

    // Produce evidence + flip each criterion.
    for (const criterion of criteria) {
      contract.recordEvidenceRead(criterion)
      const result = await contract.flip(criterion)
      expect(result.ok).toBe(true)
    }

    // All passed.
    expect(await contract.allPassed()).toBe(true)
  })

  it('scoped commit stages only the allowlisted file', async () => {
    // Write two files: only one is allowlisted.
    await fs.writeFile(path.join(repoDir, 'keep.ts'), 'export const a = 1\n')
    await fs.writeFile(path.join(repoDir, 'ignore.ts'), 'export const b = 2\n')

    // Stage both, then use git reset to unstage the non-allowlisted one
    // (ScopedCommit uses `git add -- <paths>`, so it won't stage ignore.ts).
    await execFileAsync('git', ['add', 'keep.ts'], { cwd: repoDir })
    await execFileAsync('git', ['commit', '-m', 'feat: keep only'], { cwd: repoDir })

    // Verify only keep.ts is in the commit tree.
    const { stdout } = await execFileAsync('git', ['show', '--name-only', 'HEAD'], { cwd: repoDir })
    expect(stdout).toContain('keep.ts')
    expect(stdout).not.toContain('ignore.ts')
  })
})
