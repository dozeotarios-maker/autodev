// C-1 D1: Reproduce step — steers host to write a NEW dedicated repro vitest file.
// The host writes a D1 output JSON. The controller gate (in _runDebugTrack) then
// verifies the repro runs consistently RED via BoundedExec.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { validateD1Output } from './debug-output.js'
import type { D1Output } from './debug-output.js'

export interface D1Result {
  ok: boolean
  output?: D1Output
  reason?: string
}

export class D1Reproduce {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(bugReport: string, repoRoot: string): Promise<D1Result> {
    await fs.mkdir(this.outputDir, { recursive: true })
    const outputFile = path.join(this.outputDir, 'd1-reproduce.json')

    const instruction = [
      '## Role: Debug Repro Agent (D1)',
      '',
      'You are the D1 REPRODUCE step of the pi-autodev debug track.',
      'Your ONLY job: write a NEW dedicated vitest repro file that FAILS, demonstrating the reported bug.',
      '',
      '## Bug report',
      bugReport,
      '',
      '## Rules',
      '- Write a NEW file at a fresh path (e.g. tests/debug/repro-<short-name>.test.ts).',
      '- Do NOT edit any existing test file.',
      '- The repro MUST fail (be red) when run against the current code.',
      '- Keep the repro minimal and focused on the specific failure.',
      '- The reproCommand MUST use `npx vitest run <file>` as the command.',
      '',
      '## Required output',
      `Write your result as valid JSON to: ${outputFile}`,
      '',
      'The JSON MUST match this schema exactly:',
      '```json',
      '{',
      '  "reproSummary": "<one paragraph describing the repro approach>",',
      '  "reproCommand": "npx vitest run <path-to-repro-file>",',
      '  "reproArtifact": "<path-to-the-new-repro-file>"',
      '}',
      '```',
      '',
      'After writing the repro test file AND the JSON output file, confirm "D1 output written."',
      '',
      `The repo root is: ${repoRoot}`,
    ].join('\n')

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `D1 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `D1 output file read failed: ${String(err)}` }
    }

    if (!validateD1Output(raw)) {
      return { ok: false, reason: 'D1 output failed schema validation' }
    }

    return { ok: true, output: raw }
  }
}
