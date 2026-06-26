// Re-root coverage: TransparencyImpl + its writers must follow setRepoRoot/setBaseDir.
// Before this fix the writers froze repoRoot at construction, so activity.log +
// metrics.jsonl polluted the original cwd after a project re-root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ActivityLog } from '../../src/transparency/activity-log.js'
import { MetricsRecorder } from '../../src/transparency/metrics.js'
import { AppendEntry } from '../../src/transparency/append-entry.js'
import { TransparencyImpl } from '../../src/transparency/index.js'
import type { PiHudClient } from '../../src/transparency/hud.js'

function nullHud(): PiHudClient {
  return { setWidget: () => { /* no-op */ } }
}

describe('Transparency writers follow setBaseDir', () => {
  let tmpA: string
  let tmpB: string

  beforeEach(async () => {
    tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'transp-a-'))
    tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'transp-b-'))
  })

  afterEach(async () => {
    await fs.rm(tmpA, { recursive: true, force: true })
    await fs.rm(tmpB, { recursive: true, force: true })
  })

  it('ActivityLog.setBaseDir redirects writes to the new dir', async () => {
    const log = new ActivityLog(tmpA)
    log.setBaseDir(tmpB)
    await log.write('hello after re-root')

    const inB = await fs.readFile(path.join(tmpB, '.autodev', 'activity.log'), 'utf8')
    expect(inB).toContain('hello after re-root')
    const inA = await fs.access(path.join(tmpA, '.autodev', 'activity.log')).then(() => true).catch(() => false)
    expect(inA).toBe(false)
  })

  it('MetricsRecorder.setBaseDir redirects writes to the new dir', async () => {
    const rec = new MetricsRecorder(tmpA)
    rec.setBaseDir(tmpB)
    await rec.record({ role: 'r', task: 't', metric_name: 'm', value: 1, timestamp: 'ts' })

    const inB = await fs.readFile(path.join(tmpB, '.autodev', 'metrics.jsonl'), 'utf8')
    expect(inB).toContain('"metric_name":"m"')
    const inA = await fs.access(path.join(tmpA, '.autodev', 'metrics.jsonl')).then(() => true).catch(() => false)
    expect(inA).toBe(false)
  })

  it('AppendEntry.setBaseDir redirects writes to the new dir', async () => {
    const ap = new AppendEntry(tmpA)
    ap.setBaseDir(tmpB)
    await ap.append('decision', { x: 1 })

    const inB = await fs.readFile(path.join(tmpB, '.autodev', 'journal.jsonl'), 'utf8')
    expect(inB).toContain('"type":"decision"')
    const inA = await fs.access(path.join(tmpB, '.autodev', 'journal.jsonl')).then(() => true).catch(() => false)
    expect(inA).toBe(true)
  })

  it('TransparencyImpl.setRepoRoot cascades to activity + metrics writers', async () => {
    const t = new TransparencyImpl(tmpA, nullHud())
    t.setRepoRoot(tmpB)
    await t.log('line after re-root')
    await t.recordMetric({ role: 'r', task: 't', metric_name: 'mm', value: 2, timestamp: 'ts' })

    const logB = await fs.readFile(path.join(tmpB, '.autodev', 'activity.log'), 'utf8')
    expect(logB).toContain('line after re-root')
    const metB = await fs.readFile(path.join(tmpB, '.autodev', 'metrics.jsonl'), 'utf8')
    expect(metB).toContain('"metric_name":"mm"')

    const logA = await fs.access(path.join(tmpA, '.autodev', 'activity.log')).then(() => true).catch(() => false)
    expect(logA).toBe(false)
  })
})
