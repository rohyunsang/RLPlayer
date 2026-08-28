import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveBufferState,
  formatBytes,
  formatRate,
  isLive,
  normalizeRanges,
  seekWindow,
  type BufferInputs
} from './buffering.ts'
import {
  CACHE_PRESETS,
  LOW_LATENCY_FOREIGN,
  byteSlidersApply,
  curlArgs,
  presetById
} from './cache-presets.ts'
import { MAX_RECENT, addRecent, retitleRecent, sanitizeRecent } from './recent.ts'

/** A local file: every stream field absent or zero, which is the trap. */
const local: BufferInputs = {
  viaNetwork: false,
  pausedForCache: false,
  bufferingState: 0,
  cacheSpeed: 0,
  cacheDuration: undefined,
  cacheTime: undefined,
  duration: 1200,
  seekable: true,
  cacheState: undefined
}

// ---------------------------------------------------------------------------
// R16: the demuxer-via-network gate
// ---------------------------------------------------------------------------

test('R16: a local file yields the not-applicable variant, not 0%', () => {
  const s = deriveBufferState(local)
  assert.equal(s.network, false)
  // The whole point of the discriminated union: there is no `percent: 0` for a
  // caller to render as a permanently-buffering indicator.
  assert.equal('percent' in s, false)
})

test('R16: before the first file, demuxer-via-network is undefined and gates too', () => {
  const s = deriveBufferState({ ...local, viaNetwork: undefined })
  assert.equal(s.network, false)
})

test('R16: only the literal `true` opens the gate', () => {
  // mpv answers a flag as a real boolean. A truthy string would be a bug
  // upstream, and treating it as network would show the UI for a local file.
  for (const v of ['yes', 1, 'true']) {
    assert.equal(deriveBufferState({ ...local, viaNetwork: v }).network, false, String(v))
  }
  assert.equal(deriveBufferState({ ...local, viaNetwork: true }).network, true)
})

test('R16: the measured demuxer-cache-state struct maps field for field', () => {
  const s = deriveBufferState({
    viaNetwork: true,
    pausedForCache: true,
    bufferingState: 42,
    cacheSpeed: 1_500_000,
    cacheDuration: 12.5,
    cacheTime: 312.5,
    duration: 0,
    seekable: false,
    cacheState: {
      'fw-bytes': 8_388_608,
      'raw-input-rate': 2_100_000,
      'seekable-ranges': [{ start: 300, end: 312.5 }],
      'bof-cached': false,
      'eof-cached': false,
      'cache-end': 312.5,
      'reader-pts': 300.1,
      'cache-duration': 12.5,
      'file-cache-bytes': 0
    }
  })
  assert.equal(s.network, true)
  if (!s.network) return
  assert.equal(s.stalled, true)
  assert.equal(s.percent, 42)
  assert.equal(s.seconds, 12.5)
  assert.equal(s.forwardBytes, 8_388_608)
  assert.equal(s.inputRate, 2_100_000)
  assert.equal(s.cacheSpeed, 1_500_000)
  assert.equal(s.live, true)
  assert.deepEqual(s.ranges, [{ start: 300, end: 312.5 }])
})

test('an unavailable property is null, never coerced to 0', () => {
  const s = deriveBufferState({ ...local, viaNetwork: true, bufferingState: undefined })
  assert.equal(s.network, true)
  if (!s.network) return
  // §3: "undefined is a real value ... the bus never coerces it to 0 or ''".
  // A percent of 0 draws an empty buffer bar; null draws no bar at all.
  assert.equal(s.percent, null)
  assert.equal(s.forwardBytes, null)
  assert.equal(s.inputRate, null)
})

test('cache-duration inside the struct is the fallback for the property', () => {
  const s = deriveBufferState({
    ...local,
    viaNetwork: true,
    cacheDuration: undefined,
    cacheState: { 'cache-duration': 7.25 }
  })
  assert.equal(s.network && s.seconds, 7.25)
})

test('a percent outside 0..100 is clamped rather than trusted', () => {
  for (const [raw, want] of [
    [-5, 0],
    [140, 100]
  ] as const) {
    const s = deriveBufferState({ ...local, viaNetwork: true, bufferingState: raw })
    assert.equal(s.network && s.percent, want)
  }
})

// ---------------------------------------------------------------------------
// R24: the seekable window
// ---------------------------------------------------------------------------

test('R24: touching and overlapping ranges are merged, not painted as seams', () => {
  const merged = normalizeRanges([
    { start: 60, end: 90 },
    { start: 0, end: 30 },
    { start: 30, end: 60 },
    { start: 85, end: 120 }
  ])
  assert.deepEqual(merged, [{ start: 0, end: 120 }])
})

test('R24: a genuine gap stays a gap', () => {
  assert.deepEqual(
    normalizeRanges([
      { start: 0, end: 30 },
      { start: 60, end: 90 }
    ]),
    [
      { start: 0, end: 30 },
      { start: 60, end: 90 }
    ]
  )
})

test('R24: junk ranges are dropped entry by entry', () => {
  assert.deepEqual(
    normalizeRanges([
      null,
      { start: 5, end: 5 },
      { start: 'a', end: 10 },
      { start: 10, end: 4 },
      { start: 1, end: 2 }
    ]),
    [{ start: 1, end: 2 }]
  )
  assert.deepEqual(normalizeRanges(undefined), [])
  assert.deepEqual(normalizeRanges([]), [])
})

test('R24: live is decided on duration, NOT on seekable', () => {
  // This is the case --force-seekable=yes creates and it is the reason the test
  // exists: mpv then reports the media as seekable while the duration is still
  // unknown. A seekable-based test flips a live stream back to "not live", and
  // the seek bar returns to pretending there is a 0..duration timeline.
  assert.equal(isLive(0, true), true)
  assert.equal(isLive(undefined, true), true)
  assert.equal(isLive(1200, false), false)
})

test('seekWindow is null when nothing is cached, so nobody divides by zero', () => {
  assert.equal(seekWindow([]), null)
  assert.deepEqual(
    seekWindow([
      { start: 300, end: 330 },
      { start: 400, end: 420 }
    ]),
    { start: 300, end: 420 }
  )
})

test('formatBytes and formatRate show an em dash for null rather than 0', () => {
  assert.equal(formatBytes(null), '—')
  assert.equal(formatRate(null), '—')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MiB')
  assert.equal(formatRate(1024 * 1024), '1.0 MiB/s')
})

// ---------------------------------------------------------------------------
// R17 / R18 / R11
// ---------------------------------------------------------------------------

test('R17: every preset moves demuxer-max-bytes or explicitly turns the cache off', () => {
  // R17's headline: cache-secs alone does nothing, the byte cap is the knob. A
  // preset that only set cache-secs would be a no-op the user cannot tell from
  // a broken setting.
  for (const p of CACHE_PRESETS) {
    const has = 'demuxer-max-bytes' in p.apply
    const off = p.apply['cache'] === 'no'
    assert.equal(has || off, true, `${p.id} moves nothing that matters`)
  }
})

test('R17: cache-pause-initial and cache-pause-wait only ever move together', () => {
  for (const p of CACHE_PRESETS) {
    const initial = p.apply['cache-pause-initial']
    if (initial === 'yes') {
      assert.notEqual(
        p.apply['cache-pause-wait'],
        undefined,
        `${p.id} raises cache-pause-initial without pairing the wait — R17 records ` +
          `that it also fires after SEEKING, which is what makes seeks feel sluggish`
      )
    }
  }
})

test('R17: preset values are plain integers, not mpv suffix syntax', () => {
  // A property write takes a number; only a command-line option takes `150MiB`.
  // Writing '150MiB' through set() is the silent-no-op shape.
  for (const p of CACHE_PRESETS) {
    for (const [k, v] of Object.entries(p.apply)) {
      if (!k.endsWith('bytes') && k !== 'stream-buffer-size') continue
      assert.match(String(v), /^[0-9]+$/, `${p.id}.${k} = ${String(v)}`)
    }
  }
})

test('R14: the low-latency preset applies only properties this module owns', () => {
  const p = presetById('low-latency')
  assert.notEqual(p, undefined)
  if (!p) return
  // And the rest is RECORDED rather than dropped. If this list ever empties
  // without the preset growing, somebody deleted the gap instead of closing it.
  assert.equal(LOW_LATENCY_FOREIGN.length > 0, true)
  const unowned = LOW_LATENCY_FOREIGN.filter((f) => f.owner === null)
  assert.equal(
    unowned.length,
    5,
    'the count of low-latency properties NO manifest row owns changed — re-read ' +
      'docs/parity/modules.json before touching this'
  )
  for (const f of LOW_LATENCY_FOREIGN) {
    assert.equal(f.property in p.apply, false, `${f.property} is not ours to set`)
  }
})

test('R18: the byte sliders are hidden when cache-on-disk is on', () => {
  assert.equal(byteSlidersApply(false), true)
  assert.equal(byteSlidersApply(true), false)
})

test('R11: the CDN toggle is off by default and contributes nothing', () => {
  assert.deepEqual(curlArgs(false), [])
  const on = curlArgs(true)
  assert.equal(on.includes('--curl-max-request-size=8MiB'), true)
  // Every arg must be an option with a value; a bare flag here would be a typo
  // that mpv accepts and ignores.
  for (const a of on) assert.match(a, /^--curl-[a-z-]+=.+$/)
})

// ---------------------------------------------------------------------------
// R03
// ---------------------------------------------------------------------------

test('R03: adding an existing url moves it to the front without duplicating', () => {
  const a = { url: 'https://a', title: 'A', lastPlayed: 1 }
  const b = { url: 'https://b', title: 'B', lastPlayed: 2 }
  const list = addRecent(addRecent([], a), b)
  assert.deepEqual(list.map((r) => r.url), ['https://b', 'https://a'])
  const again = addRecent(list, { ...a, lastPlayed: 3 })
  assert.deepEqual(again.map((r) => r.url), ['https://a', 'https://b'])
  assert.equal(again.length, 2)
})

test('R03: the list is capped and drops the OLDEST', () => {
  let list: ReturnType<typeof addRecent> = []
  for (let i = 0; i < MAX_RECENT + 5; i++) {
    list = addRecent(list, { url: `https://h/${i}`, title: `t${i}`, lastPlayed: i })
  }
  assert.equal(list.length, MAX_RECENT)
  assert.equal(list[0]?.url, `https://h/${MAX_RECENT + 4}`)
  // The eviction bug this project already shipped once (defect 63) was exactly
  // backwards, so assert the survivor set and not only the length.
  assert.equal(
    list.some((r) => r.url === 'https://h/0'),
    false
  )
})

test('R03: two urls differing only in a query parameter are two entries', () => {
  const list = addRecent(
    addRecent([], { url: 'https://a/x.m3u8?token=1', title: 'a', lastPlayed: 1 }),
    { url: 'https://a/x.m3u8?token=2', title: 'a', lastPlayed: 2 }
  )
  assert.equal(list.length, 2)
})

test('R03: retitle finds the entry and leaves the rest identical', () => {
  const list = [
    { url: 'https://a', title: 'https://a', lastPlayed: 1 },
    { url: 'https://b', title: 'B', lastPlayed: 2 }
  ]
  const out = retitleRecent(list, 'https://a', 'KBS 1TV')
  assert.equal(out[0]?.title, 'KBS 1TV')
  assert.equal(out[1], list[1])
  // A miss returns a copy, never undefined, so the caller can always assign.
  assert.deepEqual(retitleRecent(list, 'https://zzz', 'x'), list)
})

test('R03: a corrupt file loses the bad rows and keeps the good ones', () => {
  const out = sanitizeRecent([
    { url: 'https://good', title: 'G', lastPlayed: 5 },
    { url: 42 },
    null,
    'nope',
    { title: 'no url', lastPlayed: 1 },
    { url: 'https://good', title: 'dup', lastPlayed: 9 },
    { url: 'https://untitled' }
  ])
  assert.deepEqual(out, [
    { url: 'https://good', title: 'G', lastPlayed: 5 },
    // A missing title falls back to the URL rather than rendering as `undefined`.
    { url: 'https://untitled', title: 'https://untitled', lastPlayed: 0 }
  ])
  assert.deepEqual(sanitizeRecent(null), [])
  assert.deepEqual(sanitizeRecent({ url: 'https://a' }), [])
})
