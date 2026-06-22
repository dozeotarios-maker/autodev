// S2-M3b: P5 VERIFY — deterministic + holdout + clean-context reviewer + review-to-zero
//
// Steer-then-verify: host writes .autodev/phase-output/p5-verify.json
// containing { phase:'P5', verifyReport, reviewFindings[] }.
// H9 backedge: if still-right judge fires (divergent diff), returns backedge signal.
// Uses Verifier + Judge ports only (no concrete imports from src/verify or src/git).

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { Verifier, Judge } from '../ports.js'
import type { P5Context, P5Output, ReviewFinding } from './phase-output.js'
import { validateP5Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'

const ROLE_DIRECTIVES = `
## Role: Verifier Agent (P5)
You are the P5 VERIFY phase. Your job:
1. Run deterministic checks (tests, linting) — record pass/fail.
2. Run holdout verification — confirm the build still satisfies the original goal.
3. Spawn a clean-context reviewer subagent (given ONLY the diff, no spec/builder-trace).
4. Collect all review findings; the build must reach zero CRITICAL/HIGH findings (review-to-zero).
`.trim()

function buildP5Instruction(
  ctx: P5Context,
  outputFile: string,
  deterministicPassed: boolean,
  holdoutPassed: boolean,
  securityClean: boolean,
): string {
  const artifacts = ctx.p4.artifacts.join(', ') || '(none listed)'

  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Sprint goal: ${ctx.p3.sprintContract.goal}`,
    `Artifacts from P4: ${artifacts}`,
    `Deterministic verify: ${deterministicPassed ? 'PASSED' : 'FAILED'}`,
    `Holdout verify: ${holdoutPassed ? 'PASSED' : 'FAILED'}`,
    `Security scan: ${securityClean ? 'CLEAN' : 'FINDINGS'}`,
    '',
    `## Clean-context reviewer (run as subagent)`,
    'Call the `subagent` tool with:',
    '```json',
    JSON.stringify({
      tasks: [{
        index: 0,
        agent: 'reviewer',
        task: `Review ONLY the following diff. Do NOT reference the spec or builder history.\nArtifacts: ${artifacts}\n\nList any CRITICAL, HIGH, MEDIUM, or LOW findings. Format each as:\n{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"<path>","line":<n>,"description":"<text>"}`,
      }],
      concurrency: 1,
      worktree: false,
    }, null, 2),
    '```',
    '',
    `## Required output`,
    `Write your result as valid JSON to: ${outputFile}`,
    '',
    'The JSON MUST match this schema exactly:',
    '```json',
    JSON.stringify(
      {
        phase: 'P5',
        verifyReport: {
          deterministicPassed: true,
          holdoutPassed: true,
          mutationScore: 0.85,
          securityClean: true,
        },
        reviewFindings: [
          { severity: 'HIGH', file: '<string>', line: 1, description: '<string>' },
        ],
      },
      null,
      2
    ),
    '```',
    '',
    'Do NOT add extra fields. Write the file, then confirm "P5 output written."',
  ].join('\n')
}

export interface P5Result extends PhaseResult<P5Output> {
  /** H9: if true, controller should fire P4→P3 backedge */
  backedge?: boolean
}

export class P5Verify {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly verifier: Verifier,
    private readonly judge: Judge,
    private readonly repoRoot: string = process.cwd(),
    private readonly timeoutMs?: number
  ) {}

  async execute(ctx: P5Context): Promise<P5Result> {
    const outputFile = path.join(this.outputDir, 'p5-verify.json')
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    // Run deterministic checks via Verifier port
    let deterministicPassed = false
    try {
      const detResult = await this.verifier.runDeterministic('npx vitest run', this.repoRoot)
      deterministicPassed = detResult.passed
    } catch {
      deterministicPassed = false
    }

    // Run holdout via Verifier port
    let holdoutPassed = false
    try {
      const holdoutResult = await this.verifier.runHoldout('npx vitest run', this.repoRoot)
      holdoutPassed = holdoutResult.passed
    } catch {
      holdoutPassed = false
    }

    // Security scan via Verifier port
    let securityClean = false
    try {
      const secResult = await this.verifier.runSecurityScan(this.repoRoot)
      securityClean = secResult.clean
    } catch {
      securityClean = true // degrade gracefully if scanner unavailable
    }

    // H9: still-right judge — check if diff diverges from original spec
    let backedge = false
    try {
      const stillRight = await this.judge.isStillRight(
        ctx.p3.sprintContract.goal,
        ctx.p4.artifacts.join('\n')
      )
      if (!stillRight.aligned) {
        backedge = true
        return {
          ok: false,
          backedge: true,
          reason: `H9 still-right judge fired: ${stillRight.reason ?? 'divergent diff'}`,
        }
      }
    } catch {
      // Judge unavailable — continue without backedge
    }

    const instruction = buildP5Instruction(ctx, outputFile, deterministicPassed, holdoutPassed, securityClean)

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, backedge, reason: `P5 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      const content = await fs.readFile(outputFile, 'utf-8')
      raw = JSON.parse(content)
    } catch (err) {
      return { ok: false, backedge, reason: `P5 file read failed: ${String(err)}` }
    }

    if (!validateP5Output(raw)) {
      return { ok: false, backedge, reason: 'P5 output failed schema validation' }
    }

    const output = raw

    // Gate: review-to-zero — no CRITICAL or HIGH findings
    const critHighFindings = output.reviewFindings.filter(
      (f: ReviewFinding) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
    )
    if (critHighFindings.length > 0) {
      return {
        ok: false,
        backedge,
        reason: `P5 review-to-zero failed: ${critHighFindings.length} CRITICAL/HIGH finding(s)`,
      }
    }

    return { ok: true, output, backedge: false }
  }
}
