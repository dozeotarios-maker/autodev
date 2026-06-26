// S2-M3a/b: Phase output types — discriminated unions for the file-based phase contracts.
// Each phase writes a typed JSON file to .autodev/phase-output/p{N}-{name}.json.
// The controller reads + schema-validates these files; the next phase's PhaseContext
// is derived from the prior phase's PhaseOutput.

import type { Sizing } from '../engine/complexity.js'
import type { MemoryStore, Embedder } from '../ports.js'

// ── P1 DISCOVER ───────────────────────────────────────────────────────────────

export interface WebResearchEntry {
  url: string
  title: string
  summary: string
}

export interface P1Output {
  phase: 'P1'
  spec: string
  stackAdr: string
  webResearch: WebResearchEntry[]
}

export interface P1Context {
  phase: 'P1'
  idea: string
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
  /** Optional Letta memory backend — absent when not wired; phases must degrade gracefully. */
  memoryStore?: MemoryStore
  /** Optional embedder — absent when not wired. */
  embedder?: Embedder
  /** Injection-screening hook — screen recalled text before injecting into instructions. */
  screenContent?: (text: string, source: 'repo') => Promise<{ safe: boolean; threats: string[] }>
}

// ── P2 ELABORATE ─────────────────────────────────────────────────────────────

export interface PersonaDebateEntry {
  persona: string
  stance: string
  objections: string[]
}

export interface P2Output {
  phase: 'P2'
  domainModel: string
  personaDebate: PersonaDebateEntry[]
}

export interface P2Context {
  phase: 'P2'
  p1: P1Output
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
}

// ── P3 PLAN ──────────────────────────────────────────────────────────────────

export interface FileDAGEntry {
  file: string
  lane: number
  deps: string[]
}

export interface SprintContract {
  goal: string
  successCriteria: string[]
  outOfScope: string[]
}

export interface ExampleEntry {
  scenario: string
  input: string
  expectedOutput: string
}

export interface P3Output {
  phase: 'P3'
  fileDAG: FileDAGEntry[]
  panelObjCount: number
  sprintContract: SprintContract
  examplesTable: ExampleEntry[]
}

export interface P3Context {
  phase: 'P3'
  p1: P1Output
  p2: P2Output
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
}

// ── P4 BUILD ─────────────────────────────────────────────────────────────────

export interface LaneResult {
  laneId: number
  status: 'success' | 'failed'
  files: string[]
  output: string
}

export interface P4Output {
  phase: 'P4'
  laneResults: LaneResult[]
  artifacts: string[]
}

export interface P4Context {
  phase: 'P4'
  p3: P3Output
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
}

// ── P5 VERIFY ────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  file: string
  line?: number
  description: string
}

export interface VerifyReport {
  deterministicPassed: boolean
  holdoutPassed: boolean
  mutationScore?: number
  securityClean: boolean
}

export interface P5Output {
  phase: 'P5'
  verifyReport: VerifyReport
  reviewFindings: ReviewFinding[]
}

export interface P5Context {
  phase: 'P5'
  p3: P3Output
  p4: P4Output
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
}

// ── P6 RELEASE ───────────────────────────────────────────────────────────────

export interface P6Output {
  phase: 'P6'
  commitSha: string
  pushResult: string
}

export interface P6Context {
  phase: 'P6'
  p5: P5Output
  // TODO: make sizing required once test fixtures updated
  sizing?: Sizing
}

// ── Discriminated unions ──────────────────────────────────────────────────────

export type PhaseOutput = P1Output | P2Output | P3Output | P4Output | P5Output | P6Output

export type PhaseContext = P1Context | P2Context | P3Context | P4Context | P5Context | P6Context

// ── Schema validators (minimal — check required fields exist) ─────────────────

export function validateP1Output(raw: unknown): raw is P1Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P1' &&
    typeof o['spec'] === 'string' &&
    typeof o['stackAdr'] === 'string' &&
    Array.isArray(o['webResearch'])
  )
}

export function validateP2Output(raw: unknown): raw is P2Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P2' &&
    typeof o['domainModel'] === 'string' &&
    Array.isArray(o['personaDebate'])
  )
}

export function validateP3Output(raw: unknown): raw is P3Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P3' &&
    Array.isArray(o['fileDAG']) &&
    typeof o['panelObjCount'] === 'number' &&
    typeof o['sprintContract'] === 'object' &&
    o['sprintContract'] !== null &&
    Array.isArray(o['examplesTable'])
  )
}

export function validateP4Output(raw: unknown): raw is P4Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P4' &&
    Array.isArray(o['laneResults']) &&
    Array.isArray(o['artifacts'])
  )
}

export function validateP5Output(raw: unknown): raw is P5Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P5' &&
    typeof o['verifyReport'] === 'object' &&
    o['verifyReport'] !== null &&
    Array.isArray(o['reviewFindings'])
  )
}

export function validateP6Output(raw: unknown): raw is P6Output {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    o['phase'] === 'P6' &&
    typeof o['commitSha'] === 'string' &&
    typeof o['pushResult'] === 'string'
  )
}
