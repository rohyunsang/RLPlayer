/**
 * Types for `scripts/lib/module-decl.mjs`, so the manifest-vs-code tests in
 * `src/main/core/mpv/ownership.test.ts` use the repo's ONE declaration reader
 * instead of a regex over `<dir>/index.ts`.
 *
 * Same reason as `scripts/lib/lex.d.mts` and `scripts/lib/ordering.d.mts`: a
 * shared rule that TypeScript cannot reach grows a second, weaker copy inside a
 * test, and this repository has now done that three times.
 */

export declare const DECL_FIELDS: readonly string[]

export interface UnreadableDeclaration {
  /** The declaration field, e.g. `ownsProperties`. */
  readonly field: string
  /** The source text this reader refused to guess at. */
  readonly text: string
  readonly why: string
}

export interface ModuleDeclaration {
  /** The module's own `id`. */
  readonly id: string
  /** The file that default-exports it — NOT assumed to be `index.ts`. */
  readonly file: string
  /** Only the fields actually present, each a list of string literals. */
  readonly fields: Readonly<Record<string, readonly string[]>>
  /** Non-empty when a declaration is not a static array of string literals. */
  readonly unreadable: readonly UnreadableDeclaration[]
}

/** `null` when the directory has no default-exported module object. */
export declare function readModuleDeclaration(dir: string): ModuleDeclaration | null

export declare function moduleDirs(repo: string): string[]
