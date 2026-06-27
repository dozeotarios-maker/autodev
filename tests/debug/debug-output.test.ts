// C-1 Group 1 tests: D1–D5 output validators

import { describe, it, expect } from 'vitest'
import {
  validateD1Output,
  validateD2Output,
  validateD3Output,
  validateD4Output,
  validateD5Output,
  ALLOWED_BINARIES,
} from '../../src/debug/debug-output.js'

// ── D1 ────────────────────────────────────────────────────────────────────────

describe('validateD1Output', () => {
  const valid = {
    reproSummary: 'A repro test that fails when auth token is invalid',
    reproCommand: 'npx vitest run tests/debug/repro-auth-123.test.ts',
    reproArtifact: 'tests/debug/repro-auth-123.test.ts',
  }

  it('accepts a valid D1Output', () => {
    expect(validateD1Output(valid)).toBe(true)
  })

  it('accepts optional reproConfirmedRed', () => {
    expect(validateD1Output({ ...valid, reproConfirmedRed: true })).toBe(true)
    expect(validateD1Output({ ...valid, reproConfirmedRed: false })).toBe(true)
  })

  it('rejects null / non-object', () => {
    expect(validateD1Output(null)).toBe(false)
    expect(validateD1Output('string')).toBe(false)
    expect(validateD1Output(42)).toBe(false)
  })

  it('rejects missing reproSummary', () => {
    const { reproSummary: _, ...rest } = valid
    expect(validateD1Output(rest)).toBe(false)
  })

  it('rejects empty reproSummary', () => {
    expect(validateD1Output({ ...valid, reproSummary: '' })).toBe(false)
    expect(validateD1Output({ ...valid, reproSummary: '   ' })).toBe(false)
  })

  it('rejects missing reproCommand', () => {
    const { reproCommand: _, ...rest } = valid
    expect(validateD1Output(rest)).toBe(false)
  })

  it('rejects reproCommand with disallowed binary', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'bash tests/run.sh' })).toBe(false)
    expect(validateD1Output({ ...valid, reproCommand: 'python repro.py' })).toBe(false)
    expect(validateD1Output({ ...valid, reproCommand: 'sh repro.sh' })).toBe(false)
    expect(validateD1Output({ ...valid, reproCommand: './repro.sh' })).toBe(false)
  })

  it('accepts all ALLOWED_BINARIES as reproCommand first token', () => {
    for (const bin of ALLOWED_BINARIES) {
      const cmd = `${bin} run tests/repro.test.ts`
      expect(validateD1Output({ ...valid, reproCommand: cmd })).toBe(true)
    }
  })

  it('rejects missing reproArtifact', () => {
    const { reproArtifact: _, ...rest } = valid
    expect(validateD1Output(rest)).toBe(false)
  })

  it('rejects reproArtifact with no path separator and no extension', () => {
    expect(validateD1Output({ ...valid, reproArtifact: 'myfile' })).toBe(false)
  })

  it('accepts reproArtifact with extension', () => {
    expect(validateD1Output({ ...valid, reproArtifact: 'repro.test.ts' })).toBe(true)
  })

  it('accepts reproArtifact with path separator', () => {
    expect(validateD1Output({ ...valid, reproArtifact: 'tests/repro' })).toBe(true)
  })

  // MEDIUM: shell-metachar bypass fix
  it('rejects reproCommand containing semicolon (shell metachar)', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts; node -e "evil"' })).toBe(false)
  })

  it('rejects reproCommand containing &&', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts && rm -rf /' })).toBe(false)
  })

  it('rejects reproCommand containing ||', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts || evil' })).toBe(false)
  })

  it('rejects reproCommand containing pipe |', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts | cat' })).toBe(false)
  })

  it('rejects reproCommand containing backtick', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run `echo evil`' })).toBe(false)
  })

  it('rejects reproCommand containing $( substitution', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run $(echo tests/repro.test.ts)' })).toBe(false)
  })

  it('rejects reproCommand containing output redirect >', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts > /tmp/out' })).toBe(false)
  })

  it('rejects reproCommand containing input redirect <', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts < input' })).toBe(false)
  })

  it('rejects reproCommand containing background & operator', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/repro.test.ts &' })).toBe(false)
  })

  it('accepts clean reproCommand with no metacharacters', () => {
    expect(validateD1Output({ ...valid, reproCommand: 'npx vitest run tests/debug/repro-auth.test.ts' })).toBe(true)
  })
})

// ── D2 ────────────────────────────────────────────────────────────────────────

describe('validateD2Output', () => {
  const validHypothesis = {
    claim: 'The token validation regex is wrong',
    evidenceFor: 'Regex does not account for special chars',
    evidenceAgainst: 'Basic tokens pass fine',
  }

  const valid = {
    hypotheses: [
      validHypothesis,
      { claim: 'Token expiry not checked', evidenceFor: 'No TTL in code', evidenceAgainst: 'Tests do pass for fresh tokens' },
    ],
    rootCause: 'Token validation regex excludes valid chars',
    rootCauseLocation: 'src/auth/validate.ts:23',
  }

  it('accepts valid D2Output with 2 hypotheses', () => {
    expect(validateD2Output(valid)).toBe(true)
  })

  it('accepts 3+ hypotheses', () => {
    const extra = { claim: 'Third hypothesis', evidenceFor: 'x', evidenceAgainst: 'y' }
    expect(validateD2Output({ ...valid, hypotheses: [...valid.hypotheses, extra] })).toBe(true)
  })

  it('rejects fewer than 2 hypotheses', () => {
    expect(validateD2Output({ ...valid, hypotheses: [] })).toBe(false)
    expect(validateD2Output({ ...valid, hypotheses: [validHypothesis] })).toBe(false)
  })

  it('rejects hypothesis missing claim', () => {
    const bad = [{ evidenceFor: 'x', evidenceAgainst: 'y' }, validHypothesis]
    expect(validateD2Output({ ...valid, hypotheses: bad })).toBe(false)
  })

  it('rejects hypothesis with empty claim', () => {
    const bad = [{ claim: '', evidenceFor: 'x', evidenceAgainst: 'y' }, validHypothesis]
    expect(validateD2Output({ ...valid, hypotheses: bad })).toBe(false)
  })

  it('rejects hypothesis missing evidenceFor', () => {
    const bad = [{ claim: 'x', evidenceAgainst: 'y' }, validHypothesis]
    expect(validateD2Output({ ...valid, hypotheses: bad })).toBe(false)
  })

  it('rejects missing rootCause', () => {
    const { rootCause: _, ...rest } = valid
    expect(validateD2Output(rest)).toBe(false)
  })

  it('rejects empty rootCauseLocation', () => {
    expect(validateD2Output({ ...valid, rootCauseLocation: '' })).toBe(false)
  })

  it('rejects non-object', () => {
    expect(validateD2Output(null)).toBe(false)
    expect(validateD2Output([])).toBe(false)
  })
})

// ── D3 ────────────────────────────────────────────────────────────────────────

describe('validateD3Output', () => {
  const valid = {
    fixSummary: 'Updated the regex to allow special characters in tokens',
    filesChanged: ['src/auth/validate.ts'],
  }

  it('accepts valid D3Output', () => {
    expect(validateD3Output(valid)).toBe(true)
  })

  it('accepts empty filesChanged array', () => {
    expect(validateD3Output({ ...valid, filesChanged: [] })).toBe(true)
  })

  it('rejects missing fixSummary', () => {
    const { fixSummary: _, ...rest } = valid
    expect(validateD3Output(rest)).toBe(false)
  })

  it('rejects empty fixSummary', () => {
    expect(validateD3Output({ ...valid, fixSummary: '' })).toBe(false)
    expect(validateD3Output({ ...valid, fixSummary: '  ' })).toBe(false)
  })

  it('rejects non-string in filesChanged', () => {
    expect(validateD3Output({ ...valid, filesChanged: [42] })).toBe(false)
    expect(validateD3Output({ ...valid, filesChanged: [null] })).toBe(false)
  })

  it('rejects non-array filesChanged', () => {
    expect(validateD3Output({ ...valid, filesChanged: 'file.ts' })).toBe(false)
  })

  it('rejects null', () => {
    expect(validateD3Output(null)).toBe(false)
  })
})

// ── D4 ────────────────────────────────────────────────────────────────────────

describe('validateD4Output', () => {
  it('accepts valid D4Output', () => {
    expect(validateD4Output({ reproNowGreen: true, suiteGreen: true, rounds: 1 })).toBe(true)
    expect(validateD4Output({ reproNowGreen: false, suiteGreen: false, rounds: 3 })).toBe(true)
  })

  it('rejects rounds < 1', () => {
    expect(validateD4Output({ reproNowGreen: true, suiteGreen: true, rounds: 0 })).toBe(false)
    expect(validateD4Output({ reproNowGreen: true, suiteGreen: true, rounds: -1 })).toBe(false)
  })

  it('rejects non-boolean reproNowGreen', () => {
    expect(validateD4Output({ reproNowGreen: 'true', suiteGreen: true, rounds: 1 })).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(validateD4Output({ suiteGreen: true, rounds: 1 })).toBe(false)
    expect(validateD4Output({ reproNowGreen: true, rounds: 1 })).toBe(false)
    expect(validateD4Output({ reproNowGreen: true, suiteGreen: true })).toBe(false)
  })

  it('rejects null', () => {
    expect(validateD4Output(null)).toBe(false)
  })
})

// ── D5 ────────────────────────────────────────────────────────────────────────

describe('validateD5Output', () => {
  it('accepts valid D5Output', () => {
    expect(validateD5Output({ commitSha: 'abc1234', pushResult: 'pushed to origin/main' })).toBe(true)
  })

  it('rejects empty commitSha', () => {
    expect(validateD5Output({ commitSha: '', pushResult: 'pushed' })).toBe(false)
    expect(validateD5Output({ commitSha: '  ', pushResult: 'pushed' })).toBe(false)
  })

  it('rejects empty pushResult', () => {
    expect(validateD5Output({ commitSha: 'abc', pushResult: '' })).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(validateD5Output({ commitSha: 'abc' })).toBe(false)
    expect(validateD5Output({ pushResult: 'pushed' })).toBe(false)
  })

  it('rejects null', () => {
    expect(validateD5Output(null)).toBe(false)
  })
})
