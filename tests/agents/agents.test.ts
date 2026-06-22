// M8 agents + personas + skills + cockpit tests (D1: failing first)
// Uses a minimal inline frontmatter parser (gray-matter is a real dep in package.json).
import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import matter from 'gray-matter'

const AGENTS_DIR = path.resolve(process.cwd(), 'agents')
const SKILLS_DIR = path.resolve(process.cwd(), 'skills')
const COCKPIT_DIR = path.resolve(process.cwd(), 'cockpit')

// ---- helpers ---------------------------------------------------------------

async function loadMarkdownFiles(dir: string): Promise<Array<{ file: string; parsed: matter.GrayMatterFile<string> }>> {
  const entries = await fs.readdir(dir, { recursive: false })
  const mdFiles = (entries as string[]).filter(f => f.endsWith('.md'))
  return Promise.all(
    mdFiles.map(async f => {
      const content = await fs.readFile(path.join(dir, f), 'utf-8')
      return { file: f, parsed: matter(content) }
    })
  )
}

async function loadYaml(filePath: string): Promise<Record<string, unknown>> {
  // Parse YAML using gray-matter's engine (it exposes yaml via data on a ---\n...\n--- block)
  const content = await fs.readFile(filePath, 'utf-8')
  // Wrap as frontmatter so gray-matter parses the YAML body
  const wrapped = `---\n${content}\n---\n`
  const parsed = matter(wrapped)
  return parsed.data as Record<string, unknown>
}

// ---- role agents (11 files) ------------------------------------------------

describe('M8: Role agent files (11 agents)', () => {
  it('agents/ dir contains exactly 11 role agent .md files', async () => {
    const files = await fs.readdir(AGENTS_DIR)
    const roleFiles = files.filter((f: string) => f.endsWith('.md') && !f.startsWith('persona-'))
    expect(roleFiles.length).toBe(11)
  })

  it('all role agent files parse via gray-matter without error', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const roles = all.filter(({ file }) => !file.startsWith('persona-'))
    expect(roles.length).toBe(11)
    for (const { file, parsed } of roles) {
      expect(parsed.data, `${file} frontmatter`).toBeDefined()
      expect(typeof parsed.content, `${file} body`).toBe('string')
    }
  })

  it('each role agent has required frontmatter fields: name, role, model', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const roles = all.filter(({ file }) => !file.startsWith('persona-'))
    for (const { file, parsed } of roles) {
      expect(parsed.data.name, `${file} missing name`).toBeTruthy()
      expect(parsed.data.role, `${file} missing role`).toBeTruthy()
      expect(parsed.data.model, `${file} missing model`).toBeTruthy()
    }
  })

  const EXPECTED_ROLES = [
    'planner', 'architect', 'critic', 'executor', 'reviewer',
    'tester', 'integrator', 'stack-selector', 'complexity-scorer',
    'humanizer', 'designer',
  ]

  it('all 11 expected roles are present', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const roles = all.filter(({ file }) => !file.startsWith('persona-'))
    const foundRoles = roles.map(({ parsed }) => parsed.data.role as string)
    for (const expected of EXPECTED_ROLES) {
      expect(foundRoles, `missing role: ${expected}`).toContain(expected)
    }
  })
})

// ---- personas (10 files) ---------------------------------------------------

describe('M8: Persona files (10 personas)', () => {
  it('agents/ dir contains exactly 10 persona .md files (persona- prefix)', async () => {
    const files = await fs.readdir(AGENTS_DIR)
    const personaFiles = files.filter((f: string) => f.startsWith('persona-') && f.endsWith('.md'))
    expect(personaFiles.length).toBe(10)
  })

  it('all persona files parse via gray-matter without error', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const personas = all.filter(({ file }) => file.startsWith('persona-'))
    for (const { file, parsed } of personas) {
      expect(parsed.data, `${file} frontmatter`).toBeDefined()
      expect(typeof parsed.content).toBe('string')
    }
  })

  it('each persona has required frontmatter: name, persona, focus', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const personas = all.filter(({ file }) => file.startsWith('persona-'))
    for (const { file, parsed } of personas) {
      expect(parsed.data.name, `${file} missing name`).toBeTruthy()
      expect(parsed.data.persona, `${file} missing persona`).toBeTruthy()
      expect(parsed.data.focus, `${file} missing focus`).toBeTruthy()
    }
  })

  const EXPECTED_PERSONAS = [
    'architect', 'security', 'performance', 'simplicity',
    'testing', 'maintainability', 'domain-expert', 'sre-ops',
    'data-persistence', 'designer',
  ]

  it('all 10 expected personas are present', async () => {
    const all = await loadMarkdownFiles(AGENTS_DIR)
    const personas = all.filter(({ file }) => file.startsWith('persona-'))
    const foundPersonas = personas.map(({ parsed }) => parsed.data.persona as string)
    for (const expected of EXPECTED_PERSONAS) {
      expect(foundPersonas, `missing persona: ${expected}`).toContain(expected)
    }
  })
})

// ---- phase skills ----------------------------------------------------------

describe('M8: Phase skill files (6 phases)', () => {
  it('skills/ dir contains SKILL.md for each of 6 phases', async () => {
    const phaseDirs = await fs.readdir(SKILLS_DIR)
    const phaseSubdirs = (phaseDirs as string[]).filter(d => d.startsWith('phase'))
    expect(phaseSubdirs.length).toBe(6)
    for (const d of phaseSubdirs) {
      const skillPath = path.join(SKILLS_DIR, d, 'SKILL.md')
      const exists = await fs.access(skillPath).then(() => true).catch(() => false)
      expect(exists, `missing SKILL.md in ${d}`).toBe(true)
    }
  })

  it('each SKILL.md parses via gray-matter and has name + phase frontmatter', async () => {
    const phaseDirs = await fs.readdir(SKILLS_DIR)
    const phaseSubdirs = (phaseDirs as string[]).filter(d => d.startsWith('phase'))
    for (const d of phaseSubdirs) {
      const content = await fs.readFile(path.join(SKILLS_DIR, d, 'SKILL.md'), 'utf-8')
      const parsed = matter(content)
      expect(parsed.data.name, `${d}/SKILL.md missing name`).toBeTruthy()
      expect(parsed.data.phase, `${d}/SKILL.md missing phase`).toBeTruthy()
    }
  })
})

// ---- cockpit yaml ----------------------------------------------------------

describe('M8: cockpit/autodev.yaml', () => {
  it('autodev.yaml exists and parses without error', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    expect(data).toBeDefined()
  })

  it('autodev.yaml has models section', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    expect(data.models).toBeDefined()
  })

  it('autodev.yaml has tiers section', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    expect(data.tiers).toBeDefined()
  })

  it('autodev.yaml has caps section', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    expect(data.caps).toBeDefined()
  })

  it('autodev.yaml has runaway_backstop with max_iterations', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    const rb = data.runaway_backstop as Record<string, unknown>
    expect(rb).toBeDefined()
    expect(rb.max_iterations).toBeDefined()
  })

  it('autodev.yaml has mutation_threshold (number between 0 and 100)', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    const mt = data.mutation_threshold as number
    expect(typeof mt).toBe('number')
    expect(mt).toBeGreaterThan(0)
    expect(mt).toBeLessThanOrEqual(100)
  })

  it('autodev.yaml has commands section listing /autodev-* commands', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    const commands = data.commands as string[]
    expect(Array.isArray(commands)).toBe(true)
    expect(commands).toContain('/autodev-status')
    expect(commands).toContain('/autodev-pause')
    expect(commands).toContain('/autodev-resume')
    expect(commands).toContain('/autodev-doctor')
    expect(commands).toContain('/autodev-config')
    expect(commands).toContain('/autodev-tokens')
  })
})

describe('M8: cockpit/models.yaml', () => {
  it('models.yaml exists and parses without error', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'models.yaml'))
    expect(data).toBeDefined()
  })

  it('models.yaml has default_model field', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'models.yaml'))
    expect(data.default_model).toBeTruthy()
  })

  it('models.yaml has provider field', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'models.yaml'))
    expect(data.provider).toBeTruthy()
  })
})

// ---- /autodev-doctor checks Letta + codebase-memory + embedder ------------

describe('M8: /autodev-doctor command behavior', () => {
  it('autodev.yaml commands include /autodev-doctor', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    const commands = data.commands as string[]
    expect(commands).toContain('/autodev-doctor')
  })

  it('autodev.yaml doctor_checks lists all three backends', async () => {
    const data = await loadYaml(path.join(COCKPIT_DIR, 'autodev.yaml'))
    const checks = data.doctor_checks as string[]
    expect(Array.isArray(checks)).toBe(true)
    expect(checks).toContain('letta')
    expect(checks).toContain('codebase-memory-mcp')
    expect(checks).toContain('embedder')
  })
})
