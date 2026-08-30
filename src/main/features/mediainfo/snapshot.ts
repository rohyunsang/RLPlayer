/**
 * M29 mediainfo -- the render model, built from raw mpv property values.
 *
 * This is the whole of L23/L24/A45/V55/N26/R34/U47's logic, and it is a PURE
 * FUNCTION of a `Record<string, unknown>`: no `ctx`, no Electron, no DOM, no
 * clock. `index.ts` collects property values, this file turns them into the
 * groups the panel, the stats sections and the clipboard report all project
 * from, and `snapshot.test.ts` drives it with the property shapes the spec
 * records for the sample files.
 *
 * ---------------------------------------------------------------------------
 * ONE SNAPSHOT, THREE SURFACES
 * ---------------------------------------------------------------------------
 * U47: "Cheap because it is a projection of data M29 already has". So the panel
 * (L23), the stats sections (V55, A45, N26, R34) and `renderInfoAsText` (L25)
 * are three views of ONE object rather than three property readers. A field that
 * is wrong is wrong in one place, and the copy-to-clipboard output cannot drift
 * from what the user is looking at -- which is the entire point of L25, since the
 * text ends up in a bug report next to a screenshot of the panel.
 *
 * ---------------------------------------------------------------------------
 * WHICH PROPERTY NAMES, AND WHY NOT THE OBVIOUS ONES
 * ---------------------------------------------------------------------------
 * L23's trap: `video-codec`, `video-format`, `audio-codec` and
 * `audio-codec-name` are NOT in the current manual. They survive as undocumented
 * aliases (`M_PROPERTY_ALIAS("video-codec","current-tracks/video/codec-desc")`),
 * and most tutorials still use them. Nothing here reads one; the
 * `current-tracks/<type>/<field>` forms are used throughout, and A45's
 * `audio-codec-name` is read through `current-tracks/audio/codec` for the same
 * reason.
 *
 * The two fps values are BOTH shown, deliberately. `container-fps` is what the
 * container claims and the manual says it "can easily contain bogus values";
 * `estimated-vf-fps` is measured. A file where they disagree is the single most
 * common "why is playback stuttering" report, and merging them into one "FPS"
 * row throws that away.
 */
import {
  codecLabel,
  containerLabel,
  formatAspect,
  formatBitrate,
  formatBool,
  formatByteRate,
  formatBytes,
  formatChannels,
  formatDuration,
  formatFps,
  formatNumber,
  formatResolution,
  formatSampleRate,
  groupDigits,
  hwdecLabel,
  isNum,
  langLabel,
  overallBitrate,
  textOr,
  UNKNOWN
} from './format.ts'
import type { InfoGroup, InfoRow, InfoTab, MediaInfoState, TrackRow } from '@shared/features/mediainfo/wire'

export type Props = Readonly<Record<string, unknown>>

/**
 * Properties observed for the whole session.
 *
 * These change once per file (or once per reconfig) and the bus refcounts the
 * observation, so a module that wants `track-list` costs nothing extra when the
 * playlist already watches it. L23: "Observe, do not poll: VIDEO_RECONFIG fires
 * property-change for `video-params`/`dwidth`/`container-fps`/`current-vo`/
 * `track-list`; AUDIO_RECONFIG for `audio-params`/`audio-bitrate`/`current-ao`."
 */
export const STATIC_PROPERTIES: readonly string[] = [
  'idle-active',
  'path',
  'filename',
  'media-title',
  'file-format',
  'file-size',
  'duration',
  'stream-open-filename',
  'current-demuxer',
  'demuxer-via-network',
  'current-tracks/video/codec-desc',
  'current-tracks/video/codec',
  'current-tracks/video/codec-profile',
  'current-tracks/video/decoder-desc',
  'current-tracks/audio/codec-desc',
  'current-tracks/audio/codec',
  'current-tracks/audio/codec-profile',
  'current-tracks/audio/decoder-desc',
  'current-tracks/sub/codec-desc',
  'current-tracks/sub/title',
  'current-tracks/sub/lang',
  'video-params',
  'video-out-params',
  'audio-params',
  'audio-out-params',
  'container-fps',
  'hwdec-current',
  'hwdec-interop',
  'current-vo',
  'current-gpu-context',
  'current-ao',
  'track-list',
  'chapter-list',
  'metadata',
  'filtered-metadata',
  'deinterlace-active',
  'mpv-version',
  'aid',
  'vid',
  'sid'
]

/**
 * Properties read on a tick, and ONLY while somebody is looking.
 *
 * Every one of these changes continuously -- `estimated-frame-number` changes
 * every frame -- so observing them would put 60+ property-change messages a
 * second on the pipe for a panel that is closed. They are pulled with `get()`
 * on the refresh tick instead, and the tick only runs while the panel is open or
 * a stats section has asked for fields recently. Section 10's refresh contract
 * says the same thing about `poll`: "Everything stops while the panel is
 * hidden."
 */
export const LIVE_PROPERTIES: readonly string[] = [
  'time-pos',
  'estimated-vf-fps',
  'display-fps',
  'estimated-display-fps',
  'video-bitrate',
  'audio-bitrate',
  'sub-bitrate',
  'hls-bitrate',
  'frame-drop-count',
  'decoder-frame-drop-count',
  'estimated-frame-number',
  'estimated-frame-count',
  'video-frame-info',
  'cache-speed',
  'demuxer-cache-state',
  'vf',
  'af'
]

function sub(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined
  return (node as Record<string, unknown>)[key]
}

function row(labelKey: string, value: string): InfoRow {
  return { labelKey, value }
}

/** Drop rows whose value is unknown, so a panel is not a wall of dashes. */
function compact(rows: readonly (InfoRow | null)[]): InfoRow[] {
  return rows.filter((r): r is InfoRow => r !== null && r.value !== UNKNOWN)
}

const F = (name: string): string => `mediainfo.f.${name}`

// ---------------------------------------------------------------------------
// The groups
// ---------------------------------------------------------------------------

function generalGroup(p: Props): InfoGroup {
  const size = p['file-size']
  const duration = p['duration']
  const overall = overallBitrate(size, duration)
  return {
    id: 'general',
    titleKey: 'mediainfo.group.general',
    rows: compact([
      row(F('filename'), textOr(p['filename'])),
      row(F('title'), textOr(p['media-title'])),
      row(F('path'), textOr(p['path'])),
      row(F('container'), containerLabel(p['file-format'])),
      row(F('demuxer'), textOr(p['current-demuxer'])),
      row(F('duration'), formatDuration(duration)),
      row(F('size'), formatBytes(size)),
      // L23: the overall container bitrate has no property at all, so it is
      // computed here -- and the label says so, because a computed number next
      // to nine measured ones must not read as another measurement.
      overall === undefined ? null : row(F('overallBitrate'), formatBitrate(overall))
    ])
  }
}

function videoGroup(p: Props): InfoGroup {
  const vp = p['video-params']
  const w = sub(vp, 'w')
  const h = sub(vp, 'h')
  const dw = sub(vp, 'dw')
  const dh = sub(vp, 'dh')
  const scaled = isNum(w) && isNum(dw) && isNum(h) && isNum(dh) && (w !== dw || h !== dh)
  const aspectName = sub(vp, 'aspect-name')
  return {
    id: 'video',
    titleKey: 'mediainfo.group.video',
    rows: compact([
      row(
        F('videoCodec'),
        codecLabel(
          p['current-tracks/video/codec-desc'],
          p['current-tracks/video/codec'],
          p['current-tracks/video/codec-profile']
        )
      ),
      row(F('decoder'), textOr(p['current-tracks/video/decoder-desc'])),
      row(F('resolution'), formatResolution(w, h)),
      scaled ? row(F('displayResolution'), formatResolution(dw, dh)) : null,
      row(
        F('aspect'),
        typeof aspectName === 'string' && aspectName.length > 0
          ? aspectName
          : formatAspect(dw ?? w, dh ?? h)
      ),
      row(F('par'), formatNumber(sub(vp, 'par'), 4)),
      row(F('pixelFormat'), textOr(sub(vp, 'pixelformat'))),
      row(F('hwPixelFormat'), textOr(sub(vp, 'hw-pixelformat'))),
      row(F('bpp'), formatNumber(sub(vp, 'average-bpp'), 2)),
      // Both, never one: the container claim and the measured rate.
      row(F('containerFps'), formatFps(p['container-fps'])),
      row(F('measuredFps'), formatFps(p['estimated-vf-fps'])),
      row(F('videoBitrate'), formatBitrate(p['video-bitrate']))
    ])
  }
}

function audioGroup(p: Props): InfoGroup {
  const ap = p['audio-params']
  const op = p['audio-out-params']
  const sourceLayout = sub(ap, 'hr-channels') ?? sub(ap, 'channels')
  const outLayout = sub(op, 'hr-channels') ?? sub(op, 'channels')
  return {
    id: 'audio',
    titleKey: 'mediainfo.group.audio',
    rows: compact([
      row(
        F('audioCodec'),
        codecLabel(
          p['current-tracks/audio/codec-desc'],
          p['current-tracks/audio/codec'],
          p['current-tracks/audio/codec-profile']
        )
      ),
      row(F('audioDecoder'), textOr(p['current-tracks/audio/decoder-desc'])),
      /**
       * A45's whole point, and it is verified: `audio-params` and
       * `audio-out-params` DIFFER and both matter (`s16` in, `floatp` out).
       * "Showing 'source 5.1 -> output stereo' is how a user discovers the
       * downmix is happening in the wrong place."
       */
      row(F('channelsIn'), formatChannels(sub(ap, 'channel-count'), sourceLayout)),
      row(F('channelsOut'), formatChannels(sub(op, 'channel-count'), outLayout)),
      row(F('sampleRateIn'), formatSampleRate(sub(ap, 'samplerate'))),
      row(F('sampleRateOut'), formatSampleRate(sub(op, 'samplerate'))),
      row(F('formatIn'), textOr(sub(ap, 'format'))),
      row(F('formatOut'), textOr(sub(op, 'format'))),
      row(F('audioBitrate'), formatBitrate(p['audio-bitrate'])),
      row(F('ao'), textOr(p['current-ao'])),
      row(F('af'), filterChainLabel(p['af']))
    ])
  }
}

function subsGroup(p: Props): InfoGroup {
  const list = trackList(p)
  const subs = list.filter((t) => t.type === 'sub')
  const rows: InfoRow[] = []
  rows.push(row(F('subCount'), String(subs.length)))
  const current = codecLabel(p['current-tracks/sub/codec-desc'], undefined, undefined)
  if (current !== UNKNOWN) rows.push(row(F('subCodec'), current))
  const lang = langLabel(p['current-tracks/sub/lang'])
  if (lang !== UNKNOWN) rows.push(row(F('subLang'), lang))
  const title = textOr(p['current-tracks/sub/title'])
  if (title !== UNKNOWN) rows.push(row(F('subTitle'), title))
  return { id: 'subs', titleKey: 'mediainfo.group.subs', rows }
}

/**
 * V55 -- the video pipeline, contributed as a stats section.
 *
 * The four fields docs/01 and L25 both insist on (`hwdec-current`, `current-vo`,
 * `video-params/pixelformat` and `mpv-version`) are here and in the general
 * group, because "those four are what make a rendering bug report actionable".
 */
function pipelineGroup(p: Props): InfoGroup {
  const vp = p['video-params']
  return {
    id: 'pipeline',
    titleKey: 'mediainfo.group.pipeline',
    rows: compact([
      row(F('hwdec'), hwdecLabel(p['hwdec-current'], p['hwdec-interop'])),
      row(F('vo'), textOr(p['current-vo'])),
      row(F('gpuContext'), textOr(p['current-gpu-context'])),
      row(F('colorMatrix'), textOr(sub(vp, 'colormatrix'))),
      row(F('colorLevels'), textOr(sub(vp, 'colorlevels'))),
      row(F('primaries'), textOr(sub(vp, 'primaries'))),
      row(F('gammaCurve'), textOr(sub(vp, 'gamma'))),
      row(F('maxLuma'), lumaLabel(sub(vp, 'max-luma'))),
      row(F('minLuma'), lumaLabel(sub(vp, 'min-luma'))),
      row(F('maxCll'), lumaLabel(sub(vp, 'max-cll'))),
      row(F('maxFall'), lumaLabel(sub(vp, 'max-fall'))),
      row(F('stereoIn'), textOr(sub(vp, 'stereo-in'))),
      row(F('rotate'), isNum(sub(vp, 'rotate')) ? `${sub(vp, 'rotate')}°` : UNKNOWN),
      row(F('deinterlaceActive'), formatBool(p['deinterlace-active'], 'yes', 'no')),
      row(F('displayFps'), formatFps(p['display-fps'])),
      row(F('measuredDisplayFps'), formatFps(p['estimated-display-fps'])),
      row(F('vf'), filterChainLabel(p['vf'])),
      row(F('mpvVersion'), textOr(p['mpv-version']))
    ])
  }
}

function lumaLabel(v: unknown): string {
  if (!isNum(v) || v <= 0) return UNKNOWN
  return `${formatNumber(v, 2)} cd/m²`
}

/**
 * `vf` and `af` are arrays of filter nodes, not strings.
 *
 * Read-only here: M29 never writes either (they belong to `core/vf-chain` and
 * `core/af-chain`), and `ctx.vf`/`ctx.af` are not even granted to this module --
 * it declares neither `usesVideoFilters` nor `usesAudioFilters`.
 */
function filterChainLabel(v: unknown): string {
  if (!Array.isArray(v)) return typeof v === 'string' && v.length > 0 ? v : UNKNOWN
  if (v.length === 0) return UNKNOWN
  const names = v.map((n) => {
    const label = sub(n, 'label')
    const name = sub(n, 'name')
    const enabled = sub(n, 'enabled')
    const base = typeof label === 'string' && label.length > 0 ? `@${label}` : textOr(name)
    return enabled === false ? `${base}(off)` : base
  })
  return names.join(', ')
}

/**
 * N26 -- frame numbers, LABELLED AS ESTIMATES.
 *
 * The row is explicit that both properties are "computed from two unreliable
 * quantities" and says: "Label them approximate or do not show them." The label
 * key carries the tilde, and `mediainfo.showApproxFrames` turns the whole group
 * off for anyone who would rather not see a number that can be wrong.
 */
function framesGroup(p: Props): InfoGroup {
  const info = p['video-frame-info']
  const n = p['estimated-frame-number']
  const total = p['estimated-frame-count']
  return {
    id: 'frames',
    titleKey: 'mediainfo.group.frames',
    rows: compact([
      isNum(n) && isNum(total)
        ? row(F('frameApprox'), `${groupDigits(n)} / ${groupDigits(total)}`)
        : isNum(n)
          ? row(F('frameApprox'), groupDigits(n))
          : null,
      row(F('pictureType'), textOr(sub(info, 'picture-type'))),
      row(F('interlaced'), formatBool(sub(info, 'interlaced'), 'yes', 'no')),
      row(F('repeat'), formatBool(sub(info, 'repeat'), 'yes', 'no')),
      // V55 flags these two as not individually verified against the binary, so
      // they are shown only when mpv actually answers with a number.
      row(F('framesDropped'), isNum(p['frame-drop-count']) ? groupDigits(p['frame-drop-count'] as number) : UNKNOWN),
      row(
        F('decoderFramesDropped'),
        isNum(p['decoder-frame-drop-count'])
          ? groupDigits(p['decoder-frame-drop-count'] as number)
          : UNKNOWN
      )
    ])
  }
}

/**
 * R34 -- rendered ONLY when `demuxer-via-network` is true, and `path` and
 * `stream-open-filename` side by side, because "the difference between what the
 * user typed and what mpv actually opened is the first thing you need in any
 * yt-dlp bug report".
 */
function streamGroup(p: Props): InfoGroup {
  const cache = p['demuxer-cache-state']
  return {
    id: 'stream',
    titleKey: 'mediainfo.group.stream',
    rows: compact([
      row(F('requestedUrl'), textOr(p['path'])),
      row(F('openedUrl'), textOr(p['stream-open-filename'])),
      row(F('demuxer'), textOr(p['current-demuxer'])),
      row(F('hlsBitrate'), formatBitrate(p['hls-bitrate'])),
      row(F('videoBitrate'), formatBitrate(p['video-bitrate'])),
      row(F('audioBitrate'), formatBitrate(p['audio-bitrate'])),
      row(F('subBitrate'), formatBitrate(p['sub-bitrate'])),
      row(F('rawInputRate'), formatByteRate(sub(cache, 'raw-input-rate'))),
      row(F('cacheSpeed'), formatByteRate(p['cache-speed'])),
      row(F('cacheDuration'), formatDuration(sub(cache, 'cache-duration')))
    ])
  }
}

/**
 * Tags. `filtered-metadata` when mpv offers it, `metadata` otherwise.
 *
 * The label of a tag row is the TAG NAME, not an i18n key -- `t()` returns its
 * argument for an unknown key, which is exactly the behaviour wanted here: a
 * container can carry any tag at all and inventing keys for `MusicBrainz Album
 * Artist Id` is not a translation problem.
 */
const TAG_PREFERENCE = [
  'title',
  'artist',
  'album_artist',
  'album',
  'track',
  'date',
  'genre',
  'composer',
  'comment',
  'description',
  'encoder',
  'creation_time'
]
const MAX_TAG_ROWS = 40

function tagsGroup(p: Props): InfoGroup {
  const source = (p['filtered-metadata'] ?? p['metadata']) as unknown
  const rows: InfoRow[] = []
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const entries = Object.entries(source as Record<string, unknown>)
    const score = (k: string): number => {
      const i = TAG_PREFERENCE.indexOf(k.toLowerCase())
      return i < 0 ? TAG_PREFERENCE.length : i
    }
    entries.sort((a, b) => score(a[0]) - score(b[0]))
    for (const [k, v] of entries.slice(0, MAX_TAG_ROWS)) {
      const value = textOr(v)
      if (value !== UNKNOWN) rows.push(row(k, value))
    }
    if (entries.length > MAX_TAG_ROWS) {
      rows.push(row(F('tagsTruncated'), String(entries.length - MAX_TAG_ROWS)))
    }
  }
  return { id: 'tags', titleKey: 'mediainfo.group.tags', rows }
}

function chaptersGroup(p: Props): InfoGroup {
  const list = Array.isArray(p['chapter-list']) ? (p['chapter-list'] as unknown[]) : []
  const rows: InfoRow[] = list.slice(0, 200).map((c, i) => {
    const title = textOr(sub(c, 'title'))
    return row(`${i + 1}. ${title === UNKNOWN ? '' : title}`.trim(), formatDuration(sub(c, 'time')))
  })
  return { id: 'chapters', titleKey: 'mediainfo.group.chapters', rows }
}

// ---------------------------------------------------------------------------
// L24 -- the track list
// ---------------------------------------------------------------------------

function trackList(p: Props): Array<Record<string, unknown>> {
  const list = p['track-list']
  if (!Array.isArray(list)) return []
  return list.filter(
    (t): t is Record<string, unknown> => t !== null && typeof t === 'object' && !Array.isArray(t)
  )
}

/**
 * L24, in one property read: "one call:
 * `{"command":["get_property","track-list"]}`".
 *
 * Every `demux-*` row is labelled as a container claim, per the row's own
 * instruction to "label the column 'as declared by the container'".
 */
export function buildTracks(p: Props): TrackRow[] {
  return trackList(p).map((t) => {
    const type = textOr(t['type'])
    const id = isNum(t['id']) ? (t['id'] as number) : -1
    const flags: string[] = []
    if (t['default'] === true) flags.push('default')
    if (t['forced'] === true) flags.push('forced')
    if (t['external'] === true) flags.push('external')
    if (t['albumart'] === true) flags.push('albumart')
    if (t['image'] === true) flags.push('image')
    if (t['hearing-impaired'] === true) flags.push('SDH')
    if (t['visual-impaired'] === true) flags.push('AD')
    if (t['dependent'] === true) flags.push('dependent')

    const lang = langLabel(t['lang'])
    const title = textOr(t['title'])
    const codec = codecLabel(t['codec-desc'], t['codec'], t['codec-profile'])
    const geometry =
      type === 'video'
        ? formatResolution(t['demux-w'], t['demux-h'])
        : type === 'audio'
          ? formatChannels(t['demux-channel-count'], t['demux-channels'])
          : UNKNOWN

    const summaryParts = [
      `#${id}`,
      lang === UNKNOWN ? null : lang,
      title === UNKNOWN ? null : title,
      codec === UNKNOWN ? null : codec,
      geometry === UNKNOWN ? null : geometry,
      flags.length > 0 ? `[${flags.join(' ')}]` : null
    ].filter((s): s is string => s !== null)

    return {
      id,
      type,
      selected: t['selected'] === true,
      external: t['external'] === true,
      summary: summaryParts.join(' · '),
      detail: compact([
        row(F('trackCodec'), codec),
        row(F('trackDecoder'), textOr(t['decoder-desc'])),
        row(F('trackFormatName'), textOr(t['format-name'])),
        row(F('trackLang'), lang),
        row(F('trackTitle'), title),
        row(F('trackDemuxRes'), formatResolution(t['demux-w'], t['demux-h'])),
        row(F('trackDemuxFps'), formatFps(t['demux-fps'])),
        row(F('trackDemuxBitrate'), formatBitrate(t['demux-bitrate'])),
        row(F('trackDemuxChannels'), formatChannels(t['demux-channel-count'], t['demux-channels'])),
        row(F('trackDemuxSampleRate'), formatSampleRate(t['demux-samplerate'])),
        row(F('trackDemuxDuration'), formatDuration(t['demux-duration'])),
        row(F('trackDemuxRotation'), isNum(t['demux-rotation']) ? `${t['demux-rotation']}°` : UNKNOWN),
        row(F('trackDemuxPar'), formatNumber(t['demux-par'], 4)),
        row(F('trackHlsBitrate'), formatBitrate(t['hls-bitrate'])),
        row(F('trackReplayGainTrack'), formatNumber(t['replaygain-track-gain'], 2)),
        row(F('trackReplayGainAlbum'), formatNumber(t['replaygain-album-gain'], 2)),
        row(F('trackDvProfile'), textOr(t['dolby-vision-profile'])),
        row(F('trackDvLevel'), textOr(t['dolby-vision-level'])),
        row(F('trackExternalFile'), textOr(t['external-filename'])),
        row(F('trackSrcId'), isNum(t['src-id']) ? String(t['src-id']) : UNKNOWN),
        row(F('trackFfIndex'), isNum(t['ff-index']) ? String(t['ff-index']) : UNKNOWN),
        row(F('trackMainSelection'), isNum(t['main-selection']) ? String(t['main-selection']) : UNKNOWN)
      ])
    }
  })
}

/** L28: mpv reports cover art as a video track flagged `albumart` or `image`. */
export function hasEmbeddedArt(p: Props): boolean {
  return trackList(p).some((t) => t['albumart'] === true || t['image'] === true)
}

// ---------------------------------------------------------------------------
// U47's two condensed views
// ---------------------------------------------------------------------------

/**
 * The short view: "the six things that appear in every bug report".
 *
 * U47 names them: title, position/duration, current a/v/s track, hwdec.
 */
function shortRows(p: Props, tracks: readonly TrackRow[]): InfoRow[] {
  const sel = (type: string): string => {
    const t = tracks.find((x) => x.selected && x.type === type)
    return t ? t.summary : UNKNOWN
  }
  const pos = formatDuration(p['time-pos'])
  const dur = formatDuration(p['duration'])
  return compact([
    row(F('title'), textOr(p['media-title'] ?? p['filename'])),
    row(F('position'), pos === UNKNOWN || dur === UNKNOWN ? UNKNOWN : `${pos} / ${dur}`),
    row(F('videoTrack'), sel('video')),
    row(F('audioTrack'), sel('audio')),
    row(F('subTrack'), sel('sub')),
    row(F('hwdec'), hwdecLabel(p['hwdec-current'], p['hwdec-interop']))
  ])
}

/** The misc view, exactly as U47 lists it. */
function miscRows(p: Props): InfoRow[] {
  const cache = p['demuxer-cache-state']
  return compact([
    row(F('cacheDuration'), formatDuration(sub(cache, 'cache-duration'))),
    row(F('cacheSpeed'), formatByteRate(p['cache-speed'])),
    row(
      F('framesDropped'),
      isNum(p['frame-drop-count']) ? groupDigits(p['frame-drop-count'] as number) : UNKNOWN
    ),
    row(
      F('decoderFramesDropped'),
      isNum(p['decoder-frame-drop-count'])
        ? groupDigits(p['decoder-frame-drop-count'] as number)
        : UNKNOWN
    ),
    row(F('vo'), textOr(p['current-vo'])),
    row(F('hwdec'), hwdecLabel(p['hwdec-current'], p['hwdec-interop'])),
    row(F('measuredFps'), formatFps(p['estimated-vf-fps']))
  ])
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  open: boolean
  density: MediaInfoState['density']
  tab: InfoTab
  showApproxFrames: boolean
  artUrl: string | null
  properties: MediaInfoState['properties']
  now: number
}

/**
 * `available` is false when mpv is idle, and that is NOT the same as "every
 * property happened to be undefined": `idle-active` is the fact, and a panel
 * that shows its empty state because a codec was missing would be lying.
 */
export function buildState(p: Props, o: SnapshotOptions): MediaInfoState {
  const available = p['idle-active'] !== true && typeof p['path'] === 'string'
  const tracks = buildTracks(p)
  const network = p['demuxer-via-network'] === true

  const groups: InfoGroup[] = []
  if (available) {
    groups.push(generalGroup(p))
    if (tracks.some((t) => t.type === 'video')) groups.push(videoGroup(p))
    if (tracks.some((t) => t.type === 'audio')) groups.push(audioGroup(p))
    if (tracks.some((t) => t.type === 'sub')) groups.push(subsGroup(p))
    groups.push(pipelineGroup(p))
    if (o.showApproxFrames) groups.push(framesGroup(p))
    if (network) groups.push(streamGroup(p))
    const tags = tagsGroup(p)
    if (tags.rows.length > 0) groups.push(tags)
    const chapters = chaptersGroup(p)
    if (chapters.rows.length > 0) groups.push(chapters)
  }

  return {
    open: o.open,
    density: o.density,
    tab: o.tab,
    available,
    path: typeof p['path'] === 'string' ? (p['path'] as string) : null,
    filename: textOr(p['filename']) === UNKNOWN ? '' : (p['filename'] as string),
    title: textOr(p['media-title']) === UNKNOWN ? '' : String(p['media-title'] ?? ''),
    network,
    groups: groups.filter((g) => g.rows.length > 0),
    short: available ? shortRows(p, tracks) : [],
    misc: available ? miscRows(p) : [],
    tracks,
    properties: o.properties,
    artUrl: o.artUrl,
    hasEmbeddedArt: hasEmbeddedArt(p),
    updatedAt: o.now
  }
}

/** The group a stats section renders, or null when this file has none. */
export function groupOf(state: MediaInfoState, id: InfoGroup['id']): InfoGroup | null {
  return state.groups.find((g) => g.id === id) ?? null
}
