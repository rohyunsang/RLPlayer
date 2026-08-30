import type { SettingDescriptor, SettingId, SettingSection, SettingType } from './feature-api'

/**
 * The generated settings form's WIRE TYPE, and the pure functions that build it.
 *
 * WHY THIS FILE EXISTS — two defects, one cause.
 *
 * 1. `SettingRow` was declared TWICE: `src/main/ipc.ts:119` and
 *    `src/renderer/src/core/settings-form.ts:48`. Same shape, two files, on
 *    opposite sides of an IPC boundary, with NOTHING checking that they agreed.
 *    A module's main and renderer halves share no compilation unit
 *    (`tsconfig.web.json` excludes `src/main`, `tsconfig.node.json` excludes
 *    `src/renderer`), so this is the shape every one of the 38 Wave-1 modules
 *    would have copied — and core had already copied it. `src/shared` IS in both
 *    configs, so a wire type belongs here and the compiler checks both ends.
 *
 * 2. `visibleWhen` landed in two shared files with ZERO tests:
 *    `grep -rln visibleWhen src --include=*.test.ts` was empty against a
 *    395-test suite, and the only evidence it worked was one hand-driven
 *    "35 rows -> 24". It could not be tested where it was, because both halves
 *    lived in files that import Electron. It is pure now, and
 *    `settings-rows.test.ts` covers the throwing predicate, the missing
 *    predicate, chained predicates and the `false`-vs-falsy distinction.
 *
 * Nothing here imports Electron, the DOM, or `node:*`. That is the point.
 */

export interface SettingRow {
  id: string
  section: SettingSection
  group?: string
  label: string
  description?: string
  type: SettingType
  value: unknown
  default: unknown
  mpvOption?: string
  requiresRestart?: boolean
  advanced?: boolean
  order?: number
  keywords?: readonly string[]
  /**
   * `false` when the descriptor's `visibleWhen` predicate says this row does not
   * apply right now.
   *
   * Evaluated in MAIN and shipped as a boolean, because `visibleWhen` is a
   * FUNCTION and a function cannot cross the snapshot IPC. That is why the field
   * sat in the public API with no consumer at all while three Wave-1 modules
   * reached for it: M03 shipped fourteen descriptors using it and every one of
   * them rendered unconditionally.
   *
   * Absent means visible. Only the literal `false` hides a row, so a descriptor
   * that predates the field is unaffected.
   */
  visible?: boolean
}

/** Resolve a message key. Injected so this file needs no i18n import. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Read a setting's current value. Injected for the same reason. */
export type ReadSetting = <V>(id: SettingId) => V

/**
 * Evaluate a descriptor's `visibleWhen`.
 *
 * A predicate that THROWS hides nothing (§3.5 rule 7): one module's bad
 * predicate must not blank a page every other module also renders into, and the
 * safe direction for a hidden-row rule is to show the row. A visible row the
 * user did not expect is confusing; an invisible row is a setting they cannot
 * reach and cannot report.
 *
 * `!== false` rather than a truthiness test, deliberately: a predicate that
 * returns `undefined` — a `get()` of a setting that has not been defined yet,
 * which happens whenever module load order puts the reader before the writer —
 * must not silently hide the row.
 */
export function rowVisible(d: SettingDescriptor, get: ReadSetting): boolean {
  if (d.visibleWhen === undefined) return true
  try {
    return d.visibleWhen(get) !== false
  } catch (e) {
    console.error(`[settings] visibleWhen for '${d.id}' threw:`, (e as Error).message)
    return true
  }
}

/**
 * One descriptor plus its value, as the settings window receives it.
 *
 * Optional fields are OMITTED rather than set to undefined: the row crosses
 * Electron's structured clone, and `exactOptionalPropertyTypes` on the renderer
 * side distinguishes "absent" from "present and undefined".
 */
export function toRow(
  d: SettingDescriptor,
  value: unknown,
  t: Translate,
  visible = true
): SettingRow {
  const row: SettingRow = {
    id: d.id,
    section: d.section,
    label: t(d.labelKey),
    type: d.type,
    value,
    default: d.default
  }
  if (d.group !== undefined) row.group = d.group
  if (d.descriptionKey !== undefined) row.description = t(d.descriptionKey)
  if (d.mpvOption !== undefined) row.mpvOption = d.mpvOption
  if (d.requiresRestart !== undefined) row.requiresRestart = d.requiresRestart
  if (d.advanced !== undefined) row.advanced = d.advanced
  if (d.order !== undefined) row.order = d.order
  if (d.keywords !== undefined) row.keywords = d.keywords
  if (!visible) row.visible = false
  return row
}

/** The whole form, in one call, so main's IPC handler holds no policy. */
export function buildSettingRows(
  snapshot: ReadonlyArray<{ descriptor: SettingDescriptor; value: unknown }>,
  get: ReadSetting,
  t: Translate
): SettingRow[] {
  return snapshot.map(({ descriptor, value }) =>
    toRow(descriptor, value, t, rowVisible(descriptor, get))
  )
}
