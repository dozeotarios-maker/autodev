// Stage D R2: Transform step — steers host to apply the refactor.
// The host must NOT edit the characterization file (it is the oracle).
// The controller gate (anti-cheat) verifies this deterministically via
// gitOps.changedFiles + SHA-256 content hash.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { validateR2Output } from './refactor-output.js'
import type { R2Output } from './refactor-output.js'
import type { R1Output } from './refactor-output.js'

export interface R2Result {
  ok: boolean
  output?: R2Output
  reason?: string
}

export class R2Transform {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(
    refactorRequest: string,
    r1: R1Output
  ): Promise<R2Result> {
    await fs.mkdir(this.outputDir, { recursive: true })
    const outputFile = path.join(this.outputDir, 'r2-transform.json')

    const instruction = [
      '## Role: Refactor Transform Agent (R2)',
      '',
      'You are the R2 TRANSFORM step of the pi-autodev refactor track.',
      'Your job: apply the refactor (the user\'s request). Preserve observable behavior.',
      '',
      '## Refactor request',
      refactorRequest,
      '',
      '## Characterization summary (from R1)',
      r1.characterizationSummary,
      '',
      '## Characterization file (DO NOT TOUCH THIS FILE — it is the oracle)',
      `The characterization file is: ${r1.characterizationArtifact}`,
      'You MUST NOT edit, modify, rename, or delete this file.',
      'The characterization tests MUST still pass after the refactor.',
      '',
      '## Rules',
      '- Apply the refactor — restructure/rename/extract code while preserving observable behavior.',
      '- Do NOT modify the characterization test file (see above).',
      '- List every file you changed in filesChanged.',
      '',
      '## Required output',
      `Write your result as valid JSON to: ${outputFile}`,
      '',
      'The JSON MUST match this schema exactly:',
      '```json',
      '{',
      '  "transformSummary": "<one paragraph describing what you changed and why>",',
      '  "filesChanged": ["<path/to/changed/file.ts>", "..."]',
      '}',
      '```',
      '',
      'After applying the refactor AND writing the JSON output file, confirm "R2 output written."',
    ].join('\n')

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `R2 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `R2 output file read failed: ${String(err)}` }
    }

    if (!validateR2Output(raw)) {
      return { ok: false, reason: 'R2 output failed schema validation' }
    }

    return { ok: true, output: raw }
  }
}
