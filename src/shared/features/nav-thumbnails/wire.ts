/**
 * M27 nav-thumbnails — the types that cross the module's OWN IPC boundary.
 *
 * WHY THIS DIRECTORY EXISTS AT ALL. A module's main and renderer halves share no
 * compilation unit: `tsconfig.web.json` excludes `src/main`, `tsconfig.node.json`
 * excludes `src/renderer`. So a module that sends a payload from one half to the
 * other has to declare its shape TWICE, and nothing compares the two. Measured
 * across the four pilots, five wire types were hand-duplicated across the halves:
 *
 *   nav-thumbnails  ThumbStatus
 *   nav-bookmarks   Bookmark, BookmarkPanelState
 *   audio-eq        EqState, PresetWire
 *
 * and core had made the same mistake with `SettingRow`. Adding a field to one
 * side and forgetting the other is a silent `undefined` on the wire, not a type
 * error — for exactly as long as it takes someone to notice.
 *
 * `src/shared/**` is in BOTH tsconfigs, so `src/shared/features/<module-id>/` is
 * the one place a module can put a type that both of its halves check. It is
 * OWNED BY THE MODULE (`ownedFiles` in modules.json), like the other two
 * directories, so `src/shared` being "core's" now has exactly one exception and
 * it is per-module and enforced by `check:partition`. A module may import only
 * its OWN `shared/features/<id>/`; `check:forbidden` rejects reaching into
 * another module's.
 *
 * KEEP IT WIRE-ONLY. It is compiled with `types: []` under the web config and
 * with `lib: ["ES2022"]` under the node config, so no DOM, no `node:*`, no
 * Electron, and no runtime behaviour that wants to live on one side.
 */

/**
 * What the main half tells the overlay about the thumbnailer, on every file load
 * and whenever the second mpv comes or goes.
 */
export interface ThumbStatus {
  readonly enabled: boolean
  readonly available: boolean
  readonly width: number
  readonly height: number
  /** Seconds per cache bucket, so the overlay asks once per bucket, not per px. */
  readonly stepSec: number
}

/**
 * One decoded preview frame.
 *
 * `rgba` is already byte-swapped by the main half: mpv writes the platform's
 * BGRA order and `ImageData` reads RGBA (§2.6 N36). Doing it in main keeps the
 * swap on the side that knows which order it got.
 */
export interface ThumbFrame {
  readonly key: string
  readonly time: number
  readonly width: number
  readonly height: number
  /** False for the fast keyframe seek, true for the settled exact one. */
  readonly exact: boolean
  readonly rgba: Uint8Array
}
