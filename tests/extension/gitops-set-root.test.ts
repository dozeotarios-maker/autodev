// Re-root coverage: the composed GitOps object must expose setRepoRoot so P6
// commits/pushes the RESOLVED dir, not the build-time cwd captured in
// ScopedCommit/PerPhasePush/GitleaksHook at construction.

import { describe, it, expect, vi, afterEach } from 'vitest'

describe('buildExtension GitOps.setRepoRoot re-roots git adapters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('exposes setRepoRoot and routes scanSecrets spawn to the new dir', async () => {
    const spawnCalls: Array<{ cwd: string | undefined }> = []
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((_bin: string, _args: string[], opts: { cwd?: string }) => {
          spawnCalls.push({ cwd: opts?.cwd })
          const handlers: Record<string, (arg?: unknown) => void> = {}
          const child = {
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (ev: string, cb: (arg?: unknown) => void) => { handlers[ev] = cb; return child },
            kill: () => {},
          }
          setImmediate(() => handlers['close']?.(0))
          return child as unknown as ReturnType<typeof actual.spawn>
        }),
      }
    })

    const { buildExtension } = await import('../../src/extension/index.js')
    const built = buildExtension({ repoRoot: '/build/time/cwd' })

    // setRepoRoot must exist on the composed GitOps object
    const gitOps = built.gitOps as typeof built.gitOps & { setRepoRoot?: (dir: string) => void }
    expect(typeof gitOps.setRepoRoot).toBe('function')

    gitOps.setRepoRoot!('/resolved/project/dir')
    const r = await built.gitOps.scanSecrets(false)
    expect(r.clean).toBe(true)
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]?.cwd).toBe('/resolved/project/dir')
  })

  it('routes scopedCommit git spawn to the new dir after setRepoRoot', async () => {
    const execFileCalls: Array<{ cwd: string | undefined; args: string[] }> = []
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        // ScopedCommit/PerPhasePush use execFile(git, args, {cwd}, cb)
        execFile: vi.fn((_bin: string, args: string[], opts: { cwd?: string }, cb: (e: unknown, out: string, err: string) => void) => {
          execFileCalls.push({ cwd: opts?.cwd, args })
          // rev-parse returns a fake sha; everything else returns empty
          const out = args[0] === 'rev-parse' ? 'deadbeef\n' : ''
          setImmediate(() => cb(null, out, ''))
          return {} as unknown
        }),
      }
    })

    const { buildExtension } = await import('../../src/extension/index.js')
    const built = buildExtension({ repoRoot: '/build/time/cwd' })
    const gitOps = built.gitOps as typeof built.gitOps & { setRepoRoot?: (dir: string) => void }
    gitOps.setRepoRoot!('/resolved/project/dir')

    const res = await built.gitOps.scopedCommit('msg', ['.autodev/phase-output/'])
    expect(res.sha).toBe('deadbeef')
    // Every git invocation must run in the resolved dir
    expect(execFileCalls.length).toBeGreaterThan(0)
    for (const c of execFileCalls) {
      expect(c.cwd).toBe('/resolved/project/dir')
    }
  })
})
