// M7 transparency — activity-log tests (D1: written before implementation)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ActivityLog } from '../../src/transparency/activity-log.js'

let tmpDir: string
let logPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-activity-log-test-'))
  logPath = path.join(tmpDir, '.autodev', 'activity.log')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M7: activity.log — human-readable line per action', () => {
  it('creates the log file on first write', async () => {
    const log = new ActivityLog(tmpDir)
    await log.write('phase:P1 started')
    const exists = await fs.access(logPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('writes a human-readable line containing the action', async () => {
    const log = new ActivityLog(tmpDir)
    await log.write('tool_call:read_file path=/src/foo.ts')
    const content = await fs.readFile(logPath, 'utf8')
    expect(content).toContain('tool_call:read_file path=/src/foo.ts')
  })

  it('each line includes an ISO timestamp prefix', async () => {
    const log = new ActivityLog(tmpDir)
    await log.write('test action')
    const content = await fs.readFile(logPath, 'utf8')
    // ISO 8601: 2026-06-22T...Z
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('appends multiple actions as separate lines', async () => {
    const log = new ActivityLog(tmpDir)
    await log.write('action one')
    await log.write('action two')
    const content = await fs.readFile(logPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('action one')
    expect(lines[1]).toContain('action two')
  })

  it('creates parent directories if missing', async () => {
    const deepPath = path.join(tmpDir, 'nested', 'deep')
    const log = new ActivityLog(deepPath)
    await log.write('deep action')
    const content = await fs.readFile(path.join(deepPath, '.autodev', 'activity.log'), 'utf8')
    expect(content).toContain('deep action')
  })
})
