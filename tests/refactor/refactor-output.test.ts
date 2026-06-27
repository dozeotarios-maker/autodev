// Stage D: Unit tests for refactor-output validators.
// Mirrors tests/debug/debug-output.test.ts patterns.

import { describe, it, expect } from 'vitest'
import {
  validateR1Output,
  validateR2Output,
  validateR3Output,
  validateR4Output,
  ALLOWED_BINARIES,
  MAX_REFACTOR_ROUNDS,
} from '../../src/refactor/refactor-output.js'

describe('validateR1Output', () => {
  it('accepts valid R1 output with new characterization file', () => {
    expect(validateR1Output({
      characterizationSummary: 'Pins the auth token validation behavior',
      characterizationCommand: 'npx vitest run tests/refactor/char-auth.test.ts',
      characterizationArtifact: 'tests/refactor/char-auth.test.ts',
      coversExisting: false,
    })).toBe(true)
  })

  it('accepts coversExisting=true (existing tests)', () => {
    expect(validateR1Output({
      characterizationSummary: 'Existing tests already cover the behavior',
      characterizationCommand: 'npx vitest run tests/auth.test.ts',
      characterizationArtifact: 'tests/auth.test.ts',
      coversExisting: true,
    })).toBe(true)
  })

  it('rejects missing characterizationSummary', () => {
    expect(validateR1Output({
      characterizationCommand: 'npx vitest run tests/char.test.ts',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects empty characterizationSummary', () => {
    expect(validateR1Output({
      characterizationSummary: '   ',
      characterizationCommand: 'npx vitest run tests/char.test.ts',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects missing characterizationCommand', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects missing characterizationArtifact', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects missing coversExisting (not boolean)', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run tests/char.test.ts',
      characterizationArtifact: 'tests/char.test.ts',
    })).toBe(false)
  })

  it('rejects non-ALLOWED_BINARIES first token', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'bash tests/run.sh',
      characterizationArtifact: 'tests/run.sh',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects shell metacharacter ; in command', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run tests/char.test.ts; rm -rf /',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects shell metacharacter | in command', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run tests/char.test.ts | cat',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects shell metacharacter & in command', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run tests/char.test.ts &',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects shell metacharacter $( in command', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run $(echo tests/char.test.ts)',
      characterizationArtifact: 'tests/char.test.ts',
      coversExisting: false,
    })).toBe(false)
  })

  it('rejects artifact with no path separator and no extension', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run myfile',
      characterizationArtifact: 'myfile',
      coversExisting: false,
    })).toBe(false)
  })

  it('accepts artifact with extension but no slash', () => {
    expect(validateR1Output({
      characterizationSummary: 'summary',
      characterizationCommand: 'npx vitest run char.test.ts',
      characterizationArtifact: 'char.test.ts',
      coversExisting: false,
    })).toBe(true)
  })

  it('accepts all ALLOWED_BINARIES as first token', () => {
    for (const bin of ALLOWED_BINARIES) {
      expect(validateR1Output({
        characterizationSummary: 'summary',
        characterizationCommand: `${bin} vitest run tests/char.test.ts`,
        characterizationArtifact: 'tests/char.test.ts',
        coversExisting: false,
      })).toBe(true)
    }
  })

  it('rejects null / non-object', () => {
    expect(validateR1Output(null)).toBe(false)
    expect(validateR1Output('string')).toBe(false)
    expect(validateR1Output(42)).toBe(false)
  })
})

describe('validateR2Output', () => {
  it('accepts valid R2 output', () => {
    expect(validateR2Output({
      transformSummary: 'Extracted auth module into a separate file',
      filesChanged: ['src/auth/index.ts', 'src/auth/validate.ts'],
    })).toBe(true)
  })

  it('accepts empty filesChanged array', () => {
    expect(validateR2Output({
      transformSummary: 'Transform summary',
      filesChanged: [],
    })).toBe(true)
  })

  it('rejects missing transformSummary', () => {
    expect(validateR2Output({
      filesChanged: ['src/auth.ts'],
    })).toBe(false)
  })

  it('rejects empty transformSummary', () => {
    expect(validateR2Output({
      transformSummary: '  ',
      filesChanged: ['src/auth.ts'],
    })).toBe(false)
  })

  it('rejects missing filesChanged', () => {
    expect(validateR2Output({
      transformSummary: 'summary',
    })).toBe(false)
  })

  it('rejects non-string item in filesChanged', () => {
    expect(validateR2Output({
      transformSummary: 'summary',
      filesChanged: ['src/auth.ts', 42],
    })).toBe(false)
  })

  it('rejects null / non-object', () => {
    expect(validateR2Output(null)).toBe(false)
    expect(validateR2Output(undefined)).toBe(false)
  })
})

describe('validateR3Output', () => {
  it('accepts valid R3 output — both green', () => {
    expect(validateR3Output({
      characterizationStillGreen: true,
      suiteGreen: true,
      rounds: 1,
    })).toBe(true)
  })

  it('accepts characterizationStillGreen=false (behavior changed scenario)', () => {
    expect(validateR3Output({
      characterizationStillGreen: false,
      suiteGreen: false,
      rounds: 1,
    })).toBe(true)
  })

  it('rejects missing characterizationStillGreen', () => {
    expect(validateR3Output({
      suiteGreen: true,
      rounds: 1,
    })).toBe(false)
  })

  it('rejects missing suiteGreen', () => {
    expect(validateR3Output({
      characterizationStillGreen: true,
      rounds: 1,
    })).toBe(false)
  })

  it('rejects rounds < 1', () => {
    expect(validateR3Output({
      characterizationStillGreen: true,
      suiteGreen: true,
      rounds: 0,
    })).toBe(false)
  })

  it('rejects non-number rounds', () => {
    expect(validateR3Output({
      characterizationStillGreen: true,
      suiteGreen: true,
      rounds: 'one',
    })).toBe(false)
  })

  it('rejects null / non-object', () => {
    expect(validateR3Output(null)).toBe(false)
  })
})

describe('validateR4Output', () => {
  it('accepts valid R4 output', () => {
    expect(validateR4Output({
      commitSha: 'abc1234def',
      pushResult: 'pushed to origin/main',
    })).toBe(true)
  })

  it('rejects missing commitSha', () => {
    expect(validateR4Output({
      pushResult: 'pushed to origin/main',
    })).toBe(false)
  })

  it('rejects empty commitSha', () => {
    expect(validateR4Output({
      commitSha: '   ',
      pushResult: 'pushed to origin/main',
    })).toBe(false)
  })

  it('rejects missing pushResult', () => {
    expect(validateR4Output({
      commitSha: 'abc1234def',
    })).toBe(false)
  })

  it('rejects empty pushResult', () => {
    expect(validateR4Output({
      commitSha: 'abc1234def',
      pushResult: '',
    })).toBe(false)
  })

  it('rejects null / non-object', () => {
    expect(validateR4Output(null)).toBe(false)
  })
})

describe('constants', () => {
  it('ALLOWED_BINARIES contains expected set', () => {
    expect(ALLOWED_BINARIES.has('npx')).toBe(true)
    expect(ALLOWED_BINARIES.has('vitest')).toBe(true)
    expect(ALLOWED_BINARIES.has('npm')).toBe(true)
    expect(ALLOWED_BINARIES.has('bash')).toBe(false)
    expect(ALLOWED_BINARIES.has('sh')).toBe(false)
  })

  it('MAX_REFACTOR_ROUNDS is 2', () => {
    expect(MAX_REFACTOR_ROUNDS).toBe(2)
  })
})
