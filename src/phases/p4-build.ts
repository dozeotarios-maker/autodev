// S2-M3b: P4 BUILD — dispatch file-DAG lanes via SubagentDriver + collect results
//
// Steer-then-verify: host writes .autodev/phase-output/p4-build.json
// containing { phase:'P4', laneResults[], artifacts[] }.
// Uses SubagentDriver.invoke(tasks, { worktree: true }) for parallel lanes.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { SubagentDriver } from '../host/subagent-driver.js'
import type { P4Context, P4Output } from './phase-output.js'
import { validateP4Output } from './phase-output.js'
import type { PhaseResult } from './phase-executor.js'

const ROLE_DIRECTIVES = `
## Role: Build Agent (P4)
You are the P4 BUILD phase. Your job:
1. Implement the file-DAG by dispatching worktree lanes via the subagent tool.
2. Each lane builds its assigned files in isolation (worktree mode).
3. Collect and report all lane results and produced artifacts.
`.trim()

function buildP4Instruction(ctx: P4Context, outputFile: string): string {
  // Group file-DAG entries by lane
  const laneMap = new Map<number, string[]>()
  for (const entry of ctx.p3.fileDAG) {
    const existing = laneMap.get(entry.lane) ?? []
    existing.push(entry.file)
    laneMap.set(entry.lane, existing)
  }

  const laneTasks = Array.from(laneMap.entries()).map(([laneId, files]) => ({
    agent: `builder-lane-${laneId}`,
    task: `Implement the following files for lane ${laneId}:\n${files.map((f) => `- ${f}`).join('\n')}\n\nSprint goal: ${ctx.p3.sprintContract.goal}\nSuccess criteria:\n${ctx.p3.sprintContract.successCriteria.map((c) => `- ${c}`).join('\n')}`,
  }))

  return [
    ROLE_DIRECTIVES,
    '',
    `## Input`,
    `Sprint goal: ${ctx.p3.sprintContract.goal}`,
    `File-DAG: ${ctx.p3.fileDAG.length} files across ${laneMap.size} lanes`,
    '',
    `## Build lanes (run as parallel worktree subagents)`,
    'Call the `subagent` tool with:',
    '```json',
    JSON.stringify({
      tasks: laneTasks.map((t, i) => ({ index: i, ...t })),
      concurrency: Math.min(laneMap.size, 5),
      worktree: true,
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
        phase: 'P4',
        laneResults: [
          { laneId: 0, status: 'success', files: ['<string>'], output: '<string>' },
        ],
        artifacts: ['<string: relative path to produced file>'],
      },
      null,
      2
    ),
    '```',
    '',
    'Do NOT add extra fields. Write the file, then confirm "P4 output written."',
  ].join('\n')
}

export class P4Build {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    // SubagentDriver available for direct invocation path (alternative to LLM-mediated subagent tool)
    _subagentDriver?: SubagentDriver,
    private readonly timeoutMs?: number
  ) {}

  async execute(ctx: P4Context): Promise<PhaseResult<P4Output>> {
    const outputFile = path.join(this.outputDir, 'p4-build.json')
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    const instruction = buildP4Instruction(ctx, outputFile)

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `P4 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      const content = await fs.readFile(outputFile, 'utf-8')
      raw = JSON.parse(content)
    } catch (err) {
      return { ok: false, reason: `P4 file read failed: ${String(err)}` }
    }

    if (!validateP4Output(raw)) {
      return { ok: false, reason: 'P4 output failed schema validation' }
    }

    const output = raw

    // Gate: at least one lane must have succeeded
    const hasSuccess = output.laneResults.some((r) => r.status === 'success')
    if (!hasSuccess) {
      return { ok: false, reason: 'P4 gate: no lanes succeeded' }
    }

    return { ok: true, output }
  }
}
