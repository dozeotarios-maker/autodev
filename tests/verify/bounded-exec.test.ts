// C-0 Task 0.1: BoundedExec port — untrusted-repro runner tests
import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'
import { BoundedExecImpl } from '../../src/verify/bounded-exec.js'
import { ActionMonitor } from '../../src/safety/action-monitor.js'

describe('BoundedExec', () => {
  it('passes when command exits 0', async () => {
    const monitor = new ActionMonitor([], [])
    const exec = new BoundedExecImpl(monitor)
    const result = await exec.run('node -e "process.exit(0)"', process.cwd(), { timeoutMs: 5000 })
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.blocked).toBe(false)
  })

  it('fails when command exits non-zero (exit 3)', async () => {
    const monitor = new ActionMonitor([], [])
    const exec = new BoundedExecImpl(monitor)
    const result = await exec.run('node -e "process.exit(3)"', process.cwd(), { timeoutMs: 5000 })
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.blocked).toBe(false)
  })

  it('kills a hanging process and returns timedOut:true, call resolves within timeoutMs+1500ms', async () => {
    const monitor = new ActionMonitor([], [])
    const exec = new BoundedExecImpl(monitor)
    const timeoutMs = 800
    const start = Date.now()
    const result = await exec.run('node -e "setInterval(()=>{}, 100000)"', process.cwd(), { timeoutMs })
    const elapsed = Date.now() - start
    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
    expect(elapsed).toBeLessThan(timeoutMs + 1500)
  })

  it('blocks a command that checkBashCommand rejects and does NOT execute it', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-exec-test-'))
    try {
      // ActionMonitor with a protected path — writing to it is blocked
      const monitor = new ActionMonitor([tmpDir], ['/root/.ssh'])
      const exec = new BoundedExecImpl(monitor)
      const evilFile = '/root/.ssh/evil-bounded-exec-test'
      const result = await exec.run(`echo x > ${evilFile}`, tmpDir, { timeoutMs: 5000 })
      expect(result.blocked).toBe(true)
      expect(result.passed).toBe(false)
      // The file must NOT have been written
      await expect(fs.access(evilFile)).rejects.toThrow()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('setRepoRoot: allows writes inside new dir and blocks writes outside it', async () => {
    const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-exec-root1-'))
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-exec-root2-'))
    try {
      // Start confined to dir1; a write to dir2 is blocked
      const monitor = new ActionMonitor([dir1], [dir2])
      const exec = new BoundedExecImpl(monitor)
      const blockedBefore = await exec.run(`echo x > ${path.join(dir2, 'evil.txt')}`, dir1, { timeoutMs: 3000 })
      expect(blockedBefore.blocked).toBe(true)

      // Re-root to dir2; now writes inside dir2 are allowed, dir1 outside confinement
      exec.setRepoRoot(dir2)
      const allowedAfter = await exec.run(`echo ok > ${path.join(dir2, 'ok.txt')}`, dir2, { timeoutMs: 3000 })
      expect(allowedAfter.blocked).toBe(false)
      expect(allowedAfter.passed).toBe(true)
    } finally {
      await fs.rm(dir1, { recursive: true, force: true })
      await fs.rm(dir2, { recursive: true, force: true })
    }
  })

  it('handles spawn error (ENOENT binary) without throwing', async () => {
    const monitor = new ActionMonitor([], [])
    const exec = new BoundedExecImpl(monitor)
    // Use shell:true so the binary name is what's invoked; use a definitely-nonexistent command
    // Actually with shell:true the shell itself spawns fine, the error comes as exitCode 127
    // Test with a non-executable absolute path (no shell — but we use shell:true in impl)
    // Use a command that shell will fail on with exit 127
    const result = await exec.run('this_binary_does_not_exist_xyz_123', process.cwd(), { timeoutMs: 3000 })
    // With shell:true, shell exits 127 rather than throwing ENOENT
    expect(result.passed).toBe(false)
    expect(result.blocked).toBe(false)
    expect(result.timedOut).toBe(false)
  })
})
