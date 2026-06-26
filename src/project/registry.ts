// Lane R1 — Project registry.
// Persists { projects: { [name]: { dir, stack?, lastRun? } }, active?: string }
// to a JSON file. Default path: ~/.pi/autodev/global/projects.json.
// Base directory is injectable via the constructor for tests.
// Atomic write: write to a temp file then rename.

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

export interface ProjectMeta {
  dir: string
  stack?: string
  lastRun?: string
}

export interface RegistryData {
  projects: { [name: string]: ProjectMeta }
  active?: string
}

export class ProjectRegistry {
  private readonly filePath: string
  private data: RegistryData = { projects: {} }
  private loaded = false

  constructor(baseDir?: string) {
    const base = baseDir ?? path.join(os.homedir(), '.pi', 'autodev', 'global')
    this.filePath = path.join(base, 'projects.json')
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as RegistryData
      // Validate shape — tolerate missing fields
      this.data = {
        projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
        active: typeof parsed.active === 'string' ? parsed.active : undefined,
      }
    } catch {
      // Missing or corrupt file — start empty, never throw
      this.data = { projects: {} }
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = this.filePath + '.tmp.' + process.pid
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, this.filePath)
  }

  // ── public API ────────────────────────────────────────────────────────────────

  async get(name: string): Promise<ProjectMeta | undefined> {
    await this.load()
    return this.data.projects[name]
  }

  async register(name: string, dir: string, meta?: Partial<Omit<ProjectMeta, 'dir'>>): Promise<void> {
    await this.load()
    this.data.projects[name] = {
      ...this.data.projects[name],
      dir: path.resolve(dir),
      ...meta,
    }
    await this.save()
  }

  async setActive(name: string): Promise<void> {
    await this.load()
    this.data.active = name
    await this.save()
  }

  async getActive(): Promise<string | undefined> {
    await this.load()
    return this.data.active
  }

  /**
   * Returns the name of the project whose dir matches the given dir,
   * normalizing paths (resolve + trailing-sep strip). Returns undefined if none.
   */
  async findByDir(dir: string): Promise<string | undefined> {
    await this.load()
    const normalized = path.resolve(dir)
    for (const [name, meta] of Object.entries(this.data.projects)) {
      if (path.resolve(meta.dir) === normalized) return name
    }
    return undefined
  }

  async list(): Promise<Array<{ name: string } & ProjectMeta>> {
    await this.load()
    return Object.entries(this.data.projects).map(([name, meta]) => ({ name, ...meta }))
  }
}
