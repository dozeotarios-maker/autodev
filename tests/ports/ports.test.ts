// M1 ports test — written FIRST (D1)
// Verifies all 10 interfaces compile and can be implemented with no-op stubs (zero type errors)
import { describe, it, expect } from 'vitest'
import type {
  MemoryStore,
  Embedder,
  Lane,
  Verifier,
  GitOps,
  Transparency,
  Judge,
  TokenVault,
  SecurityLane,
  Resurrection,
} from '../../src/ports.js'

describe('M1: 10 port interfaces', () => {
  it('MemoryStore no-op stub typechecks and is defined', () => {
    const stub: MemoryStore = {
      store: async () => {},
      recall: async () => [],
      detectContradictions: async () => [],
      healthCheck: async () => ({ ok: true }),
    }
    expect(stub).toBeDefined()
  })

  it('Embedder no-op stub typechecks', () => {
    const stub: Embedder = {
      embed: async () => [],
      healthCheck: async () => ({ ok: true }),
    }
    expect(stub).toBeDefined()
  })

  it('Lane no-op stub typechecks', () => {
    const stub: Lane = {
      id: 'test-lane',
      files: [],
      run: async () => ({ output: '', exitCode: 0 }),
      status: () => 'idle',
    }
    expect(stub).toBeDefined()
  })

  it('Verifier no-op stub typechecks', () => {
    const stub: Verifier = {
      runDeterministic: async () => ({ passed: true, exitCode: 0, output: '' }),
      runMutation: async () => ({ score: 100, passed: true }),
      runHoldout: async () => ({ passed: true, output: '' }),
      runSecurityScan: async () => ({ clean: true, findings: [] }),
    }
    expect(stub).toBeDefined()
  })

  it('GitOps no-op stub typechecks', () => {
    const stub: GitOps = {
      scopedCommit: async () => ({ sha: 'abc123' }),
      perPhasePush: async () => {},
      tierDGate: async () => true,
      scanSecrets: async () => ({ clean: true, findings: [] }),
    }
    expect(stub).toBeDefined()
  })

  it('Transparency no-op stub typechecks', () => {
    const stub: Transparency = {
      log: () => {},
      appendEntry: () => {},
      setHudStatus: () => {},
      recordMetric: () => {},
    }
    expect(stub).toBeDefined()
  })

  it('Judge no-op stub typechecks', () => {
    const stub: Judge = {
      isDone: async () => false,
      isStillRight: async () => ({ aligned: true }),
    }
    expect(stub).toBeDefined()
  })

  it('TokenVault no-op stub typechecks', () => {
    const stub: TokenVault = {
      getToken: async () => '',
      revokeToken: async () => {},
      hasToken: async () => false,
    }
    expect(stub).toBeDefined()
  })

  it('SecurityLane no-op stub typechecks', () => {
    const stub: SecurityLane = {
      reviewDiff: async () => ({ clean: true, findings: [] }),
      screenContent: async () => ({ safe: true, threats: [] }),
    }
    expect(stub).toBeDefined()
  })

  it('Resurrection no-op stub typechecks', () => {
    const stub: Resurrection = {
      reconstruct: async () => ({ phase: 'P1', lastGoodCommit: 'abc', halfDone: [] }),
      resume: async () => ({ resumed: false, report: '' }),
      isIdempotentSafe: async () => true,
    }
    expect(stub).toBeDefined()
  })
})
