// M7 transparency — HUD tests (D1: written before implementation)
// pi-hud boundary is mocked — we test the adapter, not the real widget library.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HudAdapter } from '../../src/transparency/hud.js'

describe('M7: HUD — pi-hud setWidget boundary (mocked)', () => {
  // vi.fn() typed as the PiHudClient.setWidget signature
  let mockSetWidget: ReturnType<typeof vi.fn<(widgetId: string, payload: Record<string, unknown>) => void>>
  let hud: HudAdapter

  beforeEach(() => {
    mockSetWidget = vi.fn<(widgetId: string, payload: Record<string, unknown>) => void>()
    hud = new HudAdapter({ setWidget: mockSetWidget })
  })

  it('calls setWidget with the correct widget ID', () => {
    hud.setStatus('P1', 'task-1', 'running', 'claude-opus-4-8')
    expect(mockSetWidget).toHaveBeenCalledOnce()
    const [widgetId] = mockSetWidget.mock.calls[0]
    expect(widgetId).toBe('pi-autodev-hud')
  })

  it('includes phase in the widget payload', () => {
    hud.setStatus('P3', 'implement-feature', 'running', 'claude-sonnet-4-6')
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.phase).toBe('P3')
  })

  it('includes active task in the widget payload', () => {
    hud.setStatus('P2', 'plan-task', 'idle', 'claude-opus-4-8')
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.task).toBe('plan-task')
  })

  it('includes lane status in the widget payload', () => {
    hud.setStatus('P4', 'verify', 'done', 'claude-sonnet-4-6')
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.laneStatus).toBe('done')
  })

  it('includes model in the widget payload', () => {
    hud.setStatus('P1', 'start', 'running', 'claude-haiku-3-5')
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.model).toBe('claude-haiku-3-5')
  })

  it('includes cost in the widget payload when provided', () => {
    hud.setStatus('P2', 'task', 'running', 'claude-opus-4-8', { cost: 0.05 })
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.cost).toBe(0.05)
  })

  it('includes last-decision in the widget payload when provided', () => {
    hud.setStatus('P3', 'task', 'running', 'claude-opus-4-8', { lastDecision: 'approved plan' })
    const [, payload] = mockSetWidget.mock.calls[0]
    expect(payload.lastDecision).toBe('approved plan')
  })

  it('updates HUD on each call (idempotent — last write wins)', () => {
    hud.setStatus('P1', 'a', 'idle', 'model-a')
    hud.setStatus('P2', 'b', 'running', 'model-b')
    expect(mockSetWidget).toHaveBeenCalledTimes(2)
    const [, second] = mockSetWidget.mock.calls[1]
    expect(second.phase).toBe('P2')
  })
})
