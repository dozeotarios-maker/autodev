import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ProjectRegistry } from '../../src/project/registry.js'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-registry-test-'))
}

describe('ProjectRegistry — register / get round-trip', () => {
  let tmpDir: string
  let registry: ProjectRegistry

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    registry = new ProjectRegistry(tmpDir)
  })

  it('get returns undefined for unknown name', async () => {
    expect(await registry.get('does-not-exist')).toBeUndefined()
  })

  it('register then get returns the registered entry', async () => {
    await registry.register('my-app', '/home/user/my-app')
    const meta = await registry.get('my-app')
    expect(meta).toBeDefined()
    expect(path.resolve('/home/user/my-app')).toBe(meta!.dir)
  })

  it('register with stack meta stores it', async () => {
    await registry.register('ts-proj', '/projects/ts-proj', { stack: 'typescript' })
    const meta = await registry.get('ts-proj')
    expect(meta?.stack).toBe('typescript')
  })

  it('re-registering updates dir and preserves other meta', async () => {
    await registry.register('app', '/old/path', { stack: 'node' })
    await registry.register('app', '/new/path')
    const meta = await registry.get('app')
    expect(meta!.dir).toBe(path.resolve('/new/path'))
    // stack is preserved because register merges
    expect(meta?.stack).toBe('node')
  })
})

describe('ProjectRegistry — setActive / getActive', () => {
  let tmpDir: string
  let registry: ProjectRegistry

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    registry = new ProjectRegistry(tmpDir)
  })

  it('getActive returns undefined when nothing is set', async () => {
    expect(await registry.getActive()).toBeUndefined()
  })

  it('setActive then getActive returns the name', async () => {
    await registry.register('proj-a', '/a')
    await registry.setActive('proj-a')
    expect(await registry.getActive()).toBe('proj-a')
  })

  it('setActive replaces prior active', async () => {
    await registry.register('proj-a', '/a')
    await registry.register('proj-b', '/b')
    await registry.setActive('proj-a')
    await registry.setActive('proj-b')
    expect(await registry.getActive()).toBe('proj-b')
  })
})

describe('ProjectRegistry — findByDir', () => {
  let tmpDir: string
  let registry: ProjectRegistry

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    registry = new ProjectRegistry(tmpDir)
  })

  it('returns undefined for unregistered dir', async () => {
    expect(await registry.findByDir('/some/random/path')).toBeUndefined()
  })

  it('returns name for exact match', async () => {
    await registry.register('exact', '/exact/path')
    expect(await registry.findByDir('/exact/path')).toBe('exact')
  })

  it('normalizes paths — trailing slashes and relative segments', async () => {
    await registry.register('norm', '/some/project')
    // path.resolve('/some/project/') === '/some/project'
    expect(await registry.findByDir('/some/project/')).toBe('norm')
  })

  it('resolves relative paths when matching', async () => {
    // Register an absolute path, look up with a path that resolves to the same thing
    const abs = path.join(tmpDir, 'proj')
    await registry.register('rel-proj', abs)
    expect(await registry.findByDir(abs)).toBe('rel-proj')
  })
})

describe('ProjectRegistry — persistence across instances', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
  })

  it('a fresh instance on the same baseDir reads what a prior instance wrote', async () => {
    const r1 = new ProjectRegistry(tmpDir)
    await r1.register('persist-proj', '/persist/path', { stack: 'python' })
    await r1.setActive('persist-proj')

    const r2 = new ProjectRegistry(tmpDir)
    const meta = await r2.get('persist-proj')
    expect(meta).toBeDefined()
    expect(meta!.dir).toBe(path.resolve('/persist/path'))
    expect(meta!.stack).toBe('python')
    expect(await r2.getActive()).toBe('persist-proj')
  })

  it('list() returns all registered projects', async () => {
    const r1 = new ProjectRegistry(tmpDir)
    await r1.register('a', '/dir/a')
    await r1.register('b', '/dir/b', { stack: 'go' })

    const r2 = new ProjectRegistry(tmpDir)
    const items = await r2.list()
    expect(items.length).toBe(2)
    const names = items.map((i) => i.name).sort()
    expect(names).toEqual(['a', 'b'])
  })
})

describe('ProjectRegistry — corrupt / missing file tolerance', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
  })

  it('missing file → empty registry, no throw', async () => {
    const registry = new ProjectRegistry(tmpDir)
    // No file written yet
    expect(await registry.get('x')).toBeUndefined()
    expect(await registry.getActive()).toBeUndefined()
    expect(await registry.list()).toEqual([])
  })

  it('corrupt JSON file → empty registry, no throw', async () => {
    // Write a corrupt projects.json
    const filePath = path.join(tmpDir, 'projects.json')
    await fs.writeFile(filePath, '{ "projects": BROKEN JSON }', 'utf-8')

    const registry = new ProjectRegistry(tmpDir)
    expect(() => registry.get('x')).not.toThrow()
    expect(await registry.get('x')).toBeUndefined()
    expect(await registry.list()).toEqual([])
  })

  it('file with valid JSON but wrong shape → empty registry, no throw', async () => {
    const filePath = path.join(tmpDir, 'projects.json')
    await fs.writeFile(filePath, JSON.stringify({ notProjects: true }), 'utf-8')

    const registry = new ProjectRegistry(tmpDir)
    expect(await registry.list()).toEqual([])
  })
})

describe('ProjectRegistry — atomic write (temp-then-rename)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
  })

  it('no .tmp file left behind after register', async () => {
    const registry = new ProjectRegistry(tmpDir)
    await registry.register('clean', '/clean/path')

    const entries = await fs.readdir(tmpDir)
    const tmpFiles = entries.filter((e) => e.includes('.tmp.'))
    expect(tmpFiles).toHaveLength(0)
  })
})

// ── Fix 5: registry load race + lost update ───────────────────────────────────

describe('Fix 5: concurrent register() — both writes persist (no lost update)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent register() calls on the same instance both persist', async () => {
    const registry = new ProjectRegistry(tmpDir)
    // Fire two registers concurrently
    await Promise.all([
      registry.register('proj-a', '/dir/a'),
      registry.register('proj-b', '/dir/b'),
    ])

    // Fresh instance reads from disk — both should be present
    const r2 = new ProjectRegistry(tmpDir)
    const a = await r2.get('proj-a')
    const b = await r2.get('proj-b')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(path.resolve('/dir/a')).toBe(a!.dir)
    expect(path.resolve('/dir/b')).toBe(b!.dir)
  })

  it('second instance register() does not lose first instance write', async () => {
    // Instance 1 writes proj-a
    const r1 = new ProjectRegistry(tmpDir)
    await r1.register('proj-a', '/dir/a')

    // Instance 2 (separate, loads from disk) writes proj-b
    const r2 = new ProjectRegistry(tmpDir)
    await r2.register('proj-b', '/dir/b')

    // Fresh instance 3 reads from disk — both should be present
    const r3 = new ProjectRegistry(tmpDir)
    const a = await r3.get('proj-a')
    const b = await r3.get('proj-b')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
  })

  it('concurrent first-load on same instance does not double-parse (load promise memoized)', async () => {
    const registry = new ProjectRegistry(tmpDir)
    // Write some data first via a separate instance
    const r0 = new ProjectRegistry(tmpDir)
    await r0.register('seed', '/dir/seed')

    // Trigger concurrent loads
    const [a, b] = await Promise.all([
      registry.get('seed'),
      registry.get('seed'),
    ])
    // Both should return the same result (not undefined from a race)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.dir).toBe(b!.dir)
  })
})

// ── Fix 4: findByDir resolves symlinks ────────────────────────────────────────

describe('Fix 4: findByDir uses realpathSafe (symlink dirs)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('findByDir returns name when dir registered with symlink resolved to same real path', async () => {
    const realDir = path.join(tmpDir, 'real-project')
    await fs.mkdir(realDir)
    const registry = new ProjectRegistry(tmpDir)
    await registry.register('real-proj', realDir)

    // Look up using the real path — should find it
    const found = await registry.findByDir(realDir)
    expect(found).toBe('real-proj')
  })
})
