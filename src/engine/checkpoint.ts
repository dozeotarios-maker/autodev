// M9: checkpoint — snapshot written AFTER a completed step (spec §10).
// Format: YAML-compatible JSON (spec says checkpoint.yaml; we write JSON with .yaml ext).

import * as fs from 'fs/promises'
import * as path from 'path'

export interface CheckpointData {
  phase: string
  plan: string
  taskStatuses: Record<string, string>
  inFlight: string[]
  lastGoodCommit: string
}

export class Checkpoint {
  constructor(private filePath: string) {}

  async write(data: CheckpointData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // Write as JSON; the .yaml extension is per spec naming convention.
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  async read(): Promise<CheckpointData | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      return JSON.parse(raw) as CheckpointData
    } catch {
      return null
    }
  }
}
