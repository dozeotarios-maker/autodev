// M7 transparency — metrics recorder: writes G6 metrics to .autodev/metrics.jsonl
// Schema: {role, task, metric_name, value, timestamp} — matches MetricEntry from src/ports.ts
import * as fs from 'fs/promises'
import * as path from 'path'
import type { MetricEntry } from '../ports.js'

export class MetricsRecorder {
  private metricsPath: string

  constructor(repoRoot: string) {
    this.metricsPath = path.join(repoRoot, '.autodev', 'metrics.jsonl')
  }

  /** Re-root the writer after a project re-root (controller chdir). */
  setBaseDir(repoRoot: string): void {
    this.metricsPath = path.join(repoRoot, '.autodev', 'metrics.jsonl')
  }

  async record(entry: MetricEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.metricsPath), { recursive: true })
    await fs.appendFile(this.metricsPath, JSON.stringify(entry) + '\n', 'utf8')
  }

  async readAll(): Promise<MetricEntry[]> {
    let content: string
    try {
      content = await fs.readFile(this.metricsPath, 'utf8')
    } catch {
      return []
    }
    return content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as MetricEntry)
  }
}
