// C-1 round-2 fix: isHarnessError must NOT over-match real runtime/assertion
// failures (the kind a debug fix actually targets), or D4 misroutes a still-RED
// repro into "harness broken" → abort instead of "did not converge" → retry.
import { describe, it, expect } from 'vitest'
import { isHarnessError } from '../../src/debug/harness-error.js'

describe('isHarnessError — collision cases (must be FALSE: real failures, still-RED)', () => {
  // The most common JS runtime error a debug fix targets — must NOT be read as harness breakage.
  it('TypeError: Cannot read properties of undefined → not harness', () => {
    expect(isHarnessError('TypeError: Cannot read properties of undefined (reading "x")')).toBe(false)
  })
  it('Error: Cannot connect to database → not harness', () => {
    expect(isHarnessError('Error: Cannot connect to database')).toBe(false)
  })
  it('AssertionError → not harness', () => {
    expect(isHarnessError('AssertionError: expected 1 to be 2 // Object.is equality')).toBe(false)
  })
  it('app log mentioning import and error → not harness', () => {
    expect(isHarnessError('[server] import failed somewhere in the app log, error logged')).toBe(false)
  })
  it('plain test failure output → not harness', () => {
    expect(isHarnessError('FAIL  expected true to be false')).toBe(false)
  })
})

describe('isHarnessError — real harness breakage (must be TRUE)', () => {
  it('Cannot find module', () => {
    expect(isHarnessError('Error: Cannot find module "./missing"')).toBe(true)
  })
  it('No test suite found', () => {
    expect(isHarnessError('No test suite found in file tests/x.test.ts')).toBe(true)
  })
  it('Failed to resolve import', () => {
    expect(isHarnessError('Failed to resolve import "./x" from "y.test.ts"')).toBe(true)
  })
  it('does not provide an export', () => {
    expect(isHarnessError('SyntaxError: The requested module does not provide an export named "foo"')).toBe(true)
  })
  it('TS error code', () => {
    expect(isHarnessError('TS2304: cannot find name "foo"')).toBe(true)
  })
  it('transform failed', () => {
    expect(isHarnessError('Transform failed with 1 error')).toBe(true)
  })
  it('ENOENT', () => {
    expect(isHarnessError('Error: ENOENT: no such file or directory')).toBe(true)
  })
})
