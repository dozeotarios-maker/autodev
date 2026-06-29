// Lane R2 — Project directory resolver.
// Implements the 4-step resolution order + $HOME guardrail.

import * as crypto from 'crypto'
import * as fs from 'fs'
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
    return fs.realpathSync(p)
  } catch {
    const abs = path.resolve(p)
    let cur = abs
    const tail: string[] = []
    while (true) {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tail.unshift(path.basename(cur))
      try {
        const realParent = fs.realpathSync(parent)
        return path.join(realParent, ...tail)
      } catch {
        cur = parent
      }
    }
  }
}

import { ProjectRegistry } from './registry.js'

export interface ResolveResult {
  dir: string
  name: string
  isNew: boolean
  isExisting: boolean
}

export interface ResolveOpts {
  cwd: string
  idea: string
  registry: ProjectRegistry
  homeDir?: string
  /** Autodev's own source root — never used as a build target (prevents building into self). */
  selfRoot?: string
  /** Base dir for NEW projects. Default: AUTODEV_BUILD_ROOT env, else <os.tmpdir()>/autodev. */
  buildRoot?: string
  /**
   * TESTING ONLY: force a brand-new fresh (timestamped) folder every run, ignoring
   * cwd/registry/active. Defaults from the AUTODEV_TEMP_BUILDS env. Real runs leave this
   * false and resolve normally — building wherever pi is opened.
   */
  forceTemporal?: boolean
  /** Injectable clock (ms) for the temporal timestamp. Default: Date.now(). */
  now?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `dir` contains a `.git` directory entry. */
export function isGitRepo(dir: string): boolean {
  try {
    const stat = fs.statSync(path.join(dir, '.git'))
    return stat.isDirectory() || stat.isFile() // .git can be a file in worktrees
  } catch {
    return false
  }
}

/** Returns true if `dir` contains a `package.json` file. */
export function hasPackageJson(dir: string): boolean {
  try {
    fs.accessSync(path.join(dir, 'package.json'), fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Slugify: lowercase, replace non-alnum runs with '-', strip leading/trailing
 * '-', cap at 40 chars.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** 12-character hex hash of the given text (deterministic). Fix 6: wider hash. */
function hexHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/** Read `package.json` name field from a directory, or undefined on failure. */
function readPackageName(dir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { name?: string }
    return typeof pkg.name === 'string' && pkg.name ? pkg.name : undefined
  } catch {
    return undefined
  }
}

// ── Guardrail ──────────────────────────────────────────────────────────────────

/**
 * Returns true if `dir` equals homeDir or is an ancestor of homeDir.
 * These dirs must never be returned as the resolved project dir.
 * Fix 4: uses realpathSafe so a symlink pointing to $HOME is caught.
 */
function isHomeOrAncestor(dir: string, homeDir: string): boolean {
  const resolved = realpathSafe(dir)
  const home = realpathSafe(homeDir)
  // equal
  if (resolved === home) return true
  // dir is a parent of home: home starts with dir + sep
  if (home.startsWith(resolved + path.sep)) return true
  return false
}

/** True if `dir` is `root` or lives inside it. */
function isUnderOrEqual(dir: string, root: string): boolean {
  const d = realpathSafe(dir)
  const r = realpathSafe(root)
  return d === r || d.startsWith(r + path.sep)
}

/**
 * A dir must never be returned as the build target if it is $HOME (or an ancestor) OR
 * autodev's own source tree — building into either is destructive/surprising.
 */
function isForbidden(dir: string, homeDir: string, selfRoot?: string): boolean {
  if (isHomeOrAncestor(dir, homeDir)) return true
  if (selfRoot && isUnderOrEqual(dir, selfRoot)) return true
  return false
}

/** TESTING: a brand-new timestamped folder under the build root, fresh on every call. */
async function freshTemporal(idea: string, registry: ProjectRegistry, opts: ResolveOpts): Promise<ResolveResult> {
  const rawSlug = slugify(idea)
  const slug = rawSlug.length > 0 ? rawSlug : 'project'
  const base = opts.buildRoot ?? process.env['AUTODEV_BUILD_ROOT'] ?? path.join(os.tmpdir(), 'autodev')
  const ms = typeof opts.now === 'number' ? opts.now : Date.now()
  const stamp = new Date(ms).toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const name = `${slug}-${stamp}`
  const dir = path.join(base, name)
  await registry.register(name, dir)
  return { dir, name, isNew: true, isExisting: false }
}

// ── Resolver ──────────────────────────────────────────────────────────────────

export async function resolveProjectDir(opts: ResolveOpts): Promise<ResolveResult> {
  const { cwd, idea, registry } = opts
  const homeDir = opts.homeDir ?? os.homedir()

  // TESTING: fresh temporal folder every run (opt-in via AUTODEV_TEMP_BUILDS). Real runs skip
  // this entirely and resolve normally below — building wherever pi is opened.
  const forceTemporal = opts.forceTemporal ?? /^(1|true|yes|on)$/i.test(process.env['AUTODEV_TEMP_BUILDS'] ?? '')
  if (forceTemporal) return freshTemporal(idea, registry, opts)

  // Step 1: cwd is a registered project
  const registeredName = await registry.findByDir(cwd)
  if (registeredName !== undefined) {
    const meta = await registry.get(registeredName)
    const dir = meta?.dir ?? path.resolve(cwd)
    // Guardrail: if the registered dir is homeDir or an ancestor, fall through
    if (!isForbidden(dir, homeDir, opts.selfRoot)) {
      return { dir, name: registeredName, isNew: false, isExisting: true }
    }
  }

  // Step 2: cwd is a real repo (git root OR has package.json) AND cwd !== homeDir
  const cwdResolved = path.resolve(cwd)
  if (!isForbidden(cwdResolved, homeDir, opts.selfRoot) && (isGitRepo(cwd) || hasPackageJson(cwd))) {
    const name = readPackageName(cwd) ?? path.basename(cwdResolved)
    await registry.register(name, cwdResolved)
    return { dir: cwdResolved, name, isNew: false, isExisting: true }
  }

  // Step 3: an active project is set
  const activeName = await registry.getActive()
  if (activeName !== undefined) {
    const meta = await registry.get(activeName)
    if (meta !== undefined) {
      const dir = meta.dir
      // Guardrail: if the active dir IS homeDir or ancestor, fall through to step 4
      if (!isForbidden(dir, homeDir, opts.selfRoot)) {
        return { dir, name: activeName, isNew: false, isExisting: true }
      }
    }
  }

  // Step 4: new project — slug + 12-char hash, scoped under a TEMPORAL off-root base
  // (default <os.tmpdir()>/autodev, overridable via AUTODEV_BUILD_ROOT) so autodev never
  // builds under $HOME/root or into its own repo. Fix 6: fall back to 'project' when the
  // slug is empty (all-symbol idea) to avoid leading-hyphen dir names like `-abc`.
  const rawSlug = slugify(idea)
  const slug = rawSlug.length > 0 ? rawSlug : 'project'
  const hash = hexHash(idea)
  const name = `${slug}-${hash}`
  const base = opts.buildRoot ?? process.env['AUTODEV_BUILD_ROOT'] ?? path.join(os.tmpdir(), 'autodev')
  const dir = path.join(base, name)
  await registry.register(name, dir)
  return { dir, name, isNew: true, isExisting: false }
}
