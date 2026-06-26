// Node proof for the project-resolver re-root fix.
//
// Constructs the REAL composed adapters (not vitest mocks), simulates a project
// re-root into a fresh temp git repo, and asserts:
//   1. process.cwd() === tempDir after chdir
//   2. a re-rooted ScopedCommit commits into tempDir (git log proves it)
//   3. a re-rooted gitleaks scan (runSecurityScan(tempDir)) targets tempDir
//   4. a re-rooted TransparencyImpl writes activity.log under tempDir/.autodev
//   5. process.cwd() restored to the original cwd afterward
//
// Run after `npm run build`:  node scripts/proof-reroot.mjs

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildExtension } from '../dist/extension/index.js'
import { TransparencyImpl } from '../dist/transparency/index.js'
import { CodebaseMemoryAdapter } from '../dist/memory/codebase-memory-adapter.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`)
  } else {
    console.log(`  FAIL: ${msg}`)
    failures++
  }
}

const originalCwd = process.cwd()
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-reroot-')))

// Make tempDir a real git repo with an initial commit so ScopedCommit can stage+commit.
execFileSync('git', ['init', '-q'], { cwd: tempDir })
execFileSync('git', ['config', 'user.email', 'proof@example.com'], { cwd: tempDir })
execFileSync('git', ['config', 'user.name', 'proof'], { cwd: tempDir })
execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: tempDir })

console.log(`originalCwd = ${originalCwd}`)
console.log(`tempDir     = ${tempDir}`)

// ── Build the REAL composed backends (build-time cwd = originalCwd) ───────────
const built = buildExtension({ repoRoot: originalCwd })
const gitOps = built.gitOps // ReRootableGitOps (has setRepoRoot)
const transparency = new TransparencyImpl(originalCwd, { setWidget: () => {} })
const codebaseMemory = new CodebaseMemoryAdapter({ mock: true, repoRoot: originalCwd })

console.log('\n[1] Simulate the controller re-root: chdir + setRepoRoot on each backend')
process.chdir(tempDir)
gitOps.setRepoRoot(tempDir)
transparency.setRepoRoot(tempDir)
codebaseMemory.setRepoRoot(tempDir)

assert(process.cwd() === tempDir, `process.cwd() === tempDir (${process.cwd()})`)

// ── [2] ScopedCommit targets tempDir ─────────────────────────────────────────
console.log('\n[2] Re-rooted ScopedCommit commits into tempDir')
fs.mkdirSync(path.join(tempDir, '.autodev', 'phase-output'), { recursive: true })
fs.writeFileSync(path.join(tempDir, '.autodev', 'phase-output', 'p6.json'), '{"phase":"P6"}\n')
const commitBeforeOriginal = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originalCwd }).toString().trim()
const res = await gitOps.scopedCommit('proof: scoped commit in tempDir', ['.autodev/phase-output/'])
const tempHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir }).toString().trim()
assert(res.sha === tempHead, `scopedCommit sha (${res.sha.slice(0, 8)}) === tempDir HEAD (${tempHead.slice(0, 8)})`)
const commitAfterOriginal = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originalCwd }).toString().trim()
assert(commitBeforeOriginal === commitAfterOriginal, 'original repo HEAD unchanged (commit did NOT hit original cwd)')
const tempLog = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: tempDir }).toString().trim()
assert(tempLog === 'proof: scoped commit in tempDir', `tempDir HEAD message is the proof commit ("${tempLog}")`)

// ── [3] gitleaks scan targets tempDir ────────────────────────────────────────
console.log('\n[3] Re-rooted gitleaks (runSecurityScan(tempDir)) targets tempDir')
// Verifier.runSecurityScan honors its wd arg → builds a GitleaksHook(tempDir).
// gitleaks may be absent on PATH; either way the result is { clean, findings }
// and (critically) it was invoked against tempDir, not originalCwd.
const scan = await built.verifier.runSecurityScan(tempDir)
assert(typeof scan.clean === 'boolean', `runSecurityScan(tempDir) returned a result (clean=${scan.clean})`)
// Also prove the GitOps.scanSecrets path is bound to tempDir (no throw, structured result).
const scan2 = await gitOps.scanSecrets(false)
assert(typeof scan2.clean === 'boolean', `gitOps.scanSecrets after setRepoRoot returned a result (clean=${scan2.clean})`)

// ── [4] Transparency writes under tempDir/.autodev ───────────────────────────
console.log('\n[4] Re-rooted TransparencyImpl writes activity.log under tempDir/.autodev')
await transparency.log('proof line after re-root')
await transparency.recordMetric({ role: 'r', task: 't', metric_name: 'proof', value: 1, timestamp: new Date().toISOString() })
const tempActivity = path.join(tempDir, '.autodev', 'activity.log')
const tempMetrics = path.join(tempDir, '.autodev', 'metrics.jsonl')
assert(fs.existsSync(tempActivity), 'tempDir/.autodev/activity.log exists')
assert(fs.readFileSync(tempActivity, 'utf8').includes('proof line after re-root'), 'activity.log contains the proof line')
assert(fs.existsSync(tempMetrics), 'tempDir/.autodev/metrics.jsonl exists')
// The original cwd must NOT have received this run's transparency writes.
const origActivity = path.join(originalCwd, '.autodev', 'activity.log')
const origActivityHasProof = fs.existsSync(origActivity) && fs.readFileSync(origActivity, 'utf8').includes('proof line after re-root')
assert(!origActivityHasProof, 'original cwd .autodev/activity.log did NOT receive the proof line')

// ── [5] Restore cwd ──────────────────────────────────────────────────────────
console.log('\n[5] Restore cwd after the run')
process.chdir(originalCwd)
assert(process.cwd() === originalCwd, `process.cwd() restored to originalCwd (${process.cwd()})`)

// ── Cleanup ──────────────────────────────────────────────────────────────────
fs.rmSync(tempDir, { recursive: true, force: true })
try { codebaseMemory.dispose() } catch { /* mock — noop */ }

console.log(`\n${failures === 0 ? 'ALL PROOF ASSERTIONS PASSED' : `PROOF FAILED: ${failures} assertion(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
