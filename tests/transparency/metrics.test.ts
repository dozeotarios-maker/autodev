// M7 transparency — metrics tests (D1: written before implementation)
// G6: cost-attribution per role/task, solve-rate, time-to-merge, CFR
// Schema: {role, task, metric_name, value, timestamp}
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { MetricsRecorder } from '../../src/transparency/metrics.js'
import type { MetricEntry } from '../../src/ports.js'

let tmpDir: string
let metricsPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-metrics-test-'))
  metricsPath = path.join(tmpDir, '.autodev', 'metrics.jsonl')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M7: metrics.jsonl — G6 schema + all 4 metric types', () => {
  it('creates metrics.jsonl on first record', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'planner', task: 'plan-1', metric_name: 'cost_usd', value: 0.02, timestamp: new Date().toISOString() })
    const exists = await fs.access(metricsPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('each line is valid JSON matching the MetricEntry schema', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    const entry: MetricEntry = {
      role: 'executor',
      task: 'implement-login',
      metric_name: 'cost_usd',
      value: 0.05,
      timestamp: '2026-06-22T12:00:00.000Z',
    }
    await recorder.record(entry)
    const content = await fs.readFile(metricsPath, 'utf8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.role).toBe('executor')
    expect(parsed.task).toBe('implement-login')
    expect(parsed.metric_name).toBe('cost_usd')
    expect(parsed.value).toBe(0.05)
    expect(parsed.timestamp).toBe('2026-06-22T12:00:00.000Z')
  })

  it('appends multiple entries (one per line)', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'r', task: 't', metric_name: 'cost_usd', value: 1, timestamp: new Date().toISOString() })
    await recorder.record({ role: 'r', task: 't', metric_name: 'solve_rate', value: 0.9, timestamp: new Date().toISOString() })
    const content = await fs.readFile(metricsPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
  })

  it('G6 — cost_attribution (cost_usd) metric recorded correctly', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'architect', task: 'design-auth', metric_name: 'cost_usd', value: 0.12, timestamp: new Date().toISOString() })
    const entries = await recorder.readAll()
    const found = entries.find((e) => e.metric_name === 'cost_usd')
    expect(found).toBeDefined()
    expect(found!.role).toBe('architect')
    expect(found!.task).toBe('design-auth')
    expect(found!.value).toBe(0.12)
  })

  it('G6 — solve_rate metric recorded correctly', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'executor', task: 'task-42', metric_name: 'solve_rate', value: 0.85, timestamp: new Date().toISOString() })
    const entries = await recorder.readAll()
    const found = entries.find((e) => e.metric_name === 'solve_rate')
    expect(found).toBeDefined()
    expect(found!.value).toBe(0.85)
  })

  it('G6 — time_to_merge metric recorded correctly', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'executor', task: 'feature-x', metric_name: 'time_to_merge', value: 3600, timestamp: new Date().toISOString() })
    const entries = await recorder.readAll()
    const found = entries.find((e) => e.metric_name === 'time_to_merge')
    expect(found).toBeDefined()
    expect(found!.value).toBe(3600)
  })

  it('G6 — cfr (change failure rate) metric recorded correctly', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    await recorder.record({ role: 'executor', task: 'deploy-v2', metric_name: 'cfr', value: 0.1, timestamp: new Date().toISOString() })
    const entries = await recorder.readAll()
    const found = entries.find((e) => e.metric_name === 'cfr')
    expect(found).toBeDefined()
    expect(found!.value).toBe(0.1)
  })

  it('G6 — after a mock run all 4 metric types are present', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    const ts = new Date().toISOString()
    // Simulate a full mock run that emits all 4 G6 metric types
    await recorder.record({ role: 'planner', task: 'plan', metric_name: 'cost_usd', value: 0.02, timestamp: ts })
    await recorder.record({ role: 'executor', task: 'impl', metric_name: 'solve_rate', value: 1.0, timestamp: ts })
    await recorder.record({ role: 'integrator', task: 'merge', metric_name: 'time_to_merge', value: 1800, timestamp: ts })
    await recorder.record({ role: 'executor', task: 'deploy', metric_name: 'cfr', value: 0.0, timestamp: ts })

    const entries = await recorder.readAll()
    const names = entries.map((e) => e.metric_name)
    expect(names).toContain('cost_usd')
    expect(names).toContain('solve_rate')
    expect(names).toContain('time_to_merge')
    expect(names).toContain('cfr')
  })

  it('readAll returns empty array when no metrics file exists', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    const entries = await recorder.readAll()
    expect(entries).toEqual([])
  })

  it('timestamp is a valid ISO 8601 string', async () => {
    const recorder = new MetricsRecorder(tmpDir)
    const ts = '2026-06-22T10:30:00.000Z'
    await recorder.record({ role: 'r', task: 't', metric_name: 'cost_usd', value: 0, timestamp: ts })
    const entries = await recorder.readAll()
    expect(new Date(entries[0].timestamp).toISOString()).toBe(ts)
  })
})
