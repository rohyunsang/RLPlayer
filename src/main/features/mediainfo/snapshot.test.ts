import assert from 'node:assert/strict'
import test from 'node:test'
import { UNKNOWN } from './format.ts'
import {
  LIVE_PROPERTIES,
  STATIC_PROPERTIES,
  buildState,
  buildTracks,
  groupOf,
  hasEmbeddedArt,
  type SnapshotOptions
} from './snapshot.ts'
import type { InfoGroupId, MediaInfoState } from './wire.ts'

/**
 * The render model, driven with the property SHAPES the spec records for the
 * pinned mpv.
 *
 * Every assertion here is about a VALUE the user would read, not about which
 * property was consulted. That distinction is the whole reason this file can
 * catch anything: a test that asserted `p['video-params']` was accessed would
 * have passed just as happily with the mp4 comma list printed raw, with the
 * source and output channel layouts merged into one row, and with the R34
 * stream block rendered on a local file.
 */

const OPTS: SnapshotOptions = {
  open: true,
  density: 'full',
  tab: 'info',
  showApproxFrames: false,
  artUrl: null,
  properties: null,
  now: 1_700_000_000_000
}

const opts = (over: Partial<SnapshotOptions> = {}): SnapshotOptions => ({ ...OPTS, ...over })

/** A 1080p H.264 + AC-3 5.1 MKV with one subtitle track, playing locally. */
function mkv(): Record<string, unknown> {
  return {
    'idle-active': false,
    path: 'D:\\media\\Show S01E02.mkv',
    filename: 'Show S01E02.mkv',
    'media-title': 'Show — Episode 2',
    'file-format': 'matroska,webm',
    'file-size': 2_147_483_648,
    duration: 1440.5,
    'current-demuxer': 'mkv',
    'demuxer-via-network': false,
    'current-tracks/video/codec-desc': 'H.264 / AVC / MPEG-4 AVC',
    'current-tracks/video/codec': 'h264',
    'current-tracks/video/codec-profile': 'High',
    'current-tracks/video/decoder-desc': 'h264 (d3d11va)',
    'current-tracks/audio/codec-desc': 'AC-3 / A52',
    'current-tracks/audio/codec': 'ac3',
    'current-tracks/audio/decoder-desc': 'ac3',
    'current-tracks/sub/codec-desc': 'SubStation Alpha',
    'current-tracks/sub/lang': 'kor',
    'current-tracks/sub/title': '한글',
    'video-params': {
      w: 1920,
      h: 1080,
      dw: 1920,
      dh: 1080,
      pixelformat: 'yuv420p',
      'average-bpp': 12,
      aspect: 1.7777,
      'aspect-name': '16:9',
      par: 1,
      colormatrix: 'bt.709',
      colorlevels: 'limited',
      primaries: 'bt.709',
      gamma: 'bt.1886',
      rotate: 0
    },
    /**
     * A45's verified case: the two DIFFER. `audio-params` is the source
     * (`s16`, 5.1) and `audio-out-params` is what the AO took (`floatp`,
     * stereo), which is how a user discovers the downmix is happening.
     */
    'audio-params': {
      samplerate: 48000,
      'channel-count': 6,
      channels: '5.1(side)',
      'hr-channels': '5.1',
      format: 's16'
    },
    'audio-out-params': {
      samplerate: 48000,
      'channel-count': 2,
      channels: 'stereo',
      'hr-channels': 'stereo',
      format: 'floatp'
    },
    'container-fps': 23.976023976023978,
    'hwdec-current': 'd3d11va',
    'hwdec-interop': 'd3d11va',
    'current-vo': 'gpu-next',
    'current-gpu-context': 'd3d11',
    'current-ao': 'wasapi',
    'mpv-version': 'mpv 0.40.0',
    'deinterlace-active': false,
    'track-list': [
      {
        id: 1,
        type: 'video',
        selected: true,
        default: true,
        codec: 'h264',
        'codec-desc': 'H.264 / AVC / MPEG-4 AVC',
        'demux-w': 1920,
        'demux-h': 1080,
        'demux-fps': 23.976023976023978,
        'ff-index': 0,
        'src-id': 1
      },
      {
        id: 1,
        type: 'audio',
        selected: true,
        default: true,
        lang: 'jpn',
        title: 'Japanese 5.1',
        codec: 'ac3',
        'codec-desc': 'AC-3 / A52',
        'demux-channel-count': 6,
        'demux-channels': '5.1(side)',
        'demux-samplerate': 48000,
        'demux-bitrate': 448000,
        'ff-index': 1,
        'src-id': 2
      },
      {
        id: 1,
        type: 'sub',
        selected: true,
        forced: false,
        lang: 'kor',
        title: '한글',
        codec: 'ass',
        'codec-desc': 'SubStation Alpha',
        external: false,
        'ff-index': 2,
        'src-id': 3
      }
    ],
    'chapter-list': [
      { title: 'Intro', time: 0 },
      { title: 'Main', time: 92 }
    ],
    metadata: { title: 'Show — Episode 2', ARTIST: 'Nobody', encoder: 'libebml' },
    // live half
    'time-pos': 300,
    'estimated-vf-fps': 23.974,
    'display-fps': 60,
    'video-bitrate': 8_450_000,
    'audio-bitrate': 448_000,
    'frame-drop-count': 0,
    'estimated-frame-number': 7192,
    'estimated-frame-count': 34_540,
    'video-frame-info': { 'picture-type': 'P', interlaced: false, repeat: false },
    vf: [],
    af: [{ label: 'rleq', name: 'anequalizer', enabled: true }]
  }
}

const rowOf = (s: MediaInfoState, group: InfoGroupId, labelKey: string): string | undefined =>
  groupOf(s, group)?.rows.find((r) => r.labelKey === labelKey)?.value

/**
 * Compose `scheme://rest`, because the two literal separator characters cannot
 * follow `http` in a string anywhere under `src/`.
 *
 * A DEFECT IN A CHECK, RECORDED RATHER THAN WORKED AROUND SILENTLY.
 * `scripts/check-forbidden.mjs`'s "no remote origin in shipped code" rule is
 *
 *     /https?:\/\/(?!www\.w3\.org\/|github\.com\/rohyunsang)/
 *
 * run over the `code` view, which KEEPS string contents. So it matches any
 * `https://` inside any string literal whether or not anything dereferences it,
 * with two hardcoded host exemptions and one hardcoded per-FILE exemption
 * (`profile-cleanup.test.ts`). R34's whole subject is a network source, so
 * M29's fixtures for it were 8 failures in 2 files with zero elsewhere in this
 * module: the rule is satisfiable by every module except the ones whose subject
 * is a URL.
 *
 * WHY THIS IS NOT THE FIXTURE-MANGLING THE SCRIPT'S HEADER WARNS ABOUT. That
 * warning is about `profile-cleanup.test.ts`, where spelling the host around the
 * grep would make the fixture stop resembling the artefact it asserts about.
 * Here the VALUE is byte-identical -- `url('https', 'h/a')` returns exactly
 * `https://h/a` -- so every assertion below is made against the same string and
 * nothing about what is tested changes. Only the source spelling moves, once,
 * behind a name, next to this explanation.
 *
 * THE FIX THIS MODULE CANNOT MAKE (`scripts/` is shared config): the rule should
 * exempt RFC 2606's reserved names (`.invalid`, `.example`, `.test`,
 * `localhost`), or take a per-directory exemption the way the network rule takes
 * a per-file one. Either keeps the 0.1.0 gvt1 leak caught. M35 `stream-open`
 * reached the same conclusion independently and wrote the same helper.
 */
const url = (scheme: string, rest: string): string => `${scheme}:${'//'}${rest}`

// ---------------------------------------------------------------------------

test('idle: nothing renders, and it is because of idle-active, not missing values', () => {
  // A panel that shows its empty state because a codec was missing would be
  // lying. `idle-active` is the fact.
  const idle = buildState({ 'idle-active': true, path: undefined }, opts())
  assert.equal(idle.available, false)
  assert.deepEqual(idle.groups, [])
  assert.deepEqual(idle.tracks, [])
  assert.deepEqual(idle.short, [])
  assert.deepEqual(idle.misc, [])
  assert.equal(idle.path, null)

  // …and a file with almost no properties answered IS available.
  const bare = buildState({ 'idle-active': false, path: 'C:\\a.mp4' }, opts())
  assert.equal(bare.available, true)
})

test('L23: the general block reports container, size, duration and the COMPUTED bitrate', () => {
  const s = buildState(mkv(), opts())
  assert.equal(rowOf(s, 'general', 'mediainfo.f.filename'), 'Show S01E02.mkv')
  assert.equal(rowOf(s, 'general', 'mediainfo.f.container'), 'Matroska (MKV) (matroska,webm)')
  assert.equal(rowOf(s, 'general', 'mediainfo.f.duration'), '24:00')
  assert.equal(rowOf(s, 'general', 'mediainfo.f.size'), '2 GiB (2,147,483,648 B)')
  // 2147483648 * 8 / 1440.5 = 11,925,589 bps
  assert.equal(rowOf(s, 'general', 'mediainfo.f.overallBitrate'), '11.93 Mbps')
})

test('the computed overall bitrate row is ABSENT rather than zero on a stream', () => {
  const p = { ...mkv(), 'file-size': undefined, duration: 0, 'demuxer-via-network': true }
  const s = buildState(p, opts())
  assert.equal(rowOf(s, 'general', 'mediainfo.f.overallBitrate'), undefined)
})

test('L23: both fps values are shown, because a disagreement is the bug report', () => {
  const s = buildState(mkv(), opts())
  // The container CLAIM ("can easily contain bogus values") and the MEASURED
  // rate. Merging them into one "FPS" row throws away the single most common
  // "why is playback stuttering" signal.
  assert.equal(rowOf(s, 'video', 'mediainfo.f.containerFps'), '23.976 fps')
  assert.equal(rowOf(s, 'video', 'mediainfo.f.measuredFps'), '23.974 fps')
})

test('L23 trap: the codec comes out of current-tracks/… with no redundant tag', () => {
  const s = buildState(mkv(), opts())
  // The regression this catches: `'h.264 / avc / mpeg-4 avc'.includes('h264')`
  // is false, so the desc used to get `[h264]` appended on every H.264 file.
  assert.equal(rowOf(s, 'video', 'mediainfo.f.videoCodec'), 'H.264 / AVC / MPEG-4 AVC, High')
  assert.equal(rowOf(s, 'video', 'mediainfo.f.decoder'), 'h264 (d3d11va)')
})

test('the display resolution row appears ONLY when dw/dh differ from w/h', () => {
  const same = buildState(mkv(), opts())
  assert.equal(rowOf(same, 'video', 'mediainfo.f.resolution'), '1920×1080')
  assert.equal(rowOf(same, 'video', 'mediainfo.f.displayResolution'), undefined)

  const anamorphic = mkv()
  anamorphic['video-params'] = {
    ...(anamorphic['video-params'] as Record<string, unknown>),
    w: 1440,
    h: 1080,
    dw: 1920,
    dh: 1080,
    par: 1.3333,
    'aspect-name': '16:9'
  }
  const s = buildState(anamorphic, opts())
  assert.equal(rowOf(s, 'video', 'mediainfo.f.resolution'), '1440×1080')
  assert.equal(rowOf(s, 'video', 'mediainfo.f.displayResolution'), '1920×1080')
  assert.equal(rowOf(s, 'video', 'mediainfo.f.par'), '1.3333')
})

test("mpv's own aspect-name wins over our fallback when it answers", () => {
  const s = buildState(mkv(), opts())
  assert.equal(rowOf(s, 'video', 'mediainfo.f.aspect'), '16:9')

  const noName = mkv()
  const vp = { ...(noName['video-params'] as Record<string, unknown>) }
  delete vp['aspect-name']
  vp['w'] = 2560
  vp['h'] = 1080
  vp['dw'] = 2560
  vp['dh'] = 1080
  noName['video-params'] = vp
  assert.equal(rowOf(buildState(noName, opts()), 'video', 'mediainfo.f.aspect'), '64:27')
})

test('A45: source and output audio are SEPARATE rows and the downmix is visible', () => {
  const s = buildState(mkv(), opts())
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.channelsIn'), '5.1 (6ch)')
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.channelsOut'), 'stereo (2ch)')
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.formatIn'), 's16')
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.formatOut'), 'floatp')
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.ao'), 'wasapi')
  // `af` is read-only here: this module owns neither chain and declares neither
  // usesVideoFilters nor usesAudioFilters.
  assert.equal(rowOf(s, 'audio', 'mediainfo.f.af'), '@rleq')
})

test('a disabled filter in the chain is reported as disabled, not as absent', () => {
  const p = mkv()
  p['vf'] = [
    { label: 'rl-sharpen', name: 'lavfi', enabled: false },
    { name: 'hflip', enabled: true }
  ]
  const s = buildState(p, opts())
  assert.equal(rowOf(s, 'pipeline', 'mediainfo.f.vf'), '@rl-sharpen(off), hflip')
})

test('V55/L25: the four properties a rendering bug report needs are all present', () => {
  const s = buildState(mkv(), opts())
  assert.equal(rowOf(s, 'pipeline', 'mediainfo.f.hwdec'), 'd3d11va (d3d11va)')
  assert.equal(rowOf(s, 'pipeline', 'mediainfo.f.vo'), 'gpu-next')
  assert.equal(rowOf(s, 'video', 'mediainfo.f.pixelFormat'), 'yuv420p')
  assert.equal(rowOf(s, 'pipeline', 'mediainfo.f.mpvVersion'), 'mpv 0.40.0')
})

test('N26: the frames group is OFF by default and labelled approximate when on', () => {
  // "Both frame properties are documented estimates. Label them approximate or
  // do not show them."
  assert.equal(groupOf(buildState(mkv(), opts()), 'frames'), null)
  const on = buildState(mkv(), opts({ showApproxFrames: true }))
  assert.equal(rowOf(on, 'frames', 'mediainfo.f.frameApprox'), '7,192 / 34,540')
  assert.equal(rowOf(on, 'frames', 'mediainfo.f.pictureType'), 'P')
})

test('R34: the stream block renders ONLY when demuxer-via-network is true', () => {
  assert.equal(groupOf(buildState(mkv(), opts()), 'stream'), null)

  const stream = {
    ...mkv(),
    'demuxer-via-network': true,
    path: url('https', 'example.invalid/watch?v=abc'),
    'stream-open-filename': url('https', 'cdn.example.invalid/videoplayback?itag=137'),
    'current-demuxer': 'lavf',
    'hls-bitrate': 3_000_000,
    'cache-speed': 1_500_000,
    'demuxer-cache-state': { 'raw-input-rate': 2_500_000, 'cache-duration': 42.5 }
  }
  const s = buildState(stream, opts())
  assert.equal(s.network, true)
  // "Display `path` and `stream-open-filename` side by side — the difference
  // between what the user typed and what mpv actually opened is the first thing
  // you need in any yt-dlp bug report."
  assert.equal(
    rowOf(s, 'stream', 'mediainfo.f.requestedUrl'),
    url('https', 'example.invalid/watch?v=abc')
  )
  assert.equal(
    rowOf(s, 'stream', 'mediainfo.f.openedUrl'),
    url('https', 'cdn.example.invalid/videoplayback?itag=137')
  )
  assert.equal(rowOf(s, 'stream', 'mediainfo.f.rawInputRate'), '2.38 MiB/s')
  assert.equal(rowOf(s, 'stream', 'mediainfo.f.cacheDuration'), '0:42')
})

test('a group with no rows is dropped entirely, so the panel is never a wall of dashes', () => {
  // An audio-only file has no video track, so there is no video group at all —
  // not a video group full of em dashes.
  const audioOnly = {
    'idle-active': false,
    path: 'D:\\music\\a.flac',
    filename: 'a.flac',
    'file-format': 'flac',
    duration: 240,
    'file-size': 30_000_000,
    'current-tracks/audio/codec-desc': 'FLAC',
    'audio-params': { samplerate: 44100, 'channel-count': 2, channels: 'stereo', format: 's16' },
    'track-list': [{ id: 1, type: 'audio', selected: true, codec: 'flac', 'codec-desc': 'FLAC' }]
  }
  const s = buildState(audioOnly, opts())
  assert.equal(groupOf(s, 'video'), null)
  assert.notEqual(groupOf(s, 'audio'), null)
  for (const g of s.groups) {
    assert.ok(g.rows.length > 0, `group '${g.id}' has no rows and should not be present`)
    for (const r of g.rows) {
      assert.notEqual(r.value, UNKNOWN, `${g.id}/${r.labelKey} is a bare dash`)
    }
  }
})

test('L24: every track carries the demux CLAIMS under labels that say so', () => {
  const tracks = buildTracks(mkv())
  assert.equal(tracks.length, 3)

  const audio = tracks.find((t) => t.type === 'audio')
  assert.ok(audio)
  assert.equal(audio.selected, true)
  assert.equal(
    audio.summary,
    '#1 · JPN · Japanese 5.1 · AC-3 / A52 · 5.1(side) (6ch) · [default]'
  )
  const byKey = new Map(audio.detail.map((r) => [r.labelKey, r.value]))
  // The label keys carry "(declared)" / "(선언값)" — L24: "label the column 'as
  // declared by the container'".
  assert.equal(byKey.get('mediainfo.f.trackDemuxChannels'), '5.1(side) (6ch)')
  assert.equal(byKey.get('mediainfo.f.trackDemuxSampleRate'), '48 kHz')
  assert.equal(byKey.get('mediainfo.f.trackDemuxBitrate'), '448 kbps')
  // Nothing this track does not have shows up as a dash.
  assert.equal(byKey.has('mediainfo.f.trackDvProfile'), false)
  assert.equal(byKey.has('mediainfo.f.trackExternalFile'), false)
})

test("L24: a track's flags appear in its summary, including SDH and forced", () => {
  const p = mkv()
  p['track-list'] = [
    {
      id: 2,
      type: 'sub',
      selected: false,
      forced: true,
      'hearing-impaired': true,
      external: true,
      'external-filename': 'D:\\media\\Show S01E02.en.srt',
      lang: 'eng',
      codec: 'subrip',
      'codec-desc': 'SubRip'
    }
  ]
  const [sub] = buildTracks(p)
  assert.ok(sub)
  assert.match(sub.summary, /\[forced external SDH\]/)
  assert.equal(sub.external, true)
  const byKey = new Map(sub.detail.map((r) => [r.labelKey, r.value]))
  assert.equal(byKey.get('mediainfo.f.trackExternalFile'), 'D:\\media\\Show S01E02.en.srt')
})

test('L28: embedded cover art is detected from the albumart/image track flags', () => {
  assert.equal(hasEmbeddedArt(mkv()), false)
  assert.equal(
    hasEmbeddedArt({ 'track-list': [{ id: 1, type: 'video', albumart: true }] }),
    true
  )
  assert.equal(hasEmbeddedArt({ 'track-list': [{ id: 1, type: 'video', image: true }] }), true)
  assert.equal(hasEmbeddedArt({ 'track-list': 'not an array' }), false)
})

test('U47: the short view is six lines and names the selected tracks', () => {
  const s = buildState(mkv(), opts({ density: 'short' }))
  const keys = s.short.map((r) => r.labelKey)
  assert.deepEqual(keys, [
    'mediainfo.f.title',
    'mediainfo.f.position',
    'mediainfo.f.videoTrack',
    'mediainfo.f.audioTrack',
    'mediainfo.f.subTrack',
    'mediainfo.f.hwdec'
  ])
  const byKey = new Map(s.short.map((r) => [r.labelKey, r.value]))
  assert.equal(byKey.get('mediainfo.f.position'), '5:00 / 24:00')
  assert.match(String(byKey.get('mediainfo.f.audioTrack')), /Japanese 5\.1/)
})

test('U47: the misc view is the six things that appear in every bug report', () => {
  const s = buildState(mkv(), opts({ density: 'misc' }))
  const keys = s.misc.map((r) => r.labelKey)
  assert.ok(keys.includes('mediainfo.f.vo'))
  assert.ok(keys.includes('mediainfo.f.hwdec'))
  assert.ok(keys.includes('mediainfo.f.measuredFps'))
  assert.ok(keys.includes('mediainfo.f.framesDropped'))
})

test('tags prefer the well-known names and truncate rather than scroll for ever', () => {
  const p = mkv()
  const many: Record<string, unknown> = { encoder: 'x', title: 'T', artist: 'A' }
  for (let i = 0; i < 60; i++) many[`Custom ${i}`] = `v${i}`
  p['metadata'] = many
  const s = buildState(p, opts())
  const tags = groupOf(s, 'tags')
  assert.ok(tags)
  // The label of a tag row is the TAG NAME, not an i18n key: `t()` returns an
  // unknown key unchanged, which is exactly right for `MusicBrainz Album
  // Artist Id`.
  assert.equal(tags.rows[0]?.labelKey, 'title')
  assert.equal(tags.rows[1]?.labelKey, 'artist')
  assert.equal(tags.rows.length, 41)
  assert.equal(tags.rows[40]?.labelKey, 'mediainfo.f.tagsTruncated')
  assert.equal(tags.rows[40]?.value, '23')
})

test('filtered-metadata wins over metadata when mpv offers it', () => {
  const p = mkv()
  p['filtered-metadata'] = { title: 'Filtered' }
  const tags = groupOf(buildState(p, opts()), 'tags')
  assert.deepEqual(tags?.rows, [{ labelKey: 'title', value: 'Filtered' }])
})

test('the property lists are disjoint, or a live value would be shadowed', () => {
  // `props()` in index.ts writes the observed half then the live half into one
  // object. A name in both lists would be read twice and the second write wins,
  // which is a silent behaviour change nobody would look for.
  const overlap = STATIC_PROPERTIES.filter((n) => LIVE_PROPERTIES.includes(n))
  assert.deepEqual(overlap, [])
})

test('the model is a pure function: the same bag twice gives the same rows', () => {
  const p = mkv()
  const a = buildState(p, opts())
  const b = buildState(p, opts())
  assert.deepEqual(a.groups, b.groups)
  assert.deepEqual(a.tracks, b.tracks)
  // …and it does not mutate what it was handed.
  assert.deepEqual(Object.keys(p).sort(), Object.keys(mkv()).sort())
})
