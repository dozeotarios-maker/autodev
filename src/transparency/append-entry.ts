// M7 transparency — append-entry: JSONL journal with excludeFromLLMContext=true
// Entries are resumable (replay) and never included in LLM context windows.
import * as fs from 'fs/promises'
import * as path from 'path'

export interface JournalEntry {
  type: string
  timestamp: string
  data?: unknown
  excludeFromLLMContext: true
}

export class AppendEntry {
  private readonly journalPath: string

  constructor(repoRoot: string) {
    this.journalPath = path.join(repoRoot, '.autodev', 'journal.jsonl')
  }

  async append(type: string, data?: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true })
    const entry: JournalEntry = {
      type,
      timestamp: new Date().toISOString(),
      data,
      excludeFromLLMContext: true,
    }
    await fs.appendFile(this.journalPath, JSON.stringify(entry) + '\n', 'utf8')
  }

  async readAll(): Promise<JournalEntry[]> {
    let content: string
    try {
      content = await fs.readFile(this.journalPath, 'utf8')
    } catch {
      return []
    }
    return content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JournalEntry)
  }
}
