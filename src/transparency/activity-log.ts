// M7 transparency — activity-log: writes one human-readable line per action to .autodev/activity.log
import * as fs from 'fs/promises'
import * as path from 'path'

export class ActivityLog {
  private readonly logPath: string

  constructor(repoRoot: string) {
    this.logPath = path.join(repoRoot, '.autodev', 'activity.log')
  }

  async write(action: string): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true })
    const timestamp = new Date().toISOString()
    const line = `${timestamp} ${action}\n`
    await fs.appendFile(this.logPath, line, 'utf8')
  }
}
