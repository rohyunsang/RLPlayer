/**
 * Types for `scripts/lib/ordering.mjs`, so the ordering guarantee in
 * `src/renderer/src/core/feature-host.test.ts` runs the SAME reader
 * `npm run check:ordering` runs, rather than growing its own weaker rule.
 *
 * That is the mistake this file exists to prevent, and it has been made twice in
 * this repository already: `engine.test.ts` re-invented a raw-text regex because
 * `scripts/lib/lex.mjs` was unreachable from TypeScript, and the ordering test
 * re-invented an `id:`-to-`order:` window because nothing else could read a
 * contribution. One reader, two callers.
 */

export interface OrderingNamespace {
  readonly ns: string
  readonly call: string
  /** false for a BAND (spawn-arg priority): ties are legal and deterministic. */
  readonly unique: boolean
  readonly positional?: boolean
  readonly scopeKey: string | null
  readonly host: string
  readonly what: string
}

export interface OrderingClaim {
  readonly ns: string
  /** null for a band claim, which is keyed by (namespace, owning row, order). */
  readonly id: string | null
  readonly order: number
  readonly scope: string
  readonly file: string
  readonly line: number
}

export interface UnreadableClaim {
  readonly ns: string
  readonly file: string
  readonly line: number
  readonly why: string
}

export interface ManifestRow {
  readonly id: string
  readonly path?: string
  readonly ownedFiles?: readonly string[]
  readonly ownedOrders?: Record<
    string,
    ReadonlyArray<{ id?: string; order: number; scope?: string; tiesRoot?: string }>
  >
}

export declare const NAMESPACES: readonly OrderingNamespace[]
export declare const NAMESPACE_IDS: readonly string[]

export declare function readClaimsFromFile(
  file: string,
  text: string,
  cache?: Map<string, Map<string, number>>
): { claims: OrderingClaim[]; unresolved: UnreadableClaim[] }

export declare function scanRepoClaims(repo: string): {
  claims: OrderingClaim[]
  unresolved: UnreadableClaim[]
  fileCount: number
}

export declare function readMenuRoots(repo: string): Array<{ path: string; order: number }>

export declare function ownerOf(
  modules: readonly ManifestRow[],
  file: string
): string | null

export declare function namespaceIdOf(row: ManifestRow): string

export declare function manifestClaims(
  modules: readonly ManifestRow[]
): Array<OrderingClaim & { row: string; tiesRoot: string | null }>

export declare function checkOrdering(args: {
  modules: readonly ManifestRow[]
  codeClaims: readonly OrderingClaim[]
  unresolved?: readonly UnreadableClaim[]
  menuRoots?: ReadonlyArray<{ path: string; order: number }>
}): string[]

export declare function summarise(claims: readonly OrderingClaim[]): string[]
