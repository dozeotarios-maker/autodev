// M7 transparency — append-entry tests (D1: written before implementation)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AppendEntry } from '../../src/transparency/append-entry.js'

let tmpDir: string
let journalPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-append-entry-test-'))
  journalPath = path.join(tmpDir, '.autodev', 'journal.jsonl')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M7: appendEntry — resumable, excluded from LLM context', () => {
  it('creates journal file on first append', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('phase_start', { phase: 'P1' })
    const exists = await fs.access(journalPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('each entry is valid JSON on its own line', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('tool_call', { name: 'read_file', path: '/src/foo.ts' })
    const content = await fs.readFile(journalPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed).toBeDefined()
    expect(parsed.type).toBe('tool_call')
  })

  it('entry includes type, timestamp, and data fields', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('phase_transition', { from: 'P1', to: 'P2' })
    const content = await fs.readFile(journalPath, 'utf8')
    const entry = JSON.parse(content.trim())
    expect(entry.type).toBe('phase_transition')
    expect(entry.timestamp).toBeDefined()
    expect(entry.data).toEqual({ from: 'P1', to: 'P2' })
  })

  it('entry carries excludeFromLLMContext marker set to true', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('action', { detail: 'some detail' })
    const content = await fs.readFile(journalPath, 'utf8')
    const entry = JSON.parse(content.trim())
    expect(entry.excludeFromLLMContext).toBe(true)
  })

  it('appends multiple entries as separate JSONL lines (resumable)', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('start', { seq: 1 })
    await ae.append('middle', { seq: 2 })
    await ae.append('end', { seq: 3 })
    const content = await fs.readFile(journalPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(3)
    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0].data.seq).toBe(1)
    expect(entries[1].data.seq).toBe(2)
    expect(entries[2].data.seq).toBe(3)
  })

  it('readAll returns all entries in order (resumable replay)', async () => {
    const ae = new AppendEntry(tmpDir)
    await ae.append('a', { v: 1 })
    await ae.append('b', { v: 2 })
    const entries = await ae.readAll()
    expect(entries.length).toBe(2)
    expect(entries[0].type).toBe('a')
    expect(entries[1].type).toBe('b')
  })

  it('readAll returns empty array when no journal exists', async () => {
    const ae = new AppendEntry(tmpDir)
    const entries = await ae.readAll()
    expect(entries).toEqual([])
  })
})
