// S2-M3a: P1 DISCOVER — web-research + spec + STACK-PICK + ADR + dep-vet
//
// Steer-then-verify: instructs host to write .autodev/phase-output/p1-spec.json
// containing { phase:'P1', spec, stackAdr, webResearch[] }.

import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { PhaseExecutor } from './phase-executor.js'
import type { P1Context, P1Output } from './phase-output.js'
import { validateP1Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'

const ROLE_DIRECTIVES = `
## Role: Discovery Agent (P1)
You are the P1 DISCOVER phase. Your job:
1. Conduct web research on the idea (3–5 sources, summarise each).
2. Write a concise specification (1–3 paragraphs) covering: problem, users, success criteria.
3. Select the best technology stack; record the decision as a brief Architecture Decision Record (stackAdr).
4. Vet all proposed dependencies for known vulnerabilities and license compatibility (G21).
`.trim()

export function buildP1Instruction(ctx: P1Context, outputFile: string): string {
  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Idea: ${ctx.idea}`,
    '',
    `## Required output`,
    `Write your result as valid JSON to: ${outputFile}`,
    '',
    'The JSON MUST match this schema exactly:',
    '```json',
    JSON.stringify(
      {
        phase: 'P1',
        spec: '<string: 1–3 paragraph specification>',
        stackAdr: '<string: technology stack ADR>',
        webResearch: [
          { url: '<string>', title: '<string>', summary: '<string>' },
        ],
      },
      null,
      2
    ),
    '```',
    '',
    'Do NOT add extra fields. Write the file, then confirm "P1 output written."',
  ].join('\n')
}

export class P1Discover {
  private executor: PhaseExecutor<P1Context, P1Output>

  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {
    const outputFile = path.join(outputDir, 'p1-spec.json')
    this.executor = new PhaseExecutor<P1Context, P1Output>(hostAgent, {
      phase: 'P1',
      outputFile,
      buildInstruction: (ctx) => buildP1Instruction(ctx, outputFile),
      validate: validateP1Output,
      gate: async (output) => {
        if (!output.spec || output.spec.trim().length < 20) {
          return 'P1 spec is too short (< 20 chars)'
        }
        if (!output.stackAdr || output.stackAdr.trim().length < 10) {
          return 'P1 stackAdr is too short (< 10 chars)'
        }
        return null
      },
      timeoutMs,
    })
  }

  async execute(ctx: P1Context): Promise<PhaseResult<P1Output>> {
    return this.executor.execute(ctx)
  }
}
