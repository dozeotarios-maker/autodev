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

const MEMORY_CHAR_CAP = 1500

/**
 * Recall prior memory hits, screen each for injection threats, and return a
 * capped block to inject into the P1 instruction.
 * Returns undefined on any error (memory absent, backend down, screening error) —
 * callers must degrade gracefully.
 */
async function recallMemoryBlock(ctx: P1Context): Promise<string | undefined> {
  if (!ctx.memoryStore) return undefined
  // Fix #6: fail-closed — if memoryStore is present but screenContent is absent,
  // we cannot safely screen recalled hits → drop all hits rather than inject unscreened content.
  if (!ctx.screenContent) return undefined
  try {
    const hits = await ctx.memoryStore.recall(ctx.idea, 3)
    const safeLines: string[] = []
    for (const hit of hits) {
      // Fix #4: screen the exact string that will be injected (the full "- value" line),
      // not just hit.value, so the screener sees what the model actually receives.
      const injectedLine = `- ${hit.value}`
      let safe = true
      try {
        const result = await ctx.screenContent(injectedLine, 'repo')
        if (!result.safe) { safe = false }
      } catch {
        // screening error → drop the hit (fail-safe)
        safe = false
      }
      if (safe) {
        safeLines.push(injectedLine)
      }
    }
    if (safeLines.length === 0) return undefined
    const block = safeLines.join('\n')
    // Fix #5: truncate at a line boundary to avoid partial/malformed trailing bullets.
    const capped = block.length > MEMORY_CHAR_CAP
      ? block.slice(0, MEMORY_CHAR_CAP).replace(/\n[^\n]*$/, '') + '\n...(truncated)'
      : block
    return capped
  } catch {
    // backend error → degrade silently
    return undefined
  }
}

// Fix #7: collapsed to a single overload — the async path only activates when memoryStore
// is present; callers that don't need to await can check ctx.memoryStore themselves.
export function buildP1Instruction(ctx: P1Context, outputFile: string): string | Promise<string> {
  const base = [
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

  // If no memory backend, return synchronously (preserves byte-identical baseline).
  if (!ctx.memoryStore) return base

  // Memory present: async path — recall, screen, cap, inject.
  return recallMemoryBlock(ctx).then((block) => {
    if (!block) return base
    return [
      base,
      '',
      '## Prior memory (screened)',
      block,
    ].join('\n')
  })
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
