// M7 transparency — HUD adapter: wraps pi-hud setWidget boundary (mocked in tests)
// Real pi-hud dependency: pi-hud ^0.9.4 (not installed; boundary is injected via PiHudClient)

export interface PiHudClient {
  setWidget(widgetId: string, payload: Record<string, unknown>): void
}

export interface HudPayload {
  phase: string
  task: string
  laneStatus: string
  model: string
  cost?: number
  lastDecision?: string
}

export interface HudOptions {
  cost?: number
  lastDecision?: string
}

export class HudAdapter {
  private readonly WIDGET_ID = 'pi-autodev-hud'
  private readonly client: PiHudClient

  constructor(client: PiHudClient) {
    this.client = client
  }

  setStatus(
    phase: string,
    task: string,
    laneStatus: string,
    model: string,
    options?: HudOptions
  ): void {
    const payload: HudPayload = { phase, task, laneStatus, model }
    if (options?.cost !== undefined) payload.cost = options.cost
    if (options?.lastDecision !== undefined) payload.lastDecision = options.lastDecision
    this.client.setWidget(this.WIDGET_ID, payload as unknown as Record<string, unknown>)
  }
}
