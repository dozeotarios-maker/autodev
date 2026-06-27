// C-1 D3: Fix step — steers host to implement the minimal fix for the root cause.
// The host must NOT edit the repro file. The controller gate (anti-cheat) verifies
// this deterministically via gitOps.changedFiles + content hash.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { validateD3Output } from './debug-output.js'
import type { D3Output } from './debug-output.js'
import type { D1Output } from './debug-output.js'
import type { D2Output } from './debug-output.js'

export interface D3Result {
  ok: boolean
  output?: D3Output
  reason?: string
}

export class D3Fix {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(
    bugReport: string,
    d1: D1Output,
    d2: D2Output
  ): Promise<D3Result> {
    await fs.mkdir(this.outputDir, { recursive: true })
    const outputFile = path.join(this.outputDir, 'd3-fix.json')

    const instruction = [
      '## Role: Debug Fix Agent (D3)',
      '',
      'You are the D3 FIX step of the pi-autodev debug track.',
      'Your job: implement the MINIMAL fix for the identified root cause.',
      '',
      '## Bug report',
      bugReport,
      '',
      '## Root cause (from D2)',
      `Root cause: ${d2.rootCause}`,
      `Location: ${d2.rootCauseLocation}`,
      '',
      '## Repro file (DO NOT TOUCH THIS FILE)',
      `The repro file is: ${d1.reproArtifact}`,
      'You MUST NOT edit, modify, rename, or delete this file.',
      '',
      '## Rules',
      '- Implement the MINIMAL fix — change as few lines as possible.',
      '- Do NOT edit the repro file (see above).',
      '- Do NOT add new test files (except if the fix requires a new production module).',
      '- List every production file you changed in filesChanged.',
      '',
      '## Required output',
      `Write your result as valid JSON to: ${outputFile}`,
      '',
      'The JSON MUST match this schema exactly:',
      '```json',
      '{',
      '  "fixSummary": "<one paragraph describing what you changed and why>",',
      '  "filesChanged": ["<path/to/changed/file.ts>", "..."]',
      '}',
      '```',
      '',
      'After writing the fix AND the JSON output file, confirm "D3 output written."',
    ].join('\n')

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `D3 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `D3 output file read failed: ${String(err)}` }
    }

    if (!validateD3Output(raw)) {
      return { ok: false, reason: 'D3 output failed schema validation' }
    }

    return { ok: true, output: raw }
  }
}
