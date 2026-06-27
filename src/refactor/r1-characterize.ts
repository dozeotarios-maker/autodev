// Stage D R1: Characterize step — steers host to pin CURRENT behavior via characterization tests.
// The host writes an R1 output JSON. The controller gate (in _runRefactorTrack) then
// verifies the characterization runs consistently GREEN via BoundedExec.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { validateR1Output } from './refactor-output.js'
import type { R1Output } from './refactor-output.js'

export interface R1Result {
  ok: boolean
  output?: R1Output
  reason?: string
}

export class R1Characterize {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(refactorRequest: string, repoRoot: string): Promise<R1Result> {
    await fs.mkdir(this.outputDir, { recursive: true })
    const outputFile = path.join(this.outputDir, 'r1-characterize.json')

    const instruction = [
      '## Role: Refactor Characterize Agent (R1)',
      '',
      'You are the R1 CHARACTERIZE step of the pi-autodev refactor track.',
      'Your ONLY job: ensure the CURRENT behavior of the target code is pinned by tests BEFORE any refactoring.',
      '',
      '## Refactor request',
      refactorRequest,
      '',
      '## Rules',
      '- If existing tests already cover the observable behavior of the target code, name them.',
      '- If existing coverage is thin or absent, write NEW characterization tests (vitest) that:',
      '  - PASS on the CURRENT (pre-refactor) code.',
      '  - Pin the observable behavior (inputs → outputs, side effects, error cases).',
      '  - Are placed at a fresh path (e.g. tests/refactor/char-<short-name>.test.ts).',
      '- Do NOT refactor any production code yet — only write characterization tests.',
      '- The characterizationCommand MUST use `npx vitest run <file>` as the command.',
      '- Set coversExisting=true if you are using existing tests; false if you wrote a new file.',
      '',
      '## Required output',
      `Write your result as valid JSON to: ${outputFile}`,
      '',
      'The JSON MUST match this schema exactly:',
      '```json',
      '{',
      '  "characterizationSummary": "<one paragraph describing what behavior is being characterized>",',
      '  "characterizationCommand": "npx vitest run <path-to-characterization-file>",',
      '  "characterizationArtifact": "<path-to-the-characterization-file>",',
      '  "coversExisting": false',
      '}',
      '```',
      '',
      'After writing the characterization test file AND the JSON output file, confirm "R1 output written."',
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
      return { ok: false, reason: `R1 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `R1 output file read failed: ${String(err)}` }
    }

    if (!validateR1Output(raw)) {
      return { ok: false, reason: 'R1 output failed schema validation' }
    }

    return { ok: true, output: raw }
  }
}
