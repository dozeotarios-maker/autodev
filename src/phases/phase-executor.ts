// S2-M3a: PhaseExecutor base — steer-then-verify pattern for file-based phase contracts.
// Each phase executor:
//   1. Assembles a steer instruction (role directives + PhaseContext + target file path)
//   2. Calls hostAgent.steer({ expectFile }) — waits for agent_end + validates the file
//   3. Reads + schema-validates the file
//   4. Runs the gate function
//   5. Returns a typed PhaseResult

import * as fs from 'fs/promises'
import * as path from 'path'
import type { HostAgent } from '../host/host-agent.js'
import type { PhaseContext, PhaseOutput } from './phase-output.js'

export interface PhaseResult<O extends PhaseOutput = PhaseOutput> {
  ok: boolean
  output?: O
  reason?: string
}

export interface PhaseExecutorOptions<I extends PhaseContext, O extends PhaseOutput> {
  /** Phase identifier (P1..P6) */
  phase: string
  /** Path where the host must write the output JSON file */
  outputFile: string
  /** Build the steer instruction from context (may be async for memory recall) */
  buildInstruction(ctx: I): string | Promise<string>
  /** Schema-validate the parsed JSON; return false → retry */
  validate(raw: unknown): raw is O
  /** Gate: post-validation check (e.g. panelObjCount within bounds). Return null = pass, string = fail+reason */
  gate?(output: O): Promise<string | null>
  /** Optional steer timeout in ms (passed to hostAgent.steer) */
  timeoutMs?: number
}

/**
 * PhaseExecutor<I, O>: generic executor that drives one phase of the file-based contract.
 * Inject HostAgent; call execute(context) → PhaseResult<O>.
 */
export class PhaseExecutor<I extends PhaseContext, O extends PhaseOutput> {
  constructor(
    private readonly hostAgent: HostAgent,
    private readonly opts: PhaseExecutorOptions<I, O>
  ) {}

  async execute(ctx: I): Promise<PhaseResult<O>> {
    const { outputFile, buildInstruction, validate, gate } = this.opts

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputFile), { recursive: true })

    const instruction = await buildInstruction(ctx)

    // steer() already handles retry ≤2 for expectFile missing/invalid JSON
    let steerResult
    try {
      steerResult = await this.hostAgent.steer(instruction, {
        expectFile: outputFile,
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      })
    } catch (err) {
      return {
        ok: false,
        reason: `Phase ${this.opts.phase} steer failed: ${String(err)}`,
      }
    }

    // Read + schema-validate (steer already confirmed file exists + parses; re-read for type safety)
    let raw: unknown
    try {
      const content = await fs.readFile(outputFile, 'utf-8')
      raw = JSON.parse(content)
    } catch (err) {
      return {
        ok: false,
        reason: `Phase ${this.opts.phase} file read failed after steer: ${String(err)}`,
      }
    }

    if (!validate(raw)) {
      return {
        ok: false,
        reason: `Phase ${this.opts.phase} output failed schema validation`,
      }
    }

    const output = raw as O

    // Gate check
    if (gate) {
      const gateReason = await gate(output)
      if (gateReason !== null) {
        return { ok: false, reason: `Phase ${this.opts.phase} gate failed: ${gateReason}` }
      }
    }

    void steerResult // rawText/seq available for logging if needed
    return { ok: true, output }
  }
}
