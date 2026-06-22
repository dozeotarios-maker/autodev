// M6a: holdout verifier — clean-context LLM judge (primary) + test-tree edit-detection
import type { Judge } from '../ports.js'

export interface HoldoutInput {
  goal: string
  evidence: string
  testFiles: string[]
  testFilesSnapshot: Record<string, string>
  currentTestHashes?: Record<string, string>
  // These are intentionally excluded from judge calls (clean-context requirement)
  llmTrace?: string
  spec?: string
}

export interface HoldoutResult {
  passed: boolean
  reason?: string
}

export class HoldoutVerifier {
  constructor(private readonly judge: Judge) {}

  async run(input: HoldoutInput): Promise<HoldoutResult> {
    // Test-tree edit detection — catch reward hacking before calling judge
    if (input.currentTestHashes) {
      for (const [file, snapshotHash] of Object.entries(input.testFilesSnapshot)) {
        const currentHash = input.currentTestHashes[file]
        if (currentHash !== undefined && currentHash !== snapshotHash) {
          return {
            passed: false,
            reason: `Test-tree edit detected: ${file} hash changed (reward hack suspected)`,
          }
        }
      }
    }

    // Clean-context judge call — pass ONLY goal and evidence, never spec/trace
    const done = await this.judge.isDone(input.goal, input.evidence)
    if (!done) {
      return { passed: false, reason: 'Judge determined goal not yet achieved' }
    }

    return { passed: true }
  }
}
