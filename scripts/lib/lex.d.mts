/**
 * Types for `scripts/lib/lex.mjs`, so the source-shaped guarantees in
 * `src/**\/*.test.ts` can reuse the repo's ONE comment/string lexer instead of
 * each re-inventing a regex over raw text.
 *
 * That re-invention is not hypothetical: `src/main/core/mpv/engine.test.ts`
 * matched `/resolveMpvPath|mpv\/manager|mpv\/client/` against raw file text and
 * red-lighted three Wave-1 modules whose only "use" was a file:line citation in
 * a comment. `check-partition.mjs` had already fixed the same defect once and
 * `check-forbidden.mjs` had already been given this lexer for it; the test had
 * no way to reach it from TypeScript, so it grew its own weaker rule.
 */
export declare function lex(text: string): {
  /** Comments blanked, string CONTENTS kept. Import specifiers survive. */
  code: string
  /** Comments AND string contents blanked. Identifier rules run here. */
  bare: string
  /** The inverse of `bare`: everything outside a string literal is blanked. */
  strings: string
  /** 1-based line number for an index into any of the three views. */
  lineAt: (i: number) => number
}
