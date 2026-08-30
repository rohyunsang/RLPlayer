/**
 * Track IDENTITY, and the four properties that hold a track INDEX.
 *
 * WHY THIS FILE EXISTS. `sub-reload` renumbers mpv's track list. Measured in
 * bare mpv with our own `--sub-auto=fuzzy` spawn arg and two sibling subtitles:
 *
 *     before   1: kor.smi (selected)   2: kor_srt.srt
 *     sub-reload
 *     after    2: kor_srt.srt          3: kor.smi (selected)
 *
 * mpv re-selects the right FILE on its own. `src/main/features/subs-tracks`
 * then wrote back the sid it had captured BEFORE the reload — 1 — and mpv
 * answered `{"error":"success"}` and resolved it to `sid=false`. One press of
 * Alt+C and the Korean subtitle was gone for the rest of the file, with
 * `sub-codepage=auto` unable to bring it back because the codepage was never
 * the thing that broke.
 *
 * Two lessons are encoded here, and both are about the SHAPE rather than about
 * subtitles:
 *
 *   1. A TRACK INDEX IS NOT A TRACK. It is a position in a list mpv is free to
 *      renumber, and `sub-reload`, `audio-reload`, `video-reload`,
 *      `rescan-external-files`, `sub-add`, `sub-remove` and their audio/video
 *      twins all renumber it. Anything that has to survive one of those must be
 *      re-resolved by identity — the external filename first, because in the
 *      measured case the ORDER changed too, so even the ordinal was wrong.
 *   2. `set_property sid 1` WITH NO TRACK 1 IS A SUCCESS. mpv accepts it and
 *      holds `false`. So a write to one of these four properties is not
 *      finished until the value has been read back; see `core/mpv/bus.ts`.
 *
 * Pure: no Electron, no mpv, no `ctx`. `tracks.test.ts` runs it against the
 * real before/after track lists captured from the measured session.
 */

/** The subset of an mpv `track-list` entry that identifies a track. */
export interface TrackLike {
  id: number
  type: string
  title?: string
  lang?: string
  codec?: string
  external?: boolean
  selected?: boolean
  'external-filename'?: string
}

/**
 * The four properties that hold a track INDEX rather than a value.
 *
 * Every one of them has the same exposure: a captured number, an operation
 * that renumbers, and a write-back that mpv accepts and resolves to `false`.
 */
export const TRACK_SELECTION_PROPERTIES = ['sid', 'aid', 'vid', 'secondary-sid'] as const
export type TrackSelectionProperty = (typeof TRACK_SELECTION_PROPERTIES)[number]

export function isTrackSelectionProperty(name: string): name is TrackSelectionProperty {
  return (TRACK_SELECTION_PROPERTIES as readonly string[]).includes(name)
}

/** The track TYPE each selection property indexes into. */
export const SELECTION_TRACK_TYPE: Record<TrackSelectionProperty, string> = {
  sid: 'sub',
  'secondary-sid': 'sub',
  aid: 'audio',
  vid: 'video'
}

/**
 * The mpv commands that can renumber a track list.
 *
 * Taken from mpv's own behaviour rather than from the docs: `sub-reload` drops
 * and re-adds every external subtitle, so ids move even when the FILES do not.
 */
export const RENUMBERING_COMMANDS: readonly string[] = [
  'sub-reload',
  'audio-reload',
  'video-reload',
  'sub-add',
  'sub-remove',
  'audio-add',
  'audio-remove',
  'video-add',
  'video-remove',
  'rescan-external-files'
]

export interface TrackIdentity {
  readonly type: string
  /** The id it had when captured. Never used to re-select; kept for the log. */
  readonly capturedId: number
  readonly externalFilename: string | null
  readonly title: string | null
  readonly lang: string | null
  readonly codec: string | null
  /** 0-based position among tracks of the SAME type, in list order. */
  readonly ordinal: number
}

/** Windows paths differ in case and in slash direction between mpv replies. */
export function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

const clean = (s: string | undefined): string | null => {
  const v = (s ?? '').trim()
  return v.length > 0 ? v : null
}

export function identityOf(list: readonly TrackLike[], track: TrackLike): TrackIdentity {
  const sameType = list.filter((t) => t.type === track.type)
  const at = sameType.findIndex((t) => t.id === track.id)
  return {
    type: track.type,
    capturedId: track.id,
    externalFilename: track['external-filename']
      ? normalisePath(track['external-filename'])
      : null,
    title: clean(track.title),
    lang: clean(track.lang)?.toLowerCase() ?? null,
    codec: clean(track.codec),
    ordinal: at < 0 ? 0 : at
  }
}

/** How a track was re-found, so the log can say what the evidence was. */
export type MatchTier =
  | 'external-filename'
  | 'title+lang'
  | 'title'
  | 'lang+ordinal'
  | 'codec'
  | 'ordinal'

export interface Match {
  readonly track: TrackLike
  readonly tier: MatchTier
}

/**
 * Re-find a captured track in a list mpv may have renumbered.
 *
 * The tiers are ordered by how much they can be trusted, and the FIRST one is
 * the one that mattered in the measured case: `kor.smi` moved from id 1 to id 3
 * AND from ordinal 0 to ordinal 1, so an ordinal match would have picked
 * `kor_srt.srt` — a silently wrong subtitle, which is worse than the bug.
 *
 * `id` is deliberately NOT a tier. Matching on the captured id is precisely the
 * defect: after a renumber, id 1 is either absent (mpv resolves the write to
 * `false`) or a DIFFERENT track.
 */
export function findByIdentity(
  list: readonly TrackLike[],
  identity: TrackIdentity
): Match | null {
  const sameType = list.filter((t) => t.type === identity.type)
  if (sameType.length === 0) return null

  if (identity.externalFilename !== null) {
    const hit = sameType.find(
      (t) =>
        t['external-filename'] !== undefined &&
        normalisePath(t['external-filename']) === identity.externalFilename
    )
    if (hit) return { track: hit, tier: 'external-filename' }
    // An external track whose FILE is gone must NOT fall through to an ordinal
    // match: that silently selects somebody else's subtitle, which is a worse
    // outcome than reporting the track lost.
    return null
  }

  if (identity.title !== null && identity.lang !== null) {
    const hit = sameType.find(
      (t) => clean(t.title) === identity.title && clean(t.lang)?.toLowerCase() === identity.lang
    )
    if (hit) return { track: hit, tier: 'title+lang' }
  }
  if (identity.title !== null) {
    const hits = sameType.filter((t) => clean(t.title) === identity.title)
    if (hits.length === 1) return { track: hits[0]!, tier: 'title' }
  }
  if (identity.lang !== null) {
    const sameLang = sameType.filter((t) => clean(t.lang)?.toLowerCase() === identity.lang)
    if (sameLang.length === 1) return { track: sameLang[0]!, tier: 'lang+ordinal' }
    if (sameLang.length > 0) {
      const at = Math.min(identity.ordinal, sameLang.length - 1)
      return { track: sameLang[at]!, tier: 'lang+ordinal' }
    }
  }
  if (identity.codec !== null) {
    const sameCodec = sameType.filter((t) => clean(t.codec) === identity.codec)
    if (sameCodec.length === 1) return { track: sameCodec[0]!, tier: 'codec' }
  }
  // Embedded tracks in a container mpv did not re-demux keep their order, so an
  // ordinal is the honest last resort.
  if (sameType.length > identity.ordinal) {
    return { track: sameType[identity.ordinal]!, tier: 'ordinal' }
  }
  return null
}

/**
 * What a caller should do after an operation that may have renumbered.
 *
 * `already` is the case that made the bug invisible: mpv re-selects the right
 * file on its own after `sub-reload`, so the correct action is to write
 * NOTHING. The old code wrote a stale index over a correct selection.
 */
export type Reselection =
  | { kind: 'already'; id: number; tier: MatchTier }
  | { kind: 'write'; id: number; tier: MatchTier }
  | { kind: 'lost' }

export function planReselection(
  after: readonly TrackLike[],
  identity: TrackIdentity,
  selectedNow: number | false
): Reselection {
  const match = findByIdentity(after, identity)
  if (!match) return { kind: 'lost' }
  if (selectedNow === match.track.id) {
    return { kind: 'already', id: match.track.id, tier: match.tier }
  }
  return { kind: 'write', id: match.track.id, tier: match.tier }
}

export function describeIdentity(identity: TrackIdentity): string {
  const bits = [`${identity.type} #${identity.capturedId}`]
  if (identity.externalFilename) bits.push(identity.externalFilename)
  if (identity.title) bits.push(`"${identity.title}"`)
  if (identity.lang) bits.push(identity.lang)
  return bits.join(' · ')
}
