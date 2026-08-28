/**
 * M29 mediainfo -- the payloads that cross this module's own IPC boundary.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A HAND-MAINTAINED DUPLICATE, AND THAT IS A REPORTED DEFECT
 * ---------------------------------------------------------------------------
 * The body below is BYTE FOR BYTE identical to
 * `src/main/features/mediainfo/wire.ts` from the first `export` down. It has to
 * be, and `wire-parity.test.ts` in the main half asserts it, because
 * `docs/parity/02-wave0-api.md` section 10's answer to this --
 * `src/shared/features/<your id>/`, compiled by BOTH tsconfigs -- is not
 * available to M29:
 *
 *   $ node -e "...modules.json... M29.ownedFiles"
 *   [ 'src/main/features/mediainfo/', 'src/renderer/src/features/mediainfo/' ]
 *
 * M12 audio-eq, M26 nav-bookmarks and M27 nav-thumbnails each have the third
 * entry; M29 does not, and `npm run check:partition` fails the build for any
 * file under `src/` no row claims. Adding one line to the M29 row deletes this
 * file and its parity test.
 *
 * Until then the guide's own measurement applies to this module too: "adding a
 * field on one side is a silent `undefined` on the wire rather than a type
 * error". The parity test is the substitute, and it compares BYTES rather than
 * shapes, because a test that compared shapes would need the two files in one
 * compilation unit -- which is the thing that does not exist.
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
