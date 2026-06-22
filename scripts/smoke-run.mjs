#!/usr/bin/env node
/**
 * pi-autodev — Manual Smoke-Run Harness (S2-M8)
 *
 * Purpose
 * -------
 * This is a DOCUMENTED MANUAL harness, not an automated test.
 * Use it to run a real pi session end-to-end: drop an idea, watch P1→P6.
 *
 * Do NOT run this in CI — it requires live external services (see Prerequisites).
 *
 * Prerequisites
 * -------------
 * 1. Letta HTTP server running at http://localhost:8283 (or set LETTA_BASE_URL).
 *    Start: docker run -p 8283:8283 lettaai/letta:latest
 *    Doc:   https://docs.letta.com/quickstart
 *
 * 2. GEMINI_API_KEY set (for the GeminiEmbedder fallback).
 *    export GEMINI_API_KEY=<your key>
 *
 * 3. codebase-memory-mcp binary on PATH (or set CODEBASE_MEMORY_MOCK=1 to skip).
 *    Install: npm i -g codebase-memory-mcp (or build from source).
 *
 * 4. A non-walled model available to pi (Opus xhigh recommended per ADR).
 *    The extension runs as a pi extension; billing must be lifted.
 *
 * 5. pi-hud (optional, for the HUD widget).
 *    If absent, setWidget is a no-op — the run proceeds without visual HUD.
 *
 * Throughput note (per ADR §Throughput)
 * --------------------------------------
 * XS  (~1 file,   low novelty)  : ~5  host turns / ~2 min
 * S   (~2–3 file, low novelty)  : ~8  host turns / ~5 min
 * M   (~5 file,   med novelty)  : ~12 host turns / ~10 min
 * L   (~8 file,   med novelty)  : ~18 host turns / ~25 min
 * XL  (~15+ file, high novelty) : ~25 host turns / ~50 min
 * (Opus xhigh; subagent work additional; orchestration overhead included.)
 *
 * How to run a real pi session
 * ----------------------------
 * 1. Install the extension in your pi environment:
 *
 *    cd /path/to/your/project
 *    # Point pi to this extension (in your pi config or as a local extension):
 *    pi extension add /root/pi-autodev
 *
 * 2. Start pi and open a coding session in a project directory.
 *
 * 3. Drop an idea (text input):
 *
 *    add a rate-limiting middleware to src/server.ts that blocks >100 req/min per IP
 *
 *    pi-autodev detects the idea (non-question, non-command input), transitions
 *    ARMED → RUNNING, and drives P1 → P6 automatically.
 *
 * 4. Watch the output:
 *    - HUD widget reflects the current phase (P1 DISCOVER … P6 RELEASE).
 *    - .autodev/activity.log streams all phase actions.
 *    - .autodev/phase-output/p{N}-*.json files are written as each phase completes.
 *    - .autodev/journal.jsonl records every pre-action / completion / decision.
 *
 * 5. Available commands (type in pi while running):
 *    /autodev-status  — show current phase, task, lane status, uptime
 *    /autodev-pause   — pause at next phase boundary
 *    /autodev-resume  — resume after pause
 *    /autodev-tokens  — show token usage location
 *    /autodev-config  — show active configuration
 *    /autodev-doctor  — health-check Letta / codebase-memory / outputDir
 *
 * 6. After P6 completes:
 *    - A scoped commit is produced (only the sprint artifacts — not git add --all).
 *    - .autodev/phase-output/p6-release.json contains { commitSha, pushResult }.
 *    - The HUD widget shows DONE.
 *
 * Environment variables
 * ---------------------
 * LETTA_MOCK=1             — use in-memory Letta stub (no server needed)
 * LETTA_BASE_URL           — Letta HTTP base URL (default: http://localhost:8283)
 * LETTA_AGENT_ID           — Letta agent ID (default: autodev-default)
 * GEMINI_MOCK=1            — use stub Gemini embedder
 * GEMINI_API_KEY           — Gemini API key for real embeddings
 * OLLAMA_MOCK=1            — use stub Ollama embedder
 * CODEBASE_MEMORY_MOCK=1   — use in-memory codebase-memory stub (no binary needed)
 *
 * Minimal smoke run (all mocks — validates wiring only, no real model)
 * --------------------------------------------------------------------
 * export LETTA_MOCK=1 GEMINI_MOCK=1 CODEBASE_MEMORY_MOCK=1
 * # Then load the extension in pi and provide a test idea.
 * # Phase steers fire; without a real model, agent_end never arrives →
 * # steers time out and controller escalates. Expected with no real model.
 *
 * Full real run checklist
 * -----------------------
 * [ ] Letta server running (curl http://localhost:8283/v1/health → {"status":"ok"})
 * [ ] GEMINI_API_KEY set
 * [ ] codebase-memory-mcp on PATH (which codebase-memory-mcp)
 * [ ] pi session open in target project directory
 * [ ] Billing lifted / model not walled
 * [ ] Run: /autodev-doctor  (in pi)  to verify all backends
 * [ ] Drop the idea
 * [ ] Monitor: tail -f .autodev/activity.log
 */

// This file intentionally has no executable body — it is a documented harness.
// The real execution happens inside pi (the extension is loaded by pi, not node).
// Running `node scripts/smoke-run.mjs` prints this usage guide.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const source = readFileSync(selfPath, 'utf-8')

// Extract and print the JSDoc comment block
const match = source.match(/^\/\*\*([\s\S]*?)\*\//m)
if (match) {
  // Strip leading ' * ' from each line for clean terminal output
  const text = match[1]
    .split('\n')
    .map(line => line.replace(/^ \* ?/, ''))
    .join('\n')
  process.stdout.write(text + '\n')
} else {
  process.stdout.write('pi-autodev smoke-run harness — see source for documentation.\n')
}
