// C-1: Shared harness-error classifier.
// Used by D1 gate and D4 gate to distinguish a broken test harness
// (import error, no tests found, transform failure, TS error) from a
// real assertion failure (which indicates the repro/fix is genuinely failing).

/**
 * Pattern matching harness-level failures that prevent the test from running at all.
 * These are NOT assertion failures — the test suite couldn't even be collected.
 *
 * Covers (case-insensitive):
 *   - vitest/jest "no test suite found" variants
 *   - ESM/CJS re-export errors
 *   - Vite import resolution failures
 *   - Vite/esbuild transform errors
 *   - TypeScript compiler errors (TS1234 style)
 *   - "cannot find name" (tsc/ts-node inline errors)
 *   - Classic Node module-not-found
 *   - Vite/esbuild ENOENT
 */
const HARNESS_ERROR_PATTERN =
  /no test (suite )?found|does not provide an export|failed to resolve import|transform failed|ts\d{4,}:|cannot find name|cannot find module|failed to load|error: cannot|import.*error|syntaxerror|enoent/i

/**
 * Returns true when `output` contains a harness-level error that prevented the
 * test suite from being collected or run.  Does NOT indicate whether tests
 * passed or failed — a true result means "we cannot tell".
 */
export function isHarnessError(output: string): boolean {
  return HARNESS_ERROR_PATTERN.test(output)
}
