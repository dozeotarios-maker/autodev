// S2-M4: H2 done-judge + H9 still-right judge + 10-persona panel.
// All backed by the Judge port (SubagentJudge in production; stub in tests).
// Panel runs personas as parallel SubagentDriver.invoke() calls.

import type { Judge } from '../ports.js'
import type { SubagentDriver } from '../host/subagent-driver.js'

// H2: separate "done?" judge — cheap model, not self-judge.
export class DoneJudge {
  constructor(private judge: Judge) {}

  async check(goal: string, evidence: string): Promise<boolean> {
    return this.judge.isDone(goal, evidence)
  }
}

export interface StillRightResult {
  aligned: boolean
  reason?: string
  needsBackedge: boolean
}

// H9: still-right judge — re-anchors trajectory to frozen spec; signals P4→P3 backedge.
export class StillRightJudge {
  constructor(private judge: Judge) {}

  async check(spec: string, currentDiff: string): Promise<StillRightResult> {
    const { aligned, reason } = await this.judge.isStillRight(spec, currentDiff)
    return {
      aligned,
      reason,
      needsBackedge: !aligned,
    }
  }
}

// ── 10-persona panel ─────────────────────────────────────────────────────────

export interface PersonaObjection {
  persona: string
  objection: string
}

export interface PanelResult {
  objections: PersonaObjection[]
  hasObjections: boolean
}

const DEFAULT_PERSONAS = [
  'security-engineer',
  'performance-engineer',
  'ux-designer',
  'backend-architect',
  'frontend-engineer',
  'qa-engineer',
  'devops-engineer',
  'product-manager',
  'data-engineer',
  'accessibility-engineer',
]

/**
 * PersonaPanel — runs N personas as parallel SubagentDriver.invoke() tasks.
 * Each persona reviews the plan/diff and optionally raises an objection.
 * Returns aggregated objections.
 */
export class PersonaPanel {
  private readonly personas: string[]

  constructor(
    private readonly driver: SubagentDriver,
    personas: string[] = DEFAULT_PERSONAS
  ) {
    this.personas = personas
  }

  async review(plan: string): Promise<PanelResult> {
    const tasks = this.personas.map((persona) => ({
      agent: persona,
      task:
        `You are a ${persona}. Review this plan from your perspective.\n\n` +
        `Plan:\n${plan}\n\n` +
        `If you have a specific objection, reply with JSON: ` +
        `{"objection": "<one-line objection>"}.\n` +
        `If you have no objection, reply with JSON: {"objection": null}.\n` +
        `No other text.`,
    }))

    const results = await this.driver.invoke(tasks, { concurrency: this.personas.length })

    const objections: PersonaObjection[] = []

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const persona = this.personas[i]
      const output = result?.output ?? ''

      try {
        const parsed = JSON.parse(output.trim()) as { objection?: string | null }
        if (parsed.objection) {
          objections.push({ persona, objection: parsed.objection })
        }
      } catch {
        // Non-parseable output — skip this persona's result
      }
    }

    return {
      objections,
      hasObjections: objections.length > 0,
    }
  }
}
