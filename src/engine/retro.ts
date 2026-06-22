// M9: R5 retro writer — after each run, writes generalizable lessons to the global plane.
// Target: ~/.pi/autodev/global/ (or injected dir for tests).

import * as fs from 'fs/promises'
import * as path from 'path'

export interface RetroEntry {
  runId: string
  lesson: string
  bugPattern: string
  convention: string
  timestamp?: string
}

const RETRO_FILE = 'retro.jsonl'

export class RetroWriter {
  constructor(private globalDir: string) {}

  async write(entry: RetroEntry): Promise<void> {
    await fs.mkdir(this.globalDir, { recursive: true })
    const full: RetroEntry = { ...entry, timestamp: new Date().toISOString() }
    await fs.appendFile(
      path.join(this.globalDir, RETRO_FILE),
      JSON.stringify(full) + '\n',
      'utf-8'
    )
  }

  async readAll(): Promise<RetroEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.globalDir, RETRO_FILE), 'utf-8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RetroEntry)
    } catch {
      return []
    }
  }
}
