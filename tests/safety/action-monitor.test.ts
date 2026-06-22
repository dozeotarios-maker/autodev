// M1 action-monitor test — written FIRST (D1)
import { describe, it, expect } from 'vitest'
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
})
