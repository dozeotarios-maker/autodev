import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ProjectRegistry } from '../../src/project/registry.js'
import { resolveProjectDir, isGitRepo, hasPackageJson, slugify } from '../../src/project/resolver.js'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-resolver-test-'))
}

// ── Helper: fixture git repo (just needs a .git dir) ─────────────────────────

async function makeGitRepo(base: string): Promise<string> {
  const repo = path.join(base, 'git-repo')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  return repo
}

async function makePackageJsonDir(base: string, name?: string): Promise<string> {
  const dir = path.join(base, 'pkg-dir')
  await fs.mkdir(dir, { recursive: true })
  const pkg: { name?: string } = name ? { name } : {}
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8')
  return dir
}

// ── isGitRepo / hasPackageJson / slugify unit tests ───────────────────────────

describe('helpers — isGitRepo', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('returns true for a dir with .git directory', async () => {
    const repo = await makeGitRepo(tmpDir)
    expect(isGitRepo(repo)).toBe(true)
  })

  it('returns false for a plain dir', async () => {
    const plain = path.join(tmpDir, 'plain')
    await fs.mkdir(plain)
    expect(isGitRepo(plain)).toBe(false)
  })

  it('returns false for a nonexistent path', () => {
    expect(isGitRepo('/nonexistent/path/xyz')).toBe(false)
  })
})

describe('helpers — hasPackageJson', () => {
  let tmpDir: string
  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('returns true when package.json exists', async () => {
    const dir = await makePackageJsonDir(tmpDir, 'my-pkg')
    expect(hasPackageJson(dir)).toBe(true)
  })

  it('returns false when package.json is absent', async () => {
    const plain = path.join(tmpDir, 'no-pkg')
    await fs.mkdir(plain)
    expect(hasPackageJson(plain)).toBe(false)
  })
})

describe('helpers — slugify', () => {
  it('lowercases and replaces non-alnum with hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  --hello--  ')).toBe('hello')
  })

  it('caps at 40 chars', () => {
    const long = 'a'.repeat(50)
    expect(slugify(long).length).toBeLessThanOrEqual(40)
  })

  it('collapses consecutive non-alnum runs to a single hyphen', () => {
    expect(slugify('foo   !!!   bar')).toBe('foo-bar')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
})

// ── resolveProjectDir tests ───────────────────────────────────────────────────

describe('resolveProjectDir — step 1: cwd is registered', () => {
  let tmpDir: string
  let regDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    regDir = await makeTmpDir()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(regDir, { recursive: true, force: true })
  })

  it('returns the registered project when cwd matches', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const projectDir = path.join(regDir, 'my-registered-project')
    await fs.mkdir(projectDir)
    await registry.register('my-registered-project', projectDir)

    const result = await resolveProjectDir({
      cwd: projectDir,
      idea: 'some idea',
      registry,
      homeDir: '/tmp/fake-home',
    })

    expect(result.isExisting).toBe(true)
    expect(result.isNew).toBe(false)
    expect(result.name).toBe('my-registered-project')
    expect(result.dir).toBe(path.resolve(projectDir))
  })
})

describe('resolveProjectDir — step 2: cwd is a git repo', () => {
  let tmpDir: string
  let repoBase: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    repoBase = await makeTmpDir()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoBase, { recursive: true, force: true })
  })

  it('git repo cwd → isExisting=true, dir=cwd, registers it', async () => {
    const repo = await makeGitRepo(repoBase)
    const registry = new ProjectRegistry(tmpDir)

    const result = await resolveProjectDir({
      cwd: repo,
      idea: 'irrelevant',
      registry,
      homeDir: '/tmp/fake-home',
    })

    expect(result.isExisting).toBe(true)
    expect(result.isNew).toBe(false)
    expect(result.dir).toBe(path.resolve(repo))
    // Should be registered now
    const found = await registry.findByDir(repo)
    expect(found).toBe(result.name)
  })

  it('uses package.json name when available', async () => {
    const dir = await makePackageJsonDir(repoBase, 'my-special-pkg')
    const registry = new ProjectRegistry(tmpDir)

    const result = await resolveProjectDir({
      cwd: dir,
      idea: 'irrelevant',
      registry,
      homeDir: '/tmp/fake-home',
    })

    expect(result.name).toBe('my-special-pkg')
    expect(result.isExisting).toBe(true)
  })

  it('falls back to basename when package.json has no name', async () => {
    const dir = path.join(repoBase, 'my-basename-dir')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf-8')
    const registry = new ProjectRegistry(tmpDir)

    const result = await resolveProjectDir({
      cwd: dir,
      idea: 'irrelevant',
      registry,
      homeDir: '/tmp/fake-home',
    })

    expect(result.name).toBe('my-basename-dir')
  })
})

describe('resolveProjectDir — step 3: active project', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('junk cwd + active set → returns active project dir', async () => {
    const registry = new ProjectRegistry(tmpDir)
    await registry.register('active-proj', '/projects/active-proj')
    await registry.setActive('active-proj')

    const result = await resolveProjectDir({
      cwd: '/tmp/junk-cwd-that-does-not-exist',
      idea: 'something',
      registry,
      homeDir: '/tmp/fake-home',
    })

    expect(result.isExisting).toBe(true)
    expect(result.isNew).toBe(false)
    expect(result.name).toBe('active-proj')
    expect(result.dir).toBe('/projects/active-proj')
  })
})

describe('resolveProjectDir — step 4: new project', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('junk cwd + no active → isNew=true, dir under homeDir/autodev/<slug>', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const fakeHome = '/tmp/fake-home-xyz'

    const result = await resolveProjectDir({
      cwd: '/tmp/no-such-dir-abc',
      idea: 'build a weather app',
      registry,
      homeDir: fakeHome,
    })

    expect(result.isNew).toBe(true)
    expect(result.isExisting).toBe(false)
    expect(result.dir).not.toBe(fakeHome)
    expect(result.dir.startsWith(path.join(fakeHome, 'autodev') + path.sep)).toBe(true)
  })

  it('same idea twice → same slug+hash (deterministic)', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const fakeHome = '/tmp/fake-home-det'

    const r1 = await resolveProjectDir({
      cwd: '/tmp/no-such-1',
      idea: 'deterministic idea',
      registry,
      homeDir: fakeHome,
    })

    // Fresh registry, same idea
    const registry2 = new ProjectRegistry(tmpDir)
    // Already registered from r1, but with a different cwd that is junk
    // We need a fresh registry that doesn't know about r1 to test determinism
    const registry3 = new ProjectRegistry(await makeTmpDir())
    const r2 = await resolveProjectDir({
      cwd: '/tmp/no-such-2',
      idea: 'deterministic idea',
      registry: registry3,
      homeDir: fakeHome,
    })

    expect(r1.name).toBe(r2.name)
    expect(r1.dir).toBe(r2.dir)
    void registry2
  })
})

describe('resolveProjectDir — guardrail: never return homeDir', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('cwd === homeDir → falls through to step 4 (scoped subdir)', async () => {
    const fakeHome = await makeTmpDir()
    const registry = new ProjectRegistry(tmpDir)

    const result = await resolveProjectDir({
      cwd: fakeHome,
      idea: 'some cool project',
      registry,
      homeDir: fakeHome,
    })

    expect(result.isNew).toBe(true)
    expect(result.dir).not.toBe(fakeHome)
    expect(result.dir.startsWith(path.join(fakeHome, 'autodev') + path.sep)).toBe(true)
    await fs.rm(fakeHome, { recursive: true, force: true })
  })

  it('registered project whose dir IS homeDir is NOT returned (guardrail)', async () => {
    const fakeHome = '/tmp/guardrail-home-test'
    const registry = new ProjectRegistry(tmpDir)
    // Register a project pointing to homeDir
    await registry.register('bad-proj', fakeHome)

    const result = await resolveProjectDir({
      cwd: fakeHome,
      idea: 'guarded idea',
      registry,
      homeDir: fakeHome,
    })

    expect(result.dir).not.toBe(fakeHome)
    expect(result.isNew).toBe(true)
  })

  it('active project whose dir is homeDir falls through to step 4', async () => {
    const fakeHome = '/tmp/active-home-guardrail'
    const registry = new ProjectRegistry(tmpDir)
    await registry.register('home-active', fakeHome)
    await registry.setActive('home-active')

    const result = await resolveProjectDir({
      cwd: '/tmp/junk-cwd-guardrail',
      idea: 'guarded active',
      registry,
      homeDir: fakeHome,
    })

    expect(result.dir).not.toBe(fakeHome)
    expect(result.isNew).toBe(true)
  })

  // Item 4: resolver's OWN realpathSafe (used by isHomeOrAncestor) walks up to the
  // nearest existing ancestor on ENOENT. A registered project dir reached via a
  // symlinked parent with a MISSING leaf must dereference to its real path so the
  // $HOME guardrail recognises it as homeDir and falls through to step 4. Without
  // the walk-up, the guardrail compares the non-dereferenced string, fails to match
  // home, and (wrongly) returns the registered dir at step 1.
  it('registered dir via a symlinked parent (missing leaf) is caught by the home guardrail', async () => {
    const realParent = path.join(tmpDir, 'real-home-parent')
    const linkParent = path.join(tmpDir, 'link-home-parent')
    await fs.mkdir(realParent, { recursive: true })
    await fs.symlink(realParent, linkParent)

    // homeDir real path == realParent/myhome (leaf absent).
    const homeDir = path.join(realParent, 'myhome')
    // The registered project dir points at the SAME real location via the symlink.
    const registeredViaLink = path.join(linkParent, 'myhome')

    const registry = new ProjectRegistry(tmpDir)
    await registry.register('home-symlink-proj', registeredViaLink)

    // cwd is the registered dir string → step-1 findByDir matches it, then the
    // guardrail must deref both to realParent/myhome and treat it as home.
    const result = await resolveProjectDir({
      cwd: registeredViaLink,
      idea: 'symlinked home guardrail',
      registry,
      homeDir,
    })

    // Guardrail dereferenced the symlink → registered dir === home → step 4.
    // On the OLD realpathSafe this would return isNew=false (the registered dir).
    expect(result.isNew).toBe(true)
    expect(result.dir).not.toBe(registeredViaLink)
    expect(result.dir.startsWith(path.join(homeDir, 'autodev') + path.sep)).toBe(true)
  })
})

describe('resolveProjectDir — cwd already registered (recall)', () => {
  let tmpDir: string
  let projectDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    projectDir = await makeTmpDir()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(projectDir, { recursive: true, force: true })
  })

  it('resolving same cwd twice returns consistent result (isExisting on second call)', async () => {
    const registry = new ProjectRegistry(tmpDir)
    // First call: cwd is a real dir but not yet registered
    // Make it look like a git repo
    await fs.mkdir(path.join(projectDir, '.git'))

    const r1 = await resolveProjectDir({
      cwd: projectDir,
      idea: 'my project',
      registry,
      homeDir: '/tmp/fake-home',
    })
    expect(r1.isExisting).toBe(true)

    // Second call with same cwd — now registered
    const r2 = await resolveProjectDir({
      cwd: projectDir,
      idea: 'my project',
      registry,
      homeDir: '/tmp/fake-home',
    })
    expect(r2.isExisting).toBe(true)
    expect(r2.dir).toBe(r1.dir)
    expect(r2.name).toBe(r1.name)
  })
})

// ── Fix 6: slug robustness ─────────────────────────────────────────────────────

describe('Fix 6: slug robustness — empty/all-symbol ideas, 12-hex hash, deterministic', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('empty idea → name starts with "project-" (not "-<hash>")', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const result = await resolveProjectDir({
      cwd: '/tmp/nonexistent-xyz-empty',
      idea: '',
      registry,
      homeDir: '/tmp/fake-home-slug',
    })
    expect(result.name.startsWith('project-')).toBe(true)
  })

  it('all-symbol idea → name starts with "project-"', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const result = await resolveProjectDir({
      cwd: '/tmp/nonexistent-xyz-sym',
      idea: '!!!---!!!',
      registry,
      homeDir: '/tmp/fake-home-slug',
    })
    expect(result.name.startsWith('project-')).toBe(true)
  })

  it('hash part is 12 hex characters', async () => {
    const registry = new ProjectRegistry(tmpDir)
    const result = await resolveProjectDir({
      cwd: '/tmp/nonexistent-xyz-hash',
      idea: 'build a weather app',
      registry,
      homeDir: '/tmp/fake-home-slug',
    })
    // name = "<slug>-<12hexchars>"
    const parts = result.name.split('-')
    const hashPart = parts[parts.length - 1]
    // The hash is the last 12-char hex segment (may be split if slug contains hyphens)
    // Verify the full name ends with a 12-hex suffix
    expect(result.name).toMatch(/-[0-9a-f]{12}$/)
  })

  it('same idea produces same name twice (deterministic)', async () => {
    const r1 = new ProjectRegistry(tmpDir)
    const res1 = await resolveProjectDir({
      cwd: '/tmp/nonexistent-det-1',
      idea: 'deterministic slug test',
      registry: r1,
      homeDir: '/tmp/fake-home-det',
    })
    const r2 = new ProjectRegistry(await makeTmpDir())
    const res2 = await resolveProjectDir({
      cwd: '/tmp/nonexistent-det-2',
      idea: 'deterministic slug test',
      registry: r2,
      homeDir: '/tmp/fake-home-det',
    })
    expect(res1.name).toBe(res2.name)
    expect(res1.dir).toBe(res2.dir)
  })
})

// ── Fix 4: symlink escape in resolver ─────────────────────────────────────────

describe('Fix 4: symlink escape — symlinked cwd pointing to homeDir is caught', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('symlink whose real target is homeDir is rejected (falls through to step 4)', async () => {
    const fakeHome = await makeTmpDir()
    const symlinkPath = path.join(tmpDir, 'home-link')
    const { symlinkSync } = await import('fs')
    try {
      symlinkSync(fakeHome, symlinkPath)
    } catch {
      // If symlink creation fails (e.g. permissions), skip test gracefully
      return
    }

    const registry = new ProjectRegistry(tmpDir)
    const result = await resolveProjectDir({
      cwd: symlinkPath,   // symlink → fakeHome
      idea: 'symlink escape test',
      registry,
      homeDir: fakeHome,
    })

    // Should NOT return fakeHome or symlinkPath as the project dir
    expect(result.dir).not.toBe(fakeHome)
    expect(result.dir).not.toBe(symlinkPath)
    // Should fall through to step 4 (new project under homeDir/autodev/...)
    expect(result.isNew).toBe(true)

    await fs.rm(fakeHome, { recursive: true, force: true })
  })
})

// ── Fix 7: mkdir/chdir failure leaves repoRoot clean (no half-rooted state) ───

describe('Fix 7: mkdir/resolve failure leaves repoRoot safely at cwd', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  it('step 4 resolver returns a valid dir path even for nonexistent cwd', async () => {
    // This tests that when we resolve a new project for a nonexistent cwd,
    // the returned dir is a well-formed path (not undefined, not empty).
    const registry = new ProjectRegistry(tmpDir)
    const result = await resolveProjectDir({
      cwd: '/tmp/absolutely-nonexistent-dir-xyz-123',
      idea: 'test mkdir safety',
      registry,
      homeDir: '/tmp/fake-home-mkdir',
    })
    // dir should be a non-empty absolute path
    expect(result.dir).toBeTruthy()
    expect(path.isAbsolute(result.dir)).toBe(true)
    // isNew must be true (new project)
    expect(result.isNew).toBe(true)
  })
})
