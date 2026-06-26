// Lane R2 — Project directory resolver.
// Implements the 4-step resolution order + $HOME guardrail.

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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

/** 6-character hex hash of the given text (deterministic). */
function hexHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 6)
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
 */
function isHomeOrAncestor(dir: string, homeDir: string): boolean {
  const resolved = path.resolve(dir)
  const home = path.resolve(homeDir)
  // equal
  if (resolved === home) return true
  // dir is a parent of home: home starts with dir + sep
  if (home.startsWith(resolved + path.sep)) return true
  return false
}

// ── Resolver ──────────────────────────────────────────────────────────────────

export async function resolveProjectDir(opts: ResolveOpts): Promise<ResolveResult> {
  const { cwd, idea, registry } = opts
  const homeDir = opts.homeDir ?? os.homedir()

  // Step 1: cwd is a registered project
  const registeredName = await registry.findByDir(cwd)
  if (registeredName !== undefined) {
    const meta = await registry.get(registeredName)
    const dir = meta?.dir ?? path.resolve(cwd)
    // Guardrail: if the registered dir is homeDir or an ancestor, fall through
    if (!isHomeOrAncestor(dir, homeDir)) {
      return { dir, name: registeredName, isNew: false, isExisting: true }
    }
  }

  // Step 2: cwd is a real repo (git root OR has package.json) AND cwd !== homeDir
  const cwdResolved = path.resolve(cwd)
  if (!isHomeOrAncestor(cwdResolved, homeDir) && (isGitRepo(cwd) || hasPackageJson(cwd))) {
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
      if (!isHomeOrAncestor(dir, homeDir)) {
        return { dir, name: activeName, isNew: false, isExisting: true }
      }
    }
  }

  // Step 4: new project — slug + 6-char hash, scoped under ~/autodev/<slug>
  const slug = slugify(idea)
  const hash = hexHash(idea)
  const name = `${slug}-${hash}`
  const dir = path.join(homeDir, 'autodev', name)
  await registry.register(name, dir)
  return { dir, name, isNew: true, isExisting: false }
}
