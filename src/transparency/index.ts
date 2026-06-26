// M7 transparency — TransparencyImpl: concrete implementation of the Transparency port.
// Wires ActivityLog + AppendEntry + HudAdapter + MetricsRecorder.
import type { Transparency, MetricEntry } from '../ports.js'
import { ActivityLog } from './activity-log.js'
import { AppendEntry } from './append-entry.js'
import { HudAdapter, type PiHudClient } from './hud.js'
import { MetricsRecorder } from './metrics.js'

export { ActivityLog } from './activity-log.js'
export { AppendEntry } from './append-entry.js'
export { HudAdapter } from './hud.js'
export { MetricsRecorder } from './metrics.js'

export class TransparencyImpl implements Transparency {
  private readonly activityLog: ActivityLog
  private readonly appendEntryWriter: AppendEntry
  private readonly hud: HudAdapter
  private readonly metricsRecorder: MetricsRecorder

  constructor(repoRoot: string, hudClient: PiHudClient) {
    this.activityLog = new ActivityLog(repoRoot)
    this.appendEntryWriter = new AppendEntry(repoRoot)
    this.hud = new HudAdapter(hudClient)
    this.metricsRecorder = new MetricsRecorder(repoRoot)
  }

  /**
   * Re-root all file-writing sub-adapters after a project re-root.
   * The controller calls this in _resolveRepoRoot so activity.log + metrics.jsonl
   * + journal.jsonl land under the resolved dir's .autodev, not the original cwd.
   * The HUD client is a live sink (no path) and is intentionally untouched.
   */
  setRepoRoot(repoRoot: string): void {
    this.activityLog.setBaseDir(repoRoot)
    this.appendEntryWriter.setBaseDir(repoRoot)
    this.metricsRecorder.setBaseDir(repoRoot)
  }

  // Transparency.log — writes one human-readable line to .autodev/activity.log
  // Returns Promise<void> (compatible with the port's void return — callers may await or ignore)
  log(action: string): Promise<void> {
    return this.activityLog.write(action).catch(() => undefined)
  }

  // Transparency.appendEntry — appends a JSONL entry to .autodev/journal.jsonl (excludeFromLLMContext)
  appendEntry(type: string, data?: unknown): Promise<void> {
    return this.appendEntryWriter.append(type, data).catch(() => undefined)
  }

  // Transparency.setHudStatus — updates pi-hud widget (sync boundary)
  setHudStatus(phase: string, task: string, laneStatus: string, model: string): void {
    this.hud.setStatus(phase, task, laneStatus, model)
  }

  // Transparency.recordMetric — writes a MetricEntry to .autodev/metrics.jsonl
  recordMetric(metric: MetricEntry): Promise<void> {
    return this.metricsRecorder.record(metric).catch(() => undefined)
  }
}
