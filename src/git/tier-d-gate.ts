/**
 * TierDGate — H10 decision-brief gate for Tier-D irreversible actions.
 *
 * Surfaces a structured brief (change / why / risk / rollback) and blocks
 * until an async approval provider resolves.  Times out → denied.
 *
 * Usage:
 *   const gate = new TierDGate({ timeoutMs: 30_000 })
 *   gate.setApprovalProvider(async (brief) => { /* send Telegram, await thumbs-up *\/ return true })
 *   gate.onBrief((brief) => { void brief })
 *   const ok = await gate.request('push to prod', { change, why, risk, rollback })
 */

export interface TierDBrief {
  change: string
  why: string
  risk: string
  rollback: string
}

export type ApprovalProvider = (brief: TierDBrief) => Promise<boolean>
export type BriefListener = (brief: TierDBrief) => void

export interface TierDGateOptions {
  timeoutMs?: number
}

export class TierDGate {
  private provider: ApprovalProvider | null = null
  private listeners: BriefListener[] = []
  private readonly timeoutMs: number

  constructor(options: TierDGateOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  setApprovalProvider(provider: ApprovalProvider): void {
    this.provider = provider
  }

  onBrief(listener: BriefListener): void {
    this.listeners.push(listener)
  }

  async request(action: string, brief: TierDBrief): Promise<boolean> {
    if (!this.provider) {
      throw new Error(
        `TierDGate: no approval provider set — cannot gate action "${action}". ` +
          'Call setApprovalProvider() before request().'
      )
    }

    // Emit the H10 brief to all listeners
    for (const listener of this.listeners) {
      listener(brief)
    }

    // Race the approval against the timeout
    const timeoutPromise = new Promise<boolean>((resolve) => {
      const id = setTimeout(() => resolve(false), this.timeoutMs)
      // Allow Node.js to exit if only this timer remains
      if (typeof id === 'object' && 'unref' in id) (id as NodeJS.Timeout).unref()
    })

    try {
      return await Promise.race([this.provider(brief), timeoutPromise])
    } catch {
      return false
    }
  }

  // Satisfies GitOps port shape
  async tierDGate(
    action: string,
    brief: TierDBrief
  ): Promise<boolean> {
    return this.request(action, brief)
  }
}
