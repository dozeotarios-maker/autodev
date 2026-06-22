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

const ROLE_DIRECTIVES = `
## Role: Elaboration Agent (P2)
You are the P2 ELABORATE phase. Your job:
1. Build a domain model from the spec (entities, relationships, invariants).
2. Run a persona debate: use the subagent tool to spawn 5 personas (user, dev, security, ops, PM).
   Each persona critiques the domain model from their perspective.
3. Collect all objections; synthesise them into the personaDebate array.
`.trim()

const PERSONAS = ['user', 'developer', 'security', 'ops', 'product-manager']

export function buildP2Instruction(ctx: P2Context, outputFile: string): string {
  const personaTasks = PERSONAS.map((p) => ({
    agent: p,
    task: `Review this domain model as a ${p} and list your top 3 objections or concerns.\n${wrapUntrusted(ctx.p1.spec)}`,
  }))

  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Spec:\n${wrapUntrusted(ctx.p1.spec)}`,
    `Stack ADR:\n${wrapUntrusted(ctx.p1.stackAdr)}`,
    '',
    `## Persona panel (run as parallel subagents)`,
    'Call the `subagent` tool with:',
    '```json',
    JSON.stringify({ tasks: personaTasks.map((t, i) => ({ index: i, ...t })), concurrency: 5, worktree: false }, null, 2),
    '```',
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
  private executor: PhaseExecutor<P2Context, P2Output>

  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    // SubagentDriver injected but the actual subagent call is embedded in the steer instruction.
    // The host LLM uses the subagent tool to run the panel — SubagentDriver is kept here
    // for potential direct invocation (e.g. in alternative flow or direct-invoke path).
    _subagentDriver?: SubagentDriver,
    private readonly timeoutMs?: number
  ) {
    const outputFile = path.join(outputDir, 'p2-domain.json')
    this.executor = new PhaseExecutor<P2Context, P2Output>(hostAgent, {
      phase: 'P2',
      outputFile,
      buildInstruction: (ctx) => buildP2Instruction(ctx, outputFile),
      validate: validateP2Output,
      gate: async (output) => {
        if (!output.domainModel || output.domainModel.trim().length < 20) {
          return 'P2 domainModel is too short (< 20 chars)'
        }
        if (!Array.isArray(output.personaDebate) || output.personaDebate.length === 0) {
          return 'P2 personaDebate must have at least one entry'
        }
        return null
      },
      timeoutMs,
    })
  }

  async execute(ctx: P2Context): Promise<PhaseResult<P2Output>> {
    return this.executor.execute(ctx)
  }
}
