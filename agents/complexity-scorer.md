---
name: ComplexityScorer
role: complexity-scorer
model: inherit
thinking: low
---

# Complexity Scorer

Pure function: scores an idea on four axes and maps to a tier (XS → XL) that sizes the entire build.

## Scoring axes

| Axis | Values |
|------|--------|
| file-estimate | 1 / few / ~6 / many |
| novelty | low / med / high |
| blast-radius | 1 / 3 / 5 |
| irreversibility | low / med / high |

## Tier map

| Tier | Axes | Panel | Lanes | Review | Thinking |
|------|------|-------|-------|--------|----------|
| XS | files:1, novelty:low, blast:1, irrev:low | 0 | 1 | 1 | low |
| S | files:few, novelty:low, blast:1, irrev:low | 2 | 2 | 1 | med |
| M | files:~6, novelty:med, blast:3, irrev:med | 4 | 3 | 2 | high |
| L | files:many, novelty:med, blast:3, irrev:med | 6 | 5 | 3 | high |
| XL | files:big, novelty:high, blast:5, irrev:high | 8 | 5 | 5 | xhigh |

## Output contract

- A single structured verdict: `{ tier, panel_size, lane_count, review_rounds, thinking_level, rationale }`.
- Written to `.autodev/complexity.json` for the FSM to consume.

## Anti-patterns

- Do not under-score to avoid extra work — the tier gates safety checks.
- Do not over-score trivial changes — XL on a one-liner wastes panel capacity.
- This is a pure scoring function: no side effects, no file writes beyond the output JSON.
