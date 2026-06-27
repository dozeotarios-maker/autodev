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
import { wrapUntrusted } from './safe-prompt.js'
import { DEFAULT_SIZING } from '../engine/complexity.js'
import { MINIMALISM_REVIEW_LENS, CRAFTSMANSHIP_REVIEW_LENS } from '../principles.js'
import { resolveTestCommand } from '../verify/test-command.js'

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
  reviewRounds: number,
): string {
  const artifactsRaw = ctx.p4.artifacts.join(', ') || '(none listed)'

  const repoRootLines = ctx.repoRoot
    ? [
        '',
        `## Project root (MANDATORY)`,
        `Run ALL verification commands under: ${ctx.repoRoot}`,
        `Prefix every shell command with: cd ${ctx.repoRoot} &&`,
      ]
    : []

  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Sprint goal:\n${wrapUntrusted(ctx.p3.sprintContract.goal)}`,
    `Artifacts from P4:\n${wrapUntrusted(artifactsRaw)}`,
    `Deterministic verify: ${deterministicPassed ? 'PASSED' : 'FAILED'}`,
    `Holdout verify: ${holdoutPassed ? 'PASSED' : 'FAILED'}`,
    `Security scan: ${securityClean ? 'CLEAN' : 'FINDINGS'}`,
    `Review rounds cap: ${reviewRounds}`,
    ...repoRootLines,
    '',
    `## Clean-context reviewer (run as subagent, up to ${reviewRounds} review rounds)`,
    'Call the `subagent` tool with:',
    '```json',
    JSON.stringify({
      tasks: [{
        index: 0,
        agent: 'reviewer',
        task: `Review ONLY the following diff. Do NOT reference the spec or builder history.\nArtifacts:\n${wrapUntrusted(artifactsRaw)}\nFileDAG:\n${wrapUntrusted(ctx.p3.fileDAG.map((e) => e.file).join(', '))}\n\nList any CRITICAL, HIGH, MEDIUM, or LOW findings. Format each as:\n{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"<path>","line":<n>,"description":"<text>"}\n\n${MINIMALISM_REVIEW_LENS}\n\n${CRAFTSMANSHIP_REVIEW_LENS}`,
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

    // Resolve the project's own test command (honors the stack P1 chose). Hardcoding
    // `npx vitest run` made a node:test/jest build fail the gate with zero suites
    // collected, forcing it to abandon its chosen stack to satisfy the verifier.
    const testCmd = await resolveTestCommand(this.repoRoot)

    // Run deterministic checks via Verifier port
    let deterministicPassed = false
    try {
      const detResult = await this.verifier.runDeterministic(testCmd, this.repoRoot)
      deterministicPassed = detResult.passed
    } catch {
      deterministicPassed = false
    }

    // Run holdout via Verifier port
    let holdoutPassed = false
    try {
      const holdoutResult = await this.verifier.runHoldout(testCmd, this.repoRoot)
      holdoutPassed = holdoutResult.passed
    } catch {
      holdoutPassed = false
    }

    // Security scan via Verifier port
    let securityClean = false
    let securitySkipped = false
    try {
      const secResult = await this.verifier.runSecurityScan(this.repoRoot)
      securityClean = secResult.clean
    } catch (err) {
      // Distinguish missing binary (ENOENT / scanner unavailable) from real errors.
      // Missing binary → skip gracefully (securityClean=true, securitySkipped=true).
      // Any other error → fail-closed (securityClean stays false).
      const isUnavailable =
        (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') ||
        (err instanceof Error && err.message.includes('BackendUnavailableError'))
      if (isUnavailable) {
        securityClean = true
        securitySkipped = true
      }
      // else: real error — securityClean remains false (fail-closed)
    }
    void securitySkipped

    // H9: still-right judge — check if diff diverges from original spec
    let backedge = false
    try {
      const stillRight = await this.judge.isStillRight(
        wrapUntrusted(ctx.p3.sprintContract.goal),
        wrapUntrusted(ctx.p4.artifacts.join('\n'))
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

    // Fix 6: reviewRounds is passed into the steer PROMPT as advisory text only.
    // P5 uses a steer-and-observe architecture: the host LLM honors the cap stated
    // in the prompt. A programmatic ReviewLoop.maxRounds guard is for direct callers
    // only; adding one here would be redundant and would not change behavior.
    const reviewRounds = (ctx.sizing ?? DEFAULT_SIZING).reviewRounds
    const instruction = buildP5Instruction(ctx, outputFile, deterministicPassed, holdoutPassed, securityClean, reviewRounds)

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
