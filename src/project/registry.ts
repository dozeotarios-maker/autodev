// Lane R1 — Project registry.
// Persists { projects: { [name]: { dir, stack?, lastRun? } }, active?: string }
// to a JSON file. Default path: ~/.pi/autodev/global/projects.json.
// Base directory is injectable via the constructor for tests.
// Atomic write: write to a temp file then rename.

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Resolve a path to its real (symlink-dereferenced) target.
 *
 * Fix 4 (Item 4): when the leaf doesn't exist (ENOENT), walk UP to the nearest
 * existing ancestor, realpath THAT (following symlinks), then re-join the missing
 * tail — so a symlinked parent dir with a missing leaf resolves through the symlink
 * instead of falling back to a non-dereferenced path.resolve.
 */
function realpathSafe(p: string): string {
  try {
    return fsSync.realpathSync(p)
  } catch {
    const abs = path.resolve(p)
    let cur = abs
    const tail: string[] = []
    while (true) {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tail.unshift(path.basename(cur))
      try {
        const realParent = fsSync.realpathSync(parent)
        return path.join(realParent, ...tail)
      } catch {
        cur = parent
      }
    }
  }
}

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
  /** Fix 5: memoize in-flight load promise so concurrent first-loads don't read empty. */
  private loadPromise: Promise<void> | undefined = undefined
  /** Fix 5: serialize saves so concurrent register() calls don't interleave writes. */
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(baseDir?: string) {
    const base = baseDir ?? path.join(os.homedir(), '.pi', 'autodev', 'global')
    this.filePath = path.join(base, 'projects.json')
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    // Fix 5: memoize in-flight load promise so concurrent first-loads share one read.
    // Check loadPromise BEFORE loaded so concurrent callers see the pending promise
    // even before _doLoad sets loaded=true.
    if (this.loadPromise) return this.loadPromise
    if (this.loaded) return
    this.loadPromise = this._doLoad()
    return this.loadPromise
  }

  private async _doLoad(): Promise<void> {
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
    this.loaded = true
  }

  private save(): Promise<void> {
    // Fix 5: chain onto saveQueue to serialize concurrent saves within this instance.
    // Each save reads the latest this.data (captured in closure after mutations are applied).
    // Item 6: swallow the PRIOR save's rejection before chaining so one failed _doSave()
    // does not poison the queue — every subsequent save still gets its own _doSave()
    // attempt (and surfaces its own success/failure to its own caller).
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this._doSave())
    return this.saveQueue
  }

  private async _doSave(): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    // Fix 5: re-read on-disk file and merge before writing so a concurrent
    // register() from another instance doesn't get clobbered.
    let onDisk: RegistryData = { projects: {} }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as RegistryData
      onDisk = {
        projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
        active: typeof parsed.active === 'string' ? parsed.active : undefined,
      }
    } catch {
      // Missing or corrupt — start from empty (our in-memory state wins)
    }
    // Merge: on-disk projects first, then our in-memory projects override.
    // active: our in-memory value takes precedence (we just setActive'd it).
    const merged: RegistryData = {
      projects: { ...onDisk.projects, ...this.data.projects },
      active: this.data.active ?? onDisk.active,
    }
    // Use random suffix so concurrent saves from the same process don't collide on the tmp path.
    const tmp = this.filePath + '.tmp.' + crypto.randomBytes(6).toString('hex')
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, this.filePath)
    // Sync in-memory to merged state so subsequent reads are consistent.
    this.data = merged
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
   * Fix 4: uses realpathSafe so symlinked dirs don't shadow-register.
   */
  async findByDir(dir: string): Promise<string | undefined> {
    await this.load()
    const normalized = realpathSafe(dir)
    for (const [name, meta] of Object.entries(this.data.projects)) {
      if (realpathSafe(meta.dir) === normalized) return name
    }
    return undefined
  }

  async list(): Promise<Array<{ name: string } & ProjectMeta>> {
    await this.load()
    return Object.entries(this.data.projects).map(([name, meta]) => ({ name, ...meta }))
  }
}
