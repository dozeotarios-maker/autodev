// Stage E: shared minimalism + craftsmanship constants.
// Injected into every code-producing steer (MINIMALISM_DIRECTIVE, CRAFTSMANSHIP_DIRECTIVE)
// and into the P5 clean-context reviewer (MINIMALISM_REVIEW_LENS, CRAFTSMANSHIP_REVIEW_LENS).

export const MINIMALISM_DIRECTIVE =
  'MINIMALISM (hard requirement): produce the SMALLEST implementation that fully satisfies the spec and passes the tests — what is needed or explicitly asked for, nothing more. NO speculative generality, NO unused parameters/flags/abstractions, NO features not requested, NO premature optimization, NO gold-plating. Prefer the simplest data structure, the fewest files, and the standard library over new dependencies. If a line isn\'t required by a spec point or exercised by a test, don\'t write it. YAGNI + DRY.'

export const CRAFTSMANSHIP_DIRECTIVE =
  'CRAFTSMANSHIP (hard requirement): write code a senior engineer would be happy to ship — and that looks human-written, not AI-generated. MATCH the surrounding codebase\'s conventions, naming, structure, and error-handling patterns (this is the strongest signal). Names reveal intent — no data2/tmp/result3/foo/helper junk. Comments explain WHY, never restate WHAT the code already says; no step-by-step narration, no banner/decoration comment blocks. NO AI-slop tells: no preamble, no emoji, no defensive try/catch on everything, no needless abstraction layers, no over-explaining. Handle the REAL edge cases, not theoretical ones. Small focused functions, clear control flow.'

export const MINIMALISM_REVIEW_LENS =
  'MINIMALISM CHECK: flag as a finding any code not required by the spec or exercised by a test — unused exports, speculative abstractions, dead/over-broad parameters, needless configuration, premature optimization, or dependencies that stdlib/existing code already covers. Over-engineering is a defect; recommend the smaller equivalent.'

export const CRAFTSMANSHIP_REVIEW_LENS =
  'CRAFTSMANSHIP CHECK: flag code that reads as AI-generated or below senior-human standard — redundant/narrating comments, banner comment blocks, intent-hiding names (data2/tmp/foo), style that diverges from the surrounding code, needless abstraction, defensive boilerplate, or emoji. Recommend the idiomatic, style-matched rewrite.'
