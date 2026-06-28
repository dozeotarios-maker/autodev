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
import type { P3Context, P3Output, PersonaDebateEntry } from './phase-output.js'
import { validateP3Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'
import { wrapUntrusted } from './safe-prompt.js'
import { DEFAULT_SIZING } from '../engine/complexity.js'
import { MINIMALISM_DIRECTIVE, CRAFTSMANSHIP_DIRECTIVE } from '../principles.js'
import type { PersonaPanel } from '../persona/persona-panel.js'
import { digestResearch } from '../persona/host-synthesis-fallback.js'
import { ALL_PERSONA_NAMES } from '../persona/persona-registry.js'

const MAX_REPLAN_ROUNDS = 3

// R2: single source of truth — the persona registry (legal dropped, autonomous-engineer
// added). Registry order is the deterministic candidate order.
const ALL_PLAN_PERSONAS = ALL_PERSONA_NAMES

// Legacy (no-panel) path host-synthesises the debate. The panel path runs real isolated
// subagents and writes panelObjCount authoritatively.

const ROLE_DIRECTIVES = `
## Role: Planning Agent (P3)
You are the P3 PLAN phase. Your job:
1. Scope: define what is IN and OUT of scope for this sprint.
2. Slice: break the work into a file-DAG (which files, in which lane, with which dependencies).
3. Plan: produce a sprint contract (goal, success criteria, out-of-scope) and examples table.
4. Run a persona debate (host-synthesised) to review the plan.
5. If objections remain, revise and re-plan (this will be indicated in your context).
`.trim()

function buildP3Instruction(
  ctx: P3Context,
  outputFile: string,
  objections?: string,
  opts: { panelMode?: boolean } = {}
): string {
  const sizing = ctx.sizing ?? DEFAULT_SIZING
  const panelCount = Math.min((sizing.panelPersonas) * 2, 10)
  const skipPanel = panelCount === 0
  const personas = ALL_PLAN_PERSONAS.slice(0, panelCount)

  const revisionNote = objections
    ? `\n## Revision context\nPrevious plan had these unresolved objections. Address them:\n${objections}\n`
    : ''

  const panelSection = opts.panelMode
    ? [
        `## Persona panel`,
        'An independent persona panel (real subagents) reviews your plan separately. Set panelObjCount to 0 — it is recomputed from the panel, not by you.',
      ]
    : skipPanel
    ? [
        `## Persona panel`,
        'Panel skipped (XS tier — panelPersonas=0). Set panelObjCount to 0.',
      ]
    : [
        `## Persona debate (host-synthesised, ${panelCount} personas)`,
        `For each of the following personas, adopt that perspective and list their top objections about the sprint plan (or say "no objections"):`,
        personas.map(p => `- **${p}**: As a ${p}, what are your top objections to this plan?`).join('\n'),
        '',
        `Context for personas:\n${wrapUntrusted(`Spec: ${ctx.p1.spec}\nDomain: ${ctx.p2.domainModel}`)}`,
        '',
        'Count the total number of distinct objections raised across all personas and set panelObjCount to that number.',
        '(Do NOT use the subagent tool for this — persona names are not valid subagent types.)',
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
    '',
    MINIMALISM_DIRECTIVE,
    '',
    CRAFTSMANSHIP_DIRECTIVE,
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
    private readonly timeoutMs?: number,
    private readonly panel?: PersonaPanel
  ) {}

  async execute(ctx: P3Context): Promise<P3Result> {
    const outputFile = path.join(this.outputDir, 'p3-plan.json')
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    const panelCount = Math.min((ctx.sizing ?? DEFAULT_SIZING).panelPersonas * 2, 10)
    const panelActive = !!this.panel && panelCount > 0

    let lastOutput: P3Output | undefined
    let lastObjections: string | undefined

    for (let round = 0; round < MAX_REPLAN_ROUNDS; round++) {
      const instruction = buildP3Instruction(ctx, outputFile, lastObjections, { panelMode: panelActive })

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

      // Persona review: real subagent panel (authoritative count) or the host's own count.
      if (panelActive) {
        const review = await this._panelReview(ctx, outputFile, lastOutput, round, panelCount)
        if (review.done) return { ok: true, output: lastOutput }
        lastObjections = review.objections
      } else {
        if (lastOutput.panelObjCount === 0) {
          // No objections — plan accepted
          return { ok: true, output: lastOutput }
        }
        // There are objections — note them for the next round
        lastObjections = `Round ${round + 1}: panel raised ${lastOutput.panelObjCount} objection(s). Revise the plan to address them.`
      }
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

  /**
   * Run the real-subagent panel against the plan the host just produced; write the
   * authoritative panelObjCount (R4) and, if objections remain, return their actual text
   * for the next re-plan round (R7).
   */
  private async _panelReview(
    ctx: P3Context,
    outputFile: string,
    output: P3Output,
    round: number,
    panelCount: number
  ): Promise<{ done: boolean; objections?: string }> {
    // The panel degrades internally; a throw here (selector/dispatch error) degrades to
    // "no objections" (accept the plan) rather than crashing the phase.
    let debate: PersonaDebateEntry[]
    try {
      const personas = await this.panel!.select(ctx.p1.spec, ALL_PERSONA_NAMES, panelCount)
      const planSummary = [
        `Goal: ${output.sprintContract.goal}`,
        `Files: ${output.fileDAG.map((e) => e.file).join(', ')}`,
        `Success: ${output.sprintContract.successCriteria.join('; ')}`,
      ].join('\n')
      debate = await this.panel!.dispatch(personas, {
        phase: 'P3',
        idea: ctx.p1.spec,
        spec: ctx.p1.spec,
        stackAdr: ctx.p1.stackAdr,
        domainModel: ctx.p2.domainModel,
        planSummary,
        research: digestResearch(ctx.p1.webResearch),
      })
    } catch {
      debate = []
    }
    const objCount = debate.reduce((n, d) => n + d.objections.length, 0)
    output.panelObjCount = objCount // R4: authoritative count
    await fs.writeFile(outputFile, JSON.stringify(output, null, 2))
    if (objCount === 0) return { done: true }
    // R7: hand the host the actual objections, not just a count.
    const objections =
      `Round ${round + 1} panel objections:\n` +
      debate.flatMap((d) => d.objections.map((o) => `- ${d.persona}: ${o}`)).join('\n')
    return { done: false, objections }
  }
}
