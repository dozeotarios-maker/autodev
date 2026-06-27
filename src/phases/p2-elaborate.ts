// S2-M3a: P2 ELABORATE — domain model + persona debate panel (parallel subagents)
//
// Steer-then-verify: host writes .autodev/phase-output/p2-domain.json
// containing { phase:'P2', domainModel, personaDebate[] }.
// The persona panel runs as parallel subagents via SubagentDriver.

import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { SubagentDriver } from '../host/subagent-driver.js'
import { PhaseExecutor } from './phase-executor.js'
import type { P2Context, P2Output } from './phase-output.js'
import { validateP2Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'
import { wrapUntrusted } from './safe-prompt.js'
import { DEFAULT_SIZING } from '../engine/complexity.js'

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

export function buildP2Instruction(ctx: P2Context, outputFile: string): string {
  const sizing = ctx.sizing ?? DEFAULT_SIZING
  const panelPersonas = sizing.panelPersonas
  const personas = ALL_PERSONAS.slice(0, panelPersonas)
  const skipPanel = panelPersonas === 0

  const panelSection = skipPanel
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
    // SubagentDriver injected but the actual subagent call is embedded in the steer instruction.
    // The host LLM uses the subagent tool to run the panel — SubagentDriver is kept here
    // for potential direct invocation (e.g. in alternative flow or direct-invoke path).
    _subagentDriver?: SubagentDriver,
    private readonly timeoutMs?: number
  ) {}

  async execute(ctx: P2Context): Promise<PhaseResult<P2Output>> {
    const outputFile = path.join(this.outputDir, 'p2-domain.json')
    const panelPersonas = ctx.sizing?.panelPersonas ?? DEFAULT_SIZING.panelPersonas

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
}
