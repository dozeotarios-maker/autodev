// S2-M7: UIGrounding — Playwright-MCP adapter injected; null degrades gracefully
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UIGrounding } from '../../src/verify/ui-grounding.js'

describe('S2-M7: UIGrounding (G16)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens URL and returns screenshot evidence artifact', async () => {
    const mockMCP = {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({
        path: '/tmp/screenshot-001.png',
        base64: 'iVBORw0KGgoAAAANS...',
      }),
      evaluate: vi.fn().mockResolvedValue({ result: true }),
    }
    const grounding = new UIGrounding(mockMCP)
    const result = await grounding.verify({
      url: 'http://localhost:3000',
      assertion: 'login button visible',
    })
    expect(result.passed).toBe(true)
    expect(result.screenshotPath).toBeTruthy()
    expect(result.evidence).toHaveProperty('screenshotPath')
  })

  it('fails when navigation returns not-ok', async () => {
    const mockMCP = {
      navigate: vi.fn().mockResolvedValue({ ok: false, error: 'Connection refused' }),
      screenshot: vi.fn().mockResolvedValue({ path: '', base64: '' }),
      evaluate: vi.fn().mockResolvedValue({ result: false }),
    }
    const grounding = new UIGrounding(mockMCP)
    const result = await grounding.verify({
      url: 'http://localhost:9999',
      assertion: 'any',
    })
    expect(result.passed).toBe(false)
    expect(result.error).toMatch(/Connection refused|navigation/i)
  })

  it('calls screenshot — evidence artifact produced', async () => {
    const mockMCP = {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({ path: '/tmp/shot.png', base64: 'abc' }),
      evaluate: vi.fn().mockResolvedValue({ result: true }),
    }
    const grounding = new UIGrounding(mockMCP)
    await grounding.verify({ url: 'http://localhost:3000', assertion: 'page loaded' })
    expect(mockMCP.screenshot).toHaveBeenCalledOnce()
  })

  it('MCP boundary is injected — not imported directly', () => {
    const mockMCP = {
      navigate: vi.fn(),
      screenshot: vi.fn(),
      evaluate: vi.fn(),
    }
    expect(() => new UIGrounding(mockMCP)).not.toThrow()
  })

  it('fails assertion when evaluate returns false', async () => {
    const mockMCP = {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({ path: '/tmp/s.png', base64: 'x' }),
      evaluate: vi.fn().mockResolvedValue({ result: false }),
    }
    const grounding = new UIGrounding(mockMCP)
    const result = await grounding.verify({
      url: 'http://localhost:3000',
      assertion: 'submit button exists',
    })
    expect(result.passed).toBe(false)
  })

  it('evidence artifact includes url and assertion', async () => {
    const mockMCP = {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({ path: '/tmp/s2.png', base64: 'y' }),
      evaluate: vi.fn().mockResolvedValue({ result: true }),
    }
    const grounding = new UIGrounding(mockMCP)
    const result = await grounding.verify({
      url: 'http://localhost:3000/dashboard',
      assertion: 'dashboard visible',
    })
    expect(result.evidence.url).toBe('http://localhost:3000/dashboard')
    expect(result.evidence.assertion).toBe('dashboard visible')
  })

  it('degrades gracefully when MCP adapter is null (skip + log, no crash)', async () => {
    const grounding = new UIGrounding(null)
    const result = await grounding.verify({
      url: 'http://localhost:3000',
      assertion: 'any',
    })
    expect(result.skipped).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.error).toMatch(/not available/i)
  })
})
