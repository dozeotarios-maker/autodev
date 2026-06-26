// Re-root coverage: the composed Verifier.runSecurityScan must HONOR its wd arg
// (P5 passes this.repoRoot). Before the fix it scanned the original cwd unconditionally.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('buildExtension Verifier.runSecurityScan honors wd', () => {
  let spawnCalls: Array<{ cwd: string | undefined }>

  beforeEach(() => {
    spawnCalls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('passes the wd argument to gitleaks spawn (not the build-time cwd)', async () => {
    // Mock child_process.spawn used by GitleaksHook to capture cwd and emit a clean exit.
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((_bin: string, _args: string[], opts: { cwd?: string }) => {
          spawnCalls.push({ cwd: opts?.cwd })
          // Minimal fake child: stdout.on noop, close(0) on next tick.
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

    const scanDir = '/resolved/project/dir'
    const result = await built.verifier.runSecurityScan(scanDir)

    expect(result.clean).toBe(true)
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]?.cwd).toBe(scanDir)
  })
})
