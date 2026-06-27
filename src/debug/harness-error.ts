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
// NOTE: deliberately does NOT include bare `error: cannot` or `import.*error` —
// those over-match the most common REAL failures a debug fix targets (e.g.
// `TypeError: Cannot read properties of undefined`, `Error: Cannot connect to DB`),
// which would misroute a genuinely still-RED repro into "harness broken". The
// specific module/name/import-resolution patterns below cover real harness breakage.
const HARNESS_ERROR_PATTERN =
  /no test (suite )?found|does not provide an export|failed to resolve import|transform failed|ts\d{4,}:|cannot find name|cannot find module|failed to load|syntaxerror|enoent/i

/**
 * Returns true when `output` contains a harness-level error that prevented the
 * test suite from being collected or run.  Does NOT indicate whether tests
 * passed or failed — a true result means "we cannot tell".
 */
export function isHarnessError(output: string): boolean {
  return HARNESS_ERROR_PATTERN.test(output)
}
