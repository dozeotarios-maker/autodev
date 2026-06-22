// M7 transparency — TransparencyImpl (satisfies the Transparency port from src/ports.ts)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { TransparencyImpl } from '../../src/transparency/index.js'
import type { Transparency } from '../../src/ports.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-transparency-impl-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M7: TransparencyImpl — satisfies Transparency port', () => {
  it('implements the Transparency interface (type check)', () => {
    const mockSetWidget = vi.fn()
    const impl: Transparency = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    expect(impl).toBeDefined()
  })

  it('log() writes a line to activity.log', async () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    await impl.log('phase:P1 action:start')
    const logPath = path.join(tmpDir, '.autodev', 'activity.log')
    const content = await fs.readFile(logPath, 'utf8')
    expect(content).toContain('phase:P1 action:start')
  })

  it('appendEntry() writes a JSONL entry with excludeFromLLMContext=true', async () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    await impl.appendEntry('phase_transition', { from: 'P1', to: 'P2' })
    const journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
    const content = await fs.readFile(journalPath, 'utf8')
    const entry = JSON.parse(content.trim())
    expect(entry.excludeFromLLMContext).toBe(true)
    expect(entry.type).toBe('phase_transition')
  })

  it('setHudStatus() calls setWidget with all required fields', () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    impl.setHudStatus('P2', 'plan-task', 'running', 'claude-opus-4-8')
    expect(mockSetWidget).toHaveBeenCalledOnce()
    const [id, payload] = mockSetWidget.mock.calls[0]
    expect(id).toBe('pi-autodev-hud')
    expect(payload.phase).toBe('P2')
    expect(payload.task).toBe('plan-task')
    expect(payload.laneStatus).toBe('running')
    expect(payload.model).toBe('claude-opus-4-8')
  })

  it('recordMetric() writes a MetricEntry to metrics.jsonl', async () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    const ts = new Date().toISOString()
    await impl.recordMetric({ role: 'executor', task: 'impl', metric_name: 'cost_usd', value: 0.03, timestamp: ts })
    const metricsPath = path.join(tmpDir, '.autodev', 'metrics.jsonl')
    const content = await fs.readFile(metricsPath, 'utf8')
    const entry = JSON.parse(content.trim())
    expect(entry.role).toBe('executor')
    expect(entry.metric_name).toBe('cost_usd')
    expect(entry.value).toBe(0.03)
  })

  it('log() is sync-safe (void return, no await needed by caller)', () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    // Should not throw even without await
    expect(() => impl.log('sync action')).not.toThrow()
  })

  it('appendEntry() is sync-safe (void return, no await needed by caller)', () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    expect(() => impl.appendEntry('event', { x: 1 })).not.toThrow()
  })

  it('setHudStatus() is sync (no async boundary)', () => {
    const mockSetWidget = vi.fn()
    const impl = new TransparencyImpl(tmpDir, { setWidget: mockSetWidget })
    // synchronous — no promise returned
    const result = impl.setHudStatus('P1', 't', 'idle', 'model')
    expect(result).toBeUndefined()
  })
})
