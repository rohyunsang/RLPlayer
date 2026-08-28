/**
 * M29 mediainfo -- the payloads that cross this module's own IPC boundary.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS HERE AND NOT IN `src/shared/features/mediainfo/`
 * ---------------------------------------------------------------------------
 * It should be there. docs/parity/02-wave0-api.md section 10 is explicit:
 *
 *   "Your two halves DO have a file they both compile:
 *    `src/shared/features/<your id>/`. Declare every payload that crosses your
 *    own IPC there, once. ... the directory is listed in your row's ownedFiles"
 *
 * For M29 it is NOT listed. `docs/parity/modules.json`'s M29 row owns exactly
 * two directories, `src/main/features/mediainfo/` and
 * `src/renderer/src/features/mediainfo/`, and `npm run check:partition` fails
 * the build for any file under `src/` that no row claims -- untracked files
 * included (it lists with `git ls-files --cached --others`). M12 audio-eq,
 * M26 nav-bookmarks and M27 nav-thumbnails each have the third entry; the three
 * rows that got it are the three pilots that needed it.
 *
 * So the sanctioned location is unavailable to this module without editing
 * `modules.json`, which is not this module's file. The types are therefore
 * duplicated in `src/renderer/src/features/mediainfo/wire.ts`, BYTE FOR BYTE
 * below the header -- which is precisely the defect the shared directory exists
 * to prevent ("five wire types were hand-duplicated ... adding a field on one
 * side is a silent `undefined` on the wire rather than a type error").
 *
 * Reported rather than worked around: adding `"src/shared/features/mediainfo/"`
 * to the M29 row is a one-line manifest change and this file then moves there
 * unchanged.
 *
 * Wire-only: no DOM, no `node:*`, no Electron, no behaviour.
 */

/** One `label: value` line. `labelKey` is an i18n key, `value` is display-ready. */
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

/** The three densities of U47, and the panel's own tab state. */
export type InfoDensity = 'full' | 'short' | 'misc'

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
