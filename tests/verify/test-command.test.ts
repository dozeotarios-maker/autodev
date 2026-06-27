import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { resolveTestCommand } from '../../src/verify/test-command.js'

describe('resolveTestCommand', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-cmd-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const writePkg = (obj: unknown): Promise<void> =>
    fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(obj))

  it('uses `npm test` when package.json declares a node:test script (honors chosen stack)', async () => {
    await writePkg({ scripts: { test: 'node --test' } })
    expect(await resolveTestCommand(dir)).toBe('npm test')
  })

  it('uses `npm test` for a vitest test script too', async () => {
    await writePkg({ scripts: { test: 'vitest run' } })
    expect(await resolveTestCommand(dir)).toBe('npm test')
  })

  it('falls back to `npx vitest run` when there is no package.json', async () => {
    expect(await resolveTestCommand(dir)).toBe('npx vitest run')
  })

  it('falls back when package.json has no test script', async () => {
    await writePkg({ scripts: { build: 'tsc' } })
    expect(await resolveTestCommand(dir)).toBe('npx vitest run')
  })

  it('falls back when the test script is whitespace-only', async () => {
    await writePkg({ scripts: { test: '   ' } })
    expect(await resolveTestCommand(dir)).toBe('npx vitest run')
  })

  it('falls back on malformed package.json', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{ not json')
    expect(await resolveTestCommand(dir)).toBe('npx vitest run')
  })
})
