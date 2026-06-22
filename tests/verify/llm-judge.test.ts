// S2-M4: LLMJudge is DELETED — this file now tests that nothing imports it
// and confirms SubagentJudge is the replacement.
// The actual SubagentJudge tests live in tests/verify/subagent-judge.test.ts.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('S2-M4: LLMJudge deleted — nothing imports it', () => {
  it('src/verify/llm-judge.ts does not exist', () => {
    const p = path.resolve('src/verify/llm-judge.ts')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('no source file imports llm-judge', () => {
    // Scan src/ for any import of llm-judge
    function scanDir(dir: string): string[] {
      const findings: string[] = []
      if (!fs.existsSync(dir)) return findings
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          findings.push(...scanDir(full))
        } else if (entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8')
          if (content.includes('llm-judge')) {
            findings.push(full)
          }
        }
      }
      return findings
    }
    const hits = scanDir(path.resolve('src'))
    expect(hits).toEqual([])
  })
})
