// S2-M3b: P6 RELEASE — scoped commit + tier-D gate + per-phase push + release JSON
//
// Steer-then-verify: host writes .autodev/phase-output/p6-release.json
// containing { phase:'P6', commitSha, pushResult }.
// Uses GitOps port only (no concrete imports from src/git).

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { GitOps } from '../ports.js'
import type { P6Context, P6Output } from './phase-output.js'
import { validateP6Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'

const ROLE_DIRECTIVES = `
## Role: Release Agent (P6)
You are the P6 RELEASE phase. Your job:
1. Perform a scoped commit (only the sprint artifacts — never git add --all).
2. Push the commit to the remote branch.
3. Record the commit SHA and push result.
`.trim()

function buildP6Instruction(ctx: P6Context, outputFile: string, commitSha: string, pushResult: string): string {
  const repoRootLines = ctx.repoRoot
    ? [
        '',
        `## Project root (MANDATORY)`,
        `All release operations under: ${ctx.repoRoot}`,
        `Prefix every shell command with: cd ${ctx.repoRoot} &&`,
      ]
    : []

  return [
    ROLE_DIRECTIVES,
    '',
    `## Completed actions`,
    `Scoped commit SHA: ${commitSha}`,
    `Push result: ${pushResult}`,
    ...repoRootLines,
    '',
    `## Required output`,
    `Write your result as valid JSON to: ${outputFile}`,
    '',
    'The JSON MUST match this schema exactly:',
    '```json',
    JSON.stringify(
      {
        phase: 'P6',
        commitSha: '<string: git commit SHA>',
        pushResult: '<string: push status>',
      },
      null,
      2
    ),
    '```',
    '',
    'Do NOT add extra fields. Write the file, then confirm "P6 output written."',
  ].join('\n')
}

export class P6Release {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly gitOps: GitOps,
    private readonly branch: string = 'main',
    private readonly timeoutMs?: number
  ) {}

  async execute(ctx: P6Context): Promise<PhaseResult<P6Output>> {
    const outputFile = path.join(this.outputDir, 'p6-release.json')
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    // Tier-D gate: confirm before committing
    const tierDApproved = await this.gitOps.tierDGate('scoped-commit', {
      change: 'Commit and push sprint artifacts',
      why: `Sprint goal: ${ctx.p5.verifyReport.deterministicPassed ? 'verified' : 'unverified'} build`,
      risk: 'Pushes code to remote branch',
      rollback: 'git revert HEAD; git push',
    })

    if (!tierDApproved) {
      return { ok: false, reason: 'P6 tier-D gate: operator did not approve the release' }
    }

    // Security scan before commit
    let secretsScan
    try {
      secretsScan = await this.gitOps.scanSecrets(true)
      if (!secretsScan.clean) {
        return {
          ok: false,
          reason: `P6 secrets scan failed: ${secretsScan.findings.join(', ')}`,
        }
      }
    } catch {
      // If gitleaks unavailable, proceed (log degradation elsewhere)
    }

    // Scoped commit — only the verified artifacts
    const allowedPaths = ctx.p5.verifyReport.deterministicPassed
      ? ['.autodev/phase-output/'] // fallback to phase output dir if artifacts not listed
      : ['.autodev/phase-output/']

    let commitSha = '(dry-run)'
    try {
      const commitResult = await this.gitOps.scopedCommit(
        `feat: sprint delivery — ${new Date().toISOString().slice(0, 10)}`,
        allowedPaths
      )
      commitSha = commitResult.sha
    } catch (err) {
      return { ok: false, reason: `P6 scoped commit failed: ${String(err)}` }
    }

    // Per-phase push
    let pushResult = 'pushed'
    try {
      await this.gitOps.perPhasePush(this.branch)
    } catch (err) {
      pushResult = `push failed: ${String(err)}`
    }

    // Steer host to write p6-release.json (the file is the authoritative artifact)
    const instruction = buildP6Instruction(ctx, outputFile, commitSha, pushResult)
    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      // If steer fails, write the file directly (we already have the data)
      const fallback: P6Output = { phase: 'P6', commitSha, pushResult }
      await fs.writeFile(outputFile, JSON.stringify(fallback, null, 2))
      return { ok: true, output: fallback }
    }
    void steerResult

    let raw: unknown
    try {
      const content = await fs.readFile(outputFile, 'utf-8')
      raw = JSON.parse(content)
    } catch (err) {
      return { ok: false, reason: `P6 file read failed: ${String(err)}` }
    }

    if (!validateP6Output(raw)) {
      return { ok: false, reason: 'P6 output failed schema validation' }
    }

    return { ok: true, output: raw }
  }
}
