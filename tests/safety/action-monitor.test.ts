// M1 action-monitor test — written FIRST (D1)
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ActionMonitor } from '../../src/safety/action-monitor.js'

describe('M1: G2 action-monitor', () => {
  it('blocks rm -rf command', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('rm -rf /tmp/foo').allowed).toBe(false)
  })

  it('blocks rm -fr variant', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('rm -fr .').allowed).toBe(false)
  })

  it('blocks rm --no-preserve-root', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('rm --no-preserve-root /').allowed).toBe(false)
  })

  it('allows safe rm command', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('rm dist/old-file.js').allowed).toBe(true)
  })

  it('blocks out-of-bounds file write when allowedPaths set', () => {
    const m = new ActionMonitor(['/repo/src', '/repo/.autodev'])
    expect(m.checkFileWrite('/etc/passwd').allowed).toBe(false)
    expect(m.checkFileWrite('/repo/src/foo.ts').allowed).toBe(true)
  })

  it('allows all writes when no allowedPaths configured', () => {
    const m = new ActionMonitor()
    expect(m.checkFileWrite('/anywhere/file.txt').allowed).toBe(true)
  })

  it('blocks egress to non-allowlisted host', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('https://evil.com/exfil').allowed).toBe(false)
  })

  it('allows egress to allowlisted host', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('https://api.github.com/repos').allowed).toBe(true)
    expect(m.checkEgress('https://registry.npmjs.org/vitest').allowed).toBe(true)
  })

  it('allows egress to Gemini API (legitimate LLM host)', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('https://generativelanguage.googleapis.com/v1/models').allowed).toBe(true)
  })

  it('allows egress to localhost services (Letta, Ollama, codebase-memory)', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('http://localhost:8283/v1/agents').allowed).toBe(true)
    expect(m.checkEgress('http://localhost:11434/api/generate').allowed).toBe(true)
    expect(m.checkEgress('http://localhost:7777/search').allowed).toBe(true)
    expect(m.checkEgress('http://127.0.0.1:8283/health').allowed).toBe(true)
  })

  it('blocks egress to disallowed exfil host', () => {
    const m = new ActionMonitor()
    const result = m.checkEgress('https://exfil.attacker.com/steal?data=secrets')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/not in allowlist/)
  })

  // Split-allowlist: exact-only entries must NOT allow subdomains
  it('blocks evil.localhost (suffix of allowlisted localhost must not pass)', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('http://evil.localhost/steal').allowed).toBe(false)
  })

  it('allows localhost exactly', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('http://localhost:8283/v1/agents').allowed).toBe(true)
  })

  it('allows api.github.com (subdomain suffix of github.com)', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('https://api.github.com/repos').allowed).toBe(true)
  })

  it('blocks evil.github.com.attacker.com (does not match github.com suffix)', () => {
    const m = new ActionMonitor()
    expect(m.checkEgress('https://evil.github.com.attacker.com/').allowed).toBe(false)
  })

  // Pipeline isolation guard — protectedPaths denylist
  it('blocks write to /root/.openclaw/skills/pipeline/reel.py even with empty allowedPaths', () => {
    const m = new ActionMonitor()
    const result = m.checkFileWrite('/root/.openclaw/skills/pipeline/reel.py')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/protected path/)
  })

  it('allows write to /root/pi-autodev/src/x.ts with empty allowedPaths', () => {
    const m = new ActionMonitor()
    expect(m.checkFileWrite('/root/pi-autodev/src/x.ts').allowed).toBe(true)
  })

  it('blocks traversal path /root/pi-autodev/../.openclaw/x', () => {
    const m = new ActionMonitor()
    const result = m.checkFileWrite('/root/pi-autodev/../.openclaw/x')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/protected path/)
  })

  it('blocks bash command containing /root/.openclaw path', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('echo hi > /root/.openclaw/x').allowed).toBe(false)
    expect(m.checkBashCommand('git -C /root/.openclaw status').allowed).toBe(false)
  })

  it('allows bash ls /root/pi-autodev', () => {
    const m = new ActionMonitor()
    expect(m.checkBashCommand('ls /root/pi-autodev').allowed).toBe(true)
  })

  it('does not block /root/.openclaw-sibling/x (prefix-but-not-contained)', () => {
    const m = new ActionMonitor()
    expect(m.checkFileWrite('/root/.openclaw-sibling/x').allowed).toBe(true)
  })
})

// ── Fix 1: bash absolute-path write escape ────────────────────────────────────

describe('Fix 1: bash absolute-path write escape blocked when allowedPaths set', () => {
  it('blocks echo x > /root/f (redirect to absolute path outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    const result = m.checkBashCommand('echo x > /root/f')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/absolute-path write escape/)
  })

  it('blocks echo x >> /root/f (append redirect outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x >> /root/f').allowed).toBe(false)
  })

  it('allows echo x > out.txt (relative path — not blocked)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > out.txt').allowed).toBe(true)
  })

  it('allows npm install (no write target)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('npm install').allowed).toBe(true)
  })

  it('allows cat /root/f (read, not a write)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cat /root/f').allowed).toBe(true)
  })

  it('blocks tee /etc/x (tee to absolute outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo data | tee /etc/x').allowed).toBe(false)
  })

  it('blocks dd of=/root/disk.img', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('dd if=/dev/zero of=/root/disk.img bs=1M count=1').allowed).toBe(false)
  })

  it('blocks curl -o /root/f URL', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('curl -o /root/f https://example.com/file').allowed).toBe(false)
  })

  it('blocks cp src /root/b (cp destination outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp src/a.txt /root/b').allowed).toBe(false)
  })

  it('blocks mv a /root/b (mv destination outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('mv a.txt /root/b').allowed).toBe(false)
  })

  it('blocks mkdir /root/x (absolute path outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('mkdir /root/x').allowed).toBe(false)
  })

  it('allows echo x > /tmp/proj/out.txt (inside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > /tmp/proj/out.txt').allowed).toBe(true)
  })

  it('does NOT block when allowedPaths is empty (confinement not active)', () => {
    const m = new ActionMonitor()
    // No allowedPaths → confinement not active → bash absolute writes allowed
    expect(m.checkBashCommand('echo x > /root/f').allowed).toBe(true)
  })

  it('blocks redirect without space: echo x>/root/f', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x>/root/f').allowed).toBe(false)
  })
})

// ── Fix 4: symlink escape ─────────────────────────────────────────────────────

describe('Fix 4: symlink escape — symlink resolving to protected/home caught', () => {
  it('blocks write to a symlink whose real target is /root/.openclaw', () => {
    // Create a temp symlink pointing at /root/.openclaw
    const tmpLink = path.join(os.tmpdir(), `test-symlink-openclaw-${process.pid}`)
    try { fs.unlinkSync(tmpLink) } catch { /* not present */ }
    try {
      fs.symlinkSync('/root/.openclaw', tmpLink)
      const m = new ActionMonitor()
      const result = m.checkFileWrite(tmpLink)
      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/protected path/)
    } finally {
      try { fs.unlinkSync(tmpLink) } catch { /* cleanup */ }
    }
  })

  it('blocks write to a symlink outside allowedPaths when allowedPaths set', () => {
    const tmpLink = path.join(os.tmpdir(), `test-symlink-outside-${process.pid}`)
    const target = '/root'
    try { fs.unlinkSync(tmpLink) } catch { /* not present */ }
    try {
      fs.symlinkSync(target, tmpLink)
      const m = new ActionMonitor(['/tmp/proj'])
      const result = m.checkFileWrite(tmpLink)
      expect(result.allowed).toBe(false)
    } finally {
      try { fs.unlinkSync(tmpLink) } catch { /* cleanup */ }
    }
  })
})
