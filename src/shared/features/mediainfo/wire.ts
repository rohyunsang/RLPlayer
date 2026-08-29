/**
 * M29 mediainfo -- the payloads that cross this module's own IPC boundary,
 * DECLARED ONCE.
 *
 * It used to live in `src/main/features/mediainfo/wire.ts` with a BYTE-FOR-BYTE
 * copy in `src/renderer/src/features/mediainfo/wire.ts` and a
 * `wire-parity.test.ts` comparing the two, because §10's sanctioned location --
 * `src/shared/features/<id>/`, "listed in your row's ownedFiles" -- was listed
 * for only 3 of the 40 feature rows, and adding it to M29's row is a manifest
 * edit a module may not make. Seven modules independently reported the same
 * wall; M23 wrote the same paragraph one directory over.
 *
 * All 40 rows carry the directory now, so the copy and its parity test are gone
 * and the COMPILER is what keeps the two halves equal -- which is the difference
 * between "adding a field on one side is a type error" and "adding a field on
 * one side is a silent `undefined` on the wire".
 */

export interface InfoRow {
  labelKey: string
  value: string
}

/**
 * A titled block of rows.
 *
 * `id` is stable and is what the renderer's stats sections select on, so the
 * three surfaces (panel, stats overlay, clipboard report) project one snapshot
 * instead of each rebuilding it. U47 calls that out as the reason the tiered
 * view is cheap: "it is a projection of data M29 already has".
 */
export interface InfoGroup {
  id: InfoGroupId
  titleKey: string
  rows: InfoRow[]
}

export type InfoGroupId =
  | 'general'
  | 'video'
  | 'audio'
  | 'subs'
  | 'pipeline'
  | 'frames'
  | 'stream'
  | 'tags'
  | 'chapters'

/** L24: one row per track, with the container's own claims underneath. */
export interface TrackRow {
  /** mpv's `track-list/N/id`, i.e. the id `aid`/`vid`/`sid` take. */
  id: number
  type: string
  selected: boolean
  external: boolean
  /** The one-line summary shown collapsed. */
  summary: string
  /**
   * The expanded detail. L24: `demux-*` values are container CLAIMS ("Not always
   * accurate"), so these rows are labelled as declared and the selected track's
   * real values come from `video-params`/`audio-params` in the video/audio group.
   */
  detail: InfoRow[]
}

/** The three densities of U47. */
export type InfoDensity = 'full' | 'short' | 'misc'

/**
 * The panel's three tabs.
 *
 * `properties` is L26's view. It is a TAB and not the second BrowserWindow the
 * row asks for, because `new BrowserWindow` in a feature module is a hard
 * `check:forbidden` failure and `WindowService` has no "open a window of my
 * own" -- see the header of `properties.ts`.
 */
export type InfoTab = 'info' | 'tracks' | 'properties'

export interface FileProperties {
  path: string
  filename: string
  directory: string
  sizeBytes: number | null
  createdMs: number | null
  modifiedMs: number | null
  rows: InfoRow[]
}

export interface MediaInfoState {
  /** Panel visibility, owned by the main half like every other panel here. */
  open: boolean
  density: InfoDensity
  tab: InfoTab
  /** False while idle: nothing is loaded, so the panel shows its empty state. */
  available: boolean
  path: string | null
  filename: string
  title: string
  /** True only when `demuxer-via-network` is true (R34 renders on this). */
  network: boolean
  groups: InfoGroup[]
  /** U47's six-line glance view. */
  short: InfoRow[]
  /** U47's misc view: cache, dropped frames, vo, hwdec, measured fps. */
  misc: InfoRow[]
  tracks: TrackRow[]
  /** L26, present once the properties view has been opened for this file. */
  properties: FileProperties | null
  /** L28/L29: a `file://` URL for sidecar cover art, or null. */
  artUrl: string | null
  /** L28: mpv reports an `albumart` or `image` track for this file. */
  hasEmbeddedArt: boolean
  updatedAt: number
}

/** L21/L40: what a non-playing file's probe answers with. */
export interface ProbeSummary {
  path: string
  ok: boolean
  /** Set when `ok` is false: 'timeout' | 'error' | 'disabled' | 'unsupported'. */
  reason?: string
  durationSec: number | null
  sizeBytes: number | null
  modifiedMs: number | null
  container: string | null
  title: string | null
  videoCount: number
  audioCount: number
  subCount: number
  /** The one-line tooltip text L40 renders. Built here so M28 renders a string. */
  tooltip: string
  rows: InfoRow[]
}
