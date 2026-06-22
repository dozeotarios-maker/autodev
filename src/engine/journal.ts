// M9: journal WAL — append-only write-ahead log.
// Write order: journal BEFORE action, checkpoint AFTER completed step (spec §10).

import * as fs from 'fs/promises'
import * as path from 'path'

export interface JournalEntry {
  type: 'transition' | 'task' | 'decision' | 'pre-action' | 'completion' | 'checkpoint-ref'
  phase: string
  action: string
  timestamp: string
  suspect?: boolean
}

export class Journal {
  constructor(private filePath: string) {}

  async write(entry: Omit<JournalEntry, 'timestamp'>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const full: JournalEntry = { ...entry, timestamp: new Date().toISOString() }
    await fs.appendFile(this.filePath, JSON.stringify(full) + '\n', 'utf-8')
  }

  async replay(): Promise<JournalEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEntry)
    } catch {
      return []
    }
  }
}
