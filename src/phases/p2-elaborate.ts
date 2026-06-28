// S2-M3a: P2 ELABORATE — domain model + persona debate panel (host-self-synthesis)
//
// Steer-then-verify: host writes .autodev/phase-output/p2-domain.json
// containing { phase:'P2', domainModel, personaDebate[] }.
// The persona panel is synthesised by the host LLM adopting each persona in turn
// (not via parallel subagents — persona names are not valid subagent agent types).

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { PhaseExecutor } from './phase-executor.js'
import type { P2Context, P2Output } from './phase-output.js'
import { validateP2Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'
import { wrapUntrusted } from './safe-prompt.js'
import { DEFAULT_SIZING } from '../engine/complexity.js'
import type { PersonaPanel } from '../persona/persona-panel.js'
import { digestResearch } from '../persona/host-synthesis-fallback.js'
import { ALL_PERSONA_NAMES } from '../persona/persona-registry.js'

const ROLE_DIRECTIVES = `
## Role: Elaboration Agent (P2)
You are the P2 ELABORATE phase. Your job:
1. Build a domain model from the spec (entities, relationships, invariants).
2. Run a persona debate: synthesise objections from each persona's viewpoint.
3. Collect all objections; populate the personaDebate array.
`.trim()

const ALL_PERSONAS = ['user', 'developer', 'security', 'ops', 'product-manager']

// Note: persona names (user/developer/security/ops/product-manager) are NOT valid
// pi-subagent agent types. Host-self-synthesis is the designed path: the host LLM
// acts as each persona in turn and collects their objections internally.
// This avoids "Unknown agent" errors while producing equivalent debate quality.

export function buildP2Instruction(
  ctx: P2Context,
  outputFile: string,
  opts: { panelMode?: boolean } = {}
): string {
  const sizing = ctx.sizing ?? DEFAULT_SIZING
  const panelPersonas = sizing.panelPersonas
  const personas = ALL_PERSONAS.slice(0, panelPersonas)
  const skipPanel = panelPersonas === 0

  const panelSection = opts.panelMode
    ? [
        `## Persona panel`,
        'An independent persona panel (real subagents) reviews your domain model separately. Set personaDebate to [] — it is populated from the panel, not by you.',
      ]
    : skipPanel
    ? [
        `## Persona panel`,
        'Panel skipped (XS tier — panelPersonas=0). Set personaDebate to [].',
      ]
    : [
        `## Persona debate (host-synthesised, ${Math.min(panelPersonas, ALL_PERSONAS.length)} personas)`,
        `For each of the following personas, adopt that perspective and list their top 3 objections or concerns about the domain model:`,
        personas.map(p => `- **${p}**: Act as a ${p}. From that lens, what are your top 3 objections?`).join('\n'),
        '',
        'Synthesise all objections into the personaDebate array in the output JSON.',
        '(Do NOT use the subagent tool for this — persona names are not valid subagent types.)',
      ]

  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Spec:\n${wrapUntrusted(ctx.p1.spec)}`,
    `Stack ADR:\n${wrapUntrusted(ctx.p1.stackAdr)}`,
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
        phase: 'P2',
        domainModel: '<string: entities + relationships + invariants>',
        personaDebate: [
          { persona: '<string>', stance: '<string>', objections: ['<string>'] },
        ],
      },
      null,
      2
    ),
    '```',
    '',
    'Do NOT add extra fields. Write the file, then confirm "P2 output written."',
  ].join('\n')
}

export class P2Elaborate {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number,
    private readonly panel?: PersonaPanel
  ) {}

  async execute(ctx: P2Context): Promise<PhaseResult<P2Output>> {
    const outputFile = path.join(this.outputDir, 'p2-domain.json')
    const panelPersonas = ctx.sizing?.panelPersonas ?? DEFAULT_SIZING.panelPersonas

    // Real-subagent panel path: the host produces the domain model, the persona panel
    // reviews it as isolated subagents, and its objections are written authoritatively (R4).
    if (this.panel && panelPersonas > 0) {
      await fs.mkdir(path.dirname(outputFile), { recursive: true })
      return this._executeWithPanel(ctx, outputFile, panelPersonas)
    }

    const executor = new PhaseExecutor<P2Context, P2Output>(this.hostAgent, {
      phase: 'P2',
      outputFile,
      buildInstruction: (c) => buildP2Instruction(c, outputFile),
      validate: validateP2Output,
      gate: async (output) => {
        if (!output.domainModel || output.domainModel.trim().length < 20) {
          return 'P2 domainModel is too short (< 20 chars)'
        }
        // Relax empty-debate gate when XS (panelPersonas=0) — panel was intentionally skipped
        if (panelPersonas > 0 && (!Array.isArray(output.personaDebate) || output.personaDebate.length === 0)) {
          return 'P2 personaDebate must have at least one entry'
        }
        return null
      },
      timeoutMs: this.timeoutMs,
    })

    return executor.execute(ctx)
  }

  private async _executeWithPanel(
    ctx: P2Context,
    outputFile: string,
    panelPersonas: number
  ): Promise<PhaseResult<P2Output>> {
    // 1. Host produces the domain model only (panel mode: no host persona synthesis).
    try {
      await this.hostAgent.steer(buildP2Instruction(ctx, outputFile, { panelMode: true }), {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `P2 steer failed: ${String(err)}` }
    }

    // 2. Read + validate the host output.
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `P2 file read failed: ${String(err)}` }
    }
    if (!validateP2Output(raw)) {
      return { ok: false, reason: 'P2 output failed schema validation' }
    }
    const output: P2Output = raw
    if (!output.domainModel || output.domainModel.trim().length < 20) {
      return { ok: false, reason: 'P2 domainModel is too short (< 20 chars)' }
    }

    // 3. Persona panel reviews the domain model as isolated subagents.
    const personas = await this.panel!.select(ctx.p1.spec, ALL_PERSONA_NAMES, panelPersonas)
    const panelDebate = await this.panel!.dispatch(personas, {
      phase: 'P2',
      idea: ctx.p1.spec,
      spec: ctx.p1.spec,
      stackAdr: ctx.p1.stackAdr,
      domainModel: output.domainModel,
      research: digestResearch(ctx.p1.webResearch),
    })

    // 4. R4: panel objections are authoritative — overwrite whatever the host left.
    output.personaDebate = panelDebate
    await fs.writeFile(outputFile, JSON.stringify(output, null, 2))
    return { ok: true, output }
  }
}
