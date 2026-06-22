// M6c: G16 Playwright-MCP browser grounding — MCP boundary injected (G12)

export interface PlaywrightMCPAdapter {
  navigate(url: string): Promise<{ ok: boolean; error?: string }>
  screenshot(): Promise<{ path: string; base64: string }>
  evaluate(assertion: string): Promise<{ result: boolean }>
}

export interface GroundingInput {
  url: string
  assertion: string
}

export interface GroundingEvidence {
  screenshotPath: string
  url: string
  assertion: string
  passed: boolean
}

export interface GroundingResult {
  passed: boolean
  screenshotPath?: string
  error?: string
  evidence: GroundingEvidence
}

export class UIGrounding {
  constructor(private readonly mcp: PlaywrightMCPAdapter) {}

  async verify(input: GroundingInput): Promise<GroundingResult> {
    const nav = await this.mcp.navigate(input.url)
    if (!nav.ok) {
      const error = nav.error ?? 'navigation failed'
      return {
        passed: false,
        error,
        evidence: { screenshotPath: '', url: input.url, assertion: input.assertion, passed: false },
      }
    }

    const screenshot = await this.mcp.screenshot()
    const evaluated = await this.mcp.evaluate(input.assertion)

    const evidence: GroundingEvidence = {
      screenshotPath: screenshot.path,
      url: input.url,
      assertion: input.assertion,
      passed: evaluated.result,
    }

    return {
      passed: evaluated.result,
      screenshotPath: screenshot.path,
      evidence,
    }
  }
}
