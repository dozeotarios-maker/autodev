// C-1 D2: Root-cause step — steers host to produce ≥2 competing hypotheses.
// Uses findCallers data when available; degrades gracefully when absent.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import { validateD2Output } from './debug-output.js'
import type { D2Output } from './debug-output.js'
import type { D1Output } from './debug-output.js'

export interface D2Result {
  ok: boolean
  output?: D2Output
  reason?: string
}

export class D2RootCause {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly outputDir: string,
    private readonly timeoutMs?: number
  ) {}

  async execute(
    bugReport: string,
    d1: D1Output,
    reproOutput: string,
    callerData?: Array<{ file: string; symbol?: string }>
  ): Promise<D2Result> {
    await fs.mkdir(this.outputDir, { recursive: true })
    const outputFile = path.join(this.outputDir, 'd2-root-cause.json')

    const callersSection = callerData && callerData.length > 0
      ? [
          '',
          '## Call-site data (from codebase index)',
          'The following call-sites were found for symbols related to the failure:',
          ...callerData.slice(0, 20).map(c => `- ${c.file}${c.symbol ? ` → ${c.symbol}` : ''}`),
          '',
          'Use this to inform which code paths could cause the failure.',
        ].join('\n')
      : ''

    const instruction = [
      '## Role: Debug Root-Cause Agent (D2)',
      '',
      'You are the D2 ROOT-CAUSE step of the pi-autodev debug track.',
      'Your job: identify the root cause of the bug by producing ≥2 COMPETING hypotheses.',
      '',
      '## Bug report',
      bugReport,
      '',
      '## Repro summary',
      d1.reproSummary,
      '',
      '## Repro output (what failed)',
      reproOutput.slice(0, 3000),
      callersSection,
      '',
      '## Rules',
      '- You MUST produce at least 2 competing hypotheses (different explanations for the bug).',
      '- Each hypothesis needs: claim (one sentence), evidenceFor, evidenceAgainst.',
      '- Then select the most likely hypothesis as rootCause + rootCauseLocation.',
      '- rootCauseLocation: file path + line number or symbol (e.g. "src/auth/validate.ts:45").',
      '',
      '## Required output',
      `Write your result as valid JSON to: ${outputFile}`,
      '',
      'The JSON MUST match this schema exactly:',
      '```json',
      '{',
      '  "hypotheses": [',
      '    {',
      '      "claim": "<one sentence hypothesis>",',
      '      "evidenceFor": "<evidence supporting this>",',
      '      "evidenceAgainst": "<evidence against this>"',
      '    },',
      '    { "claim": "...", "evidenceFor": "...", "evidenceAgainst": "..." }',
      '  ],',
      '  "rootCause": "<selected root cause explanation>",',
      '  "rootCauseLocation": "<file:line or symbol>"',
      '}',
      '```',
      '',
      'After writing the file, confirm "D2 output written."',
    ].join('\n')

    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      })
    } catch (err) {
      return { ok: false, reason: `D2 steer failed: ${String(err)}` }
    }
    void steerResult

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(outputFile, 'utf-8'))
    } catch (err) {
      return { ok: false, reason: `D2 output file read failed: ${String(err)}` }
    }

    if (!validateD2Output(raw)) {
      return { ok: false, reason: 'D2 output failed schema validation (need ≥2 hypotheses with claim/evidenceFor/evidenceAgainst)' }
    }

    return { ok: true, output: raw }
  }
}
