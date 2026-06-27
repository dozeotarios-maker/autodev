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

// ── Item 2: tilde / $HOME / quoted redirect targets must be expanded then checked ──

describe('Item 2: bash redirect targets — tilde/$HOME expansion + quote stripping', () => {
  const HOME = os.homedir()

  it('blocks echo x > ~/f (tilde expands to $HOME, outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    const result = m.checkBashCommand('echo x > ~/f')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/absolute-path write escape/)
  })

  it('blocks echo x > "/root/f" (quoted absolute path outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > "/root/f"').allowed).toBe(false)
  })

  it('blocks echo x > "${HOME}/f" (braced $HOME expands, outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > "${HOME}/f"').allowed).toBe(false)
  })

  it('blocks echo x > $HOME/f (bare $HOME expands, outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > $HOME/f').allowed).toBe(false)
  })

  it("blocks echo x > '/root/f' (single-quoted absolute path)", () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand("echo x > '/root/f'").allowed).toBe(false)
  })

  it('allows echo x > ./rel.txt (relative path stays allowed)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('echo x > ./rel.txt').allowed).toBe(true)
  })

  it('allows cat ~/.bashrc (read, not a write)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cat ~/.bashrc').allowed).toBe(true)
  })

  it('allows redirect to a tilde path INSIDE allowedPaths', () => {
    // allowedPaths includes $HOME itself → ~/f expands under it → allowed
    const m = new ActionMonitor([HOME])
    expect(m.checkBashCommand('echo x > ~/f').allowed).toBe(true)
  })
})

// ── Item 3: cp/mv segment detection + -t/--target-directory ────────────────────

describe('Item 3: cp/mv in any segment + target-directory flag', () => {
  it('blocks cd /tmp && cp a /root/f (cp is head of a later &&-segment)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    const result = m.checkBashCommand('cd /tmp && cp a /root/f')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/absolute-path write escape/)
  })

  it('blocks cp -t /root/d a (-t target-directory outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp -t /root/d a').allowed).toBe(false)
  })

  it('blocks cp --target-directory=/root/d a (long-form target-directory)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp --target-directory=/root/d a').allowed).toBe(false)
  })

  it('blocks mv -t /root/d a (mv with -t target outside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('mv -t /root/d a').allowed).toBe(false)
  })

  it('blocks foo; cp a /root/b (cp head of a ;-segment)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('foo; cp a /root/b').allowed).toBe(false)
  })

  it('blocks cp a.txt b.txt /root/dst (absolute path among multiple args)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp a.txt b.txt /root/dst').allowed).toBe(false)
  })

  it('allows cp /root/src ./local (only abs path is a SOURCE inside no-write-dst — dest relative)', () => {
    // NOTE: per task spec this must be ALLOWED. The cp scan flags an abs path that is
    // outside allowedPaths; /root/src is a read source. Spec says allow this case.
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp /root/src ./local').allowed).toBe(true)
  })

  it('allows cp a ./local (no absolute paths at all)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp a ./local').allowed).toBe(true)
  })

  it('allows cp a /tmp/proj/dst (destination inside allowedPaths)', () => {
    const m = new ActionMonitor(['/tmp/proj'])
    expect(m.checkBashCommand('cp a /tmp/proj/dst').allowed).toBe(true)
  })
})

// ── Item 4: realpathSafe walks up to nearest existing ancestor on ENOENT ─────────

describe('Item 4: realpathSafe dereferences a symlinked parent for a missing leaf', () => {
  it('a write to <symlinked-parent>/missing-leaf resolves through the symlink', () => {
    // realParent is the true target; linkParent is a symlink to it. The leaf does
    // NOT exist, so a naive realpathSync(leaf) throws ENOENT and falls back to
    // path.resolve (which does NOT follow the symlink). The walk-up fix must
    // realpath the existing symlinked parent then re-join the missing leaf.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'item4-realpath-'))
    const realParent = path.join(base, 'real-parent')
    const linkParent = path.join(base, 'link-parent')
    fs.mkdirSync(realParent, { recursive: true })
    try {
      fs.symlinkSync(realParent, linkParent)
      // allowedPaths = realParent only. Writing under the SYMLINK path must be
      // recognised as inside realParent (deref) → allowed.
      const m = new ActionMonitor([realParent])
      const viaLink = path.join(linkParent, 'subdir', 'newfile.ts') // leaf missing
      expect(m.checkFileWrite(viaLink).allowed).toBe(true)

      // Conversely, a symlink whose real parent is OUTSIDE allowedPaths must be
      // blocked even for a missing leaf (deref reveals the true location).
      const outsideReal = path.join(base, 'outside-real')
      const outsideLink = path.join(base, 'outside-link')
      fs.mkdirSync(outsideReal, { recursive: true })
      fs.symlinkSync(outsideReal, outsideLink)
      const viaOutside = path.join(outsideLink, 'x', 'missing.ts')
      expect(m.checkFileWrite(viaOutside).allowed).toBe(false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
