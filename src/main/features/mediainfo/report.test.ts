import assert from 'node:assert/strict'
import test from 'node:test'
import { EN, KO } from './i18n.ts'
import { DIAGNOSTIC_PROPERTIES, renderInfoAsText } from './report.ts'
import { buildState, type SnapshotOptions } from './snapshot.ts'
import type { MediaInfoState } from './wire.ts'

/**
 * L25 -- "copy media info to clipboard", and its one hard requirement.
 *
 * §6.3's acceptance row for M29 is: "'copy info' output pasted into an issue
 * contains `hwdec-current` and `current-vo`". Note what that sentence is really
 * asking for -- the PROPERTY NAMES, not their values under a translated label.
 * A maintainer greps a pasted report for `hwdec-current`; a Korean UI would
 * otherwise emit `하드웨어 디코더: d3d11va`, which satisfies the letter of the
 * row and none of its purpose.
 *
 * So the assertions below are run through BOTH catalogues, and they are about
 * the literal property names surviving. A test that only ran in English would
 * have passed on the day the labels were translated.
 */

const OPTS: SnapshotOptions = {
  open: true,
  density: 'full',
  tab: 'info',
  showApproxFrames: false,
  artUrl: null,
  properties: null,
  now: 0
}

const PROPS = {
  'idle-active': false,
  path: 'D:\\media\\a.mkv',
  filename: 'a.mkv',
  'media-title': 'A',
  'file-format': 'matroska',
  'file-size': 1_000_000,
  duration: 100,
  'current-tracks/video/codec-desc': 'H.264 / AVC / MPEG-4 AVC',
  'current-tracks/video/codec': 'h264',
  'video-params': { w: 1920, h: 1080, dw: 1920, dh: 1080, pixelformat: 'yuv420p' },
  'current-tracks/audio/codec-desc': 'AAC',
  'audio-params': { samplerate: 48000, 'channel-count': 2, channels: 'stereo', format: 'floatp' },
  'hwdec-current': 'd3d11va',
  'current-vo': 'gpu-next',
  'current-ao': 'wasapi',
  'mpv-version': 'mpv 0.40.0',
  metadata: { title: 'A', ARTIST: 'Nobody' },
  'track-list': [
    { id: 1, type: 'video', selected: true, codec: 'h264', 'codec-desc': 'H.264 / AVC / MPEG-4 AVC' },
    { id: 1, type: 'audio', selected: true, lang: 'jpn', codec: 'aac', 'codec-desc': 'AAC' }
  ]
}

const DIAG: Record<string, string> = {
  'hwdec-current': 'd3d11va',
  'hwdec-interop': 'd3d11va',
  'current-vo': 'gpu-next',
  'current-gpu-context': 'd3d11',
  'current-ao': 'wasapi',
  'video-params/pixelformat': 'yuv420p',
  'mpv-version': 'mpv 0.40.0'
}

const translator = (catalogue: Record<string, string>) => (key: string): string =>
  // Exactly `core/i18n`'s behaviour for an unknown key: return it unchanged.
  // That is what lets a metadata TAG name be its own label.
  catalogue[key] ?? key

const state = (): MediaInfoState => buildState(PROPS, OPTS)

// ---------------------------------------------------------------------------

test('§6.3: the four property names L25 requires survive in BOTH languages', () => {
  for (const [lang, catalogue] of [
    ['ko', KO],
    ['en', EN]
  ] as const) {
    const text = renderInfoAsText(state(), translator(catalogue), {
      diagnostics: DIAG,
      includeTags: false,
      includeTrackDetail: false
    })
    for (const name of ['hwdec-current', 'current-vo', 'video-params/pixelformat', 'mpv-version']) {
      assert.ok(text.includes(`${name}:`), `${lang}: '${name}' is not in the report`)
    }
  }
})

test('DIAGNOSTIC_PROPERTIES is the set L25 names, so the test is not about a happy string', () => {
  // The previous shape of this check would have been "the report contains
  // hwdec-current", which stays true if the diagnostics block is reduced to
  // that one line. Asserting on the exported LIST is what makes the four
  // required names a contract rather than a coincidence.
  for (const required of [
    'hwdec-current',
    'current-vo',
    'video-params/pixelformat',
    'mpv-version'
  ]) {
    assert.ok(
      DIAGNOSTIC_PROPERTIES.includes(required),
      `L25 requires '${required}' and DIAGNOSTIC_PROPERTIES does not list it`
    )
  }
})

test('the report is grouped Key: value lines under bracketed headings', () => {
  const text = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: false,
    includeTrackDetail: false
  })
  assert.ok(text.startsWith('RLPlayer media info'))
  assert.ok(text.includes('[General]'))
  assert.ok(text.includes('[Video]'))
  assert.ok(text.includes('[Diagnostics]'))
  assert.ok(text.includes('Video codec: H.264 / AVC / MPEG-4 AVC'))
  // Every line that is not a heading, a rule or blank is `Key: value`.
  for (const line of text.split('\r\n')) {
    if (line === '' || line.startsWith('[') || /^-+$/.test(line) || line.startsWith('*')) continue
    if (line === 'RLPlayer media info') continue
    assert.match(line, /^\s*\S.*: .*$/, `not a Key: value line: ${JSON.stringify(line)}`)
  }
})

test('the clipboard text is CRLF, because it is pasted into Notepad', () => {
  const text = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: false,
    includeTrackDetail: false
  })
  assert.ok(text.includes('\r\n'))
  // No bare LF anywhere: LF-only text is one paragraph in Notepad.
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false)
})

test('the selected track is marked, and per-track detail is opt-in', () => {
  const lean = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: false,
    includeTrackDetail: false
  })
  assert.ok(lean.includes('* video:'))
  assert.ok(lean.includes('* audio:'))
  assert.equal(lean.includes('    Codec:'), false)

  const full = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: false,
    includeTrackDetail: true
  })
  assert.ok(full.includes('    Codec: H.264 / AVC / MPEG-4 AVC'))
})

test('tags are opt-in and the group is skipped entirely when they are off', () => {
  const off = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: false,
    includeTrackDetail: false
  })
  assert.equal(off.includes('[Tags]'), false)
  assert.equal(off.includes('ARTIST'), false)

  const on = renderInfoAsText(state(), translator(EN), {
    diagnostics: DIAG,
    includeTags: true,
    includeTrackDetail: false
  })
  assert.ok(on.includes('[Tags]'))
  // A tag's own name is its label — `t()` passes an unknown key through.
  assert.ok(on.includes('ARTIST: Nobody'))
})

test('idle: the report says so instead of emitting empty headings', () => {
  const idle = buildState({ 'idle-active': true }, OPTS)
  const text = renderInfoAsText(idle, translator(EN), {
    diagnostics: {},
    includeTags: true,
    includeTrackDetail: true
  })
  assert.ok(text.includes('Nothing is playing'))
  assert.equal(text.includes('[General]'), false)
})

test('an empty diagnostics map omits the block rather than printing a bare heading', () => {
  const text = renderInfoAsText(state(), translator(EN), {
    diagnostics: {},
    includeTags: false,
    includeTrackDetail: false
  })
  assert.equal(text.includes('[Diagnostics]'), false)
})
