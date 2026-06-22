// S2-M3a: P3 PLAN — scope→slice→plan + 10-persona panel + re-plan loop (capped at 3)
//
// Steer-then-verify: host writes:
//   .autodev/phase-output/p3-plan.json         (P3Output)
//   .autodev/phase-output/p3-sprint-contract.json  (SprintContract, also embedded in P3Output)
//   .autodev/phase-output/p3-examples.json         (ExampleEntry[], also embedded in P3Output)
//
// Re-plan loop: if panel objects, re-steer up to MAX_REPLAN_ROUNDS.
// After cap: surface remaining objections to operator as a structured brief.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { P3Context, P3Output } from './phase-output.js'
import { validateP3Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'
import { wrapUntrusted } from './safe-prompt.js'
import { DEFAULT_SIZING } from '../engine/complexity.js'

const MAX_REPLAN_ROUNDS = 3

const ALL_PLAN_PERSONAS = [
  'user', 'developer', 'security', 'ops', 'product-manager',
  'architect', 'qa', 'legal', 'accessibility', 'performance',
]

const ROLE_DIRECTIVES = `
## Role: Planning Agent (P3)
You are the P3 PLAN phase. Your job:
1. Scope: define what is IN and OUT of scope for this sprint.
2. Slice: break the work into a file-DAG (which files, in which lane, with which dependencies).
3. Plan: produce a sprint contract (goal, success criteria, out-of-scope) and examples table.
4. Run a persona panel via the subagent tool to review the plan.
5. If objections remain, revise and re-plan (this will be indicated in your context).
`.trim()

function buildP3Instruction(ctx: P3Context, outputFile: string, objections?: string): string {
  const sizing = ctx.sizing ?? DEFAULT_SIZING
  const panelCount = Math.min((sizing.panelPersonas) * 2, 10)
  const skipPanel = panelCount === 0
  const personas = ALL_PLAN_PERSONAS.slice(0, panelCount)

  const revisionNote = objections
    ? `\n## Revision context\nPrevious plan had these unresolved objections. Address them:\n${objections}\n`
    : ''

  const panelSection = skipPanel
    ? [
        `## Persona panel`,
        'Panel skipped (XS tier — panelPersonas=0). Set panelObjCount to 0.',
      ]
    : [
        `## Persona panel (run as parallel subagents, ${panelCount} personas)`,
        'Call the `subagent` tool with:',
        '```json',
        JSON.stringify({
          tasks: personas.map((p, i) => ({
            index: i,
            agent: p,
            task: `Review this sprint plan as a ${p} and list your top objections (or say "no objections").\n${wrapUntrusted(`Spec: ${ctx.p1.spec}\nDomain: ${ctx.p2.domainModel}`)}`,
          })),
          concurrency: panelCount,
          worktree: false,
        }, null, 2),
        '```',
      ]

  return [
    ROLE_DIRECTIVES,
    revisionNote,
    `## Input`,
    `Spec:\n${wrapUntrusted(ctx.p1.spec)}`,
    `Stack ADR:\n${wrapUntrusted(ctx.p1.stackAdr)}`,
    `Domain Model:\n${wrapUntrusted(ctx.p2.domainModel)}`,
    '',
    ...panelSection,
    '',
    `## Required output`,
    `Write your result as valid JSON to: ${outputFile}`,
    '',
    'The JSON MUST match this schema exactly:',
    '```json',
    JSON.stringify(
      {
        phase: 'P3',
        fileDAG: [{ file: '<string>', lane: 0, deps: ['<string>'] }],
        panelObjCount: 0,
        sprintContract: {
          goal: '<string>',
          successCriteria: ['<string>'],
          outOfScope: ['<string>'],
        },
        examplesTable: [
          { scenario: '<string>', input: '<string>', expectedOutput: '<string>' },
        ],
      },
      null,
      2
    ),
    '```',
    '',
    'Set panelObjCount to the total number of objections raised by the panel.',
    'If the panel had no objections, set panelObjCount to 0.',
    'Do NOT add extra fields. Write the file, then confirm "P3 output written."',
  ].join('\n')
}

export interface P3OperatorBrief {
  persistentObjections: string
  roundsAttempted: number
  lastOutput?: P3Output
}

export type P3Result =
  | { ok: true; output: P3Output }
  | { ok: false; reason: string; operatorBrief?: P3OperatorBrief }

export class P3Plan {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(ctx: P3Context): Promise<P3Result> {
    const outputFile = path.join(this.outputDir, 'p3-plan.json')
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    let lastOutput: P3Output | undefined
    let lastObjections: string | undefined

    for (let round = 0; round < MAX_REPLAN_ROUNDS; round++) {
      const instruction = buildP3Instruction(ctx, outputFile, lastObjections)

      let steerResult
      try {
        steerResult = await this.hostAgent.steer(instruction, {
          expectFile: outputFile,
          ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
        })
      } catch (err) {
        return { ok: false, reason: `P3 steer failed (round ${round + 1}): ${String(err)}` }
      }
      void steerResult

      // Read + validate
      let raw: unknown
      try {
        const content = await fs.readFile(outputFile, 'utf-8')
        raw = JSON.parse(content)
      } catch (err) {
        return { ok: false, reason: `P3 file read failed (round ${round + 1}): ${String(err)}` }
      }

      if (!validateP3Output(raw)) {
        return { ok: false, reason: `P3 output failed schema validation (round ${round + 1})` }
      }

      lastOutput = raw

      // Gate: validate sprint contract and examples table
      if (!lastOutput.sprintContract.goal || lastOutput.sprintContract.goal.trim().length < 10) {
        return { ok: false, reason: 'P3 sprint contract goal too short' }
      }
      if (lastOutput.sprintContract.successCriteria.length === 0) {
        return { ok: false, reason: 'P3 sprint contract must have at least one success criterion' }
      }
      if (lastOutput.fileDAG.length === 0) {
        return { ok: false, reason: 'P3 file-DAG must be non-empty' }
      }
      if (lastOutput.examplesTable.length === 0) {
        return { ok: false, reason: 'P3 examples table must be non-empty' }
      }

      // Check panel objection count
      if (lastOutput.panelObjCount === 0) {
        // No objections — plan accepted
        return { ok: true, output: lastOutput }
      }

      // There are objections — note them for the next round
      lastObjections = `Round ${round + 1}: panel raised ${lastOutput.panelObjCount} objection(s). Revise the plan to address them.`
    }

    // Exhausted re-plan rounds — surface to operator
    const brief: P3OperatorBrief = {
      persistentObjections: lastObjections ?? 'Unknown objections after max rounds',
      roundsAttempted: MAX_REPLAN_ROUNDS,
      lastOutput,
    }

    return {
      ok: false,
      reason: `P3 re-plan cap reached (${MAX_REPLAN_ROUNDS} rounds) with persistent objections`,
      operatorBrief: brief,
    }
  }
}
