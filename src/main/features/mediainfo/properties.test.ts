import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProperties, buildPropertiesFromProbe, splitPath } from './properties.ts'
import { buildState, type SnapshotOptions } from './snapshot.ts'
import type { MediaInfoState } from './wire.ts'

/** L26 -- the file-properties view, with `fs.statSync` injected. */

const OPTS: SnapshotOptions = {
  open: true,
  density: 'full',
  tab: 'properties',
  showApproxFrames: false,
  artUrl: null,
  properties: null,
  now: 0
}

const STAT = {
  size: 2_147_483_648,
  birthtimeMs: new Date(2026, 0, 2, 3, 4, 5).getTime(),
  mtimeMs: new Date(2026, 5, 6, 7, 8, 9).getTime()
}

const local = (): MediaInfoState =>
  buildState(
    {
      'idle-active': false,
      path: 'D:\\media\\Show S01E02.mkv',
      filename: 'Show S01E02.mkv',
      'media-title': 'Episode 2',
      'file-format': 'matroska',
      'file-size': STAT.size,
      duration: 1440.5,
      'demuxer-via-network': false,
      'track-list': [{ id: 1, type: 'video', selected: true }]
    },
    OPTS
  )

const byKey = (s: { rows: Array<{ labelKey: string; value: string }> }): Map<string, string> =>
  new Map(s.rows.map((r) => [r.labelKey, r.value]))

/** See the long note on the same helper in `snapshot.test.ts`. */
const url = (scheme: string, rest: string): string => `${scheme}:${'//'}${rest}`

test('a local file reports the shell facts and the media facts together', () => {
  const p = buildProperties(local(), { stat: () => STAT })
  assert.ok(p)
  assert.equal(p.filename, 'Show S01E02.mkv')
  assert.equal(p.directory, 'D:\\media')
  assert.equal(p.sizeBytes, STAT.size)
  const rows = byKey(p)
  assert.equal(rows.get('mediainfo.f.size'), '2 GiB (2,147,483,648 B)')
  assert.equal(rows.get('mediainfo.f.created'), '2026-01-02 03:04:05')
  assert.equal(rows.get('mediainfo.f.modified'), '2026-06-06 07:08:09')
  // These three come out of the SAME snapshot the info tab renders, so the two
  // tabs cannot disagree about how long the file is.
  assert.equal(rows.get('mediainfo.f.duration'), '24:00')
  assert.equal(rows.get('mediainfo.f.container'), 'Matroska (MKV)')
})

test('a zero birthtime is an ABSENT row, not 1970', () => {
  // Windows reports 0 on some volumes and on every network share this has been
  // run against. "1970-01-01 09:00:00" in a properties dialog is worse than no
  // row at all.
  const p = buildProperties(local(), { stat: () => ({ ...STAT, birthtimeMs: 0 }) })
  assert.ok(p)
  assert.equal(p.createdMs, null)
  assert.equal(byKey(p).has('mediainfo.f.created'), false)
})

test('a network source is never stat-ed, and says nothing about size or dates', () => {
  const s = buildState(
    {
      'idle-active': false,
      path: url('https', 'example.invalid/v.m3u8'),
      filename: 'v.m3u8',
      'demuxer-via-network': true,
      'track-list': [{ id: 1, type: 'video', selected: true }]
    },
    OPTS
  )
  let statCalls = 0
  const p = buildProperties(s, {
    stat: () => {
      statCalls++
      return STAT
    }
  })
  assert.ok(p)
  assert.equal(statCalls, 0, 'a URL must not be handed to fs.statSync')
  assert.equal(p.sizeBytes, null)
  assert.equal(p.directory, '')
  assert.equal(p.filename, url('https', 'example.invalid/v.m3u8'))
})

test('a gone file still reports its path rather than answering null', () => {
  const p = buildProperties(local(), { stat: () => null })
  assert.ok(p)
  assert.equal(p.sizeBytes, null)
  assert.equal(byKey(p).get('mediainfo.f.path'), 'D:\\media\\Show S01E02.mkv')
})

test('nothing playing answers null, so the command can refuse instead of rendering blank', () => {
  const idle = buildState({ 'idle-active': true }, OPTS)
  assert.equal(buildProperties(idle, { stat: () => STAT }), null)
})

test('splitPath separates a Windows path and leaves a URL whole', () => {
  assert.deepEqual(splitPath('D:\\a\\b.mkv'), { directory: 'D:\\a', filename: 'b.mkv' })
  assert.deepEqual(splitPath('D:/a/b.mkv'), { directory: 'D:/a', filename: 'b.mkv' })
  assert.deepEqual(splitPath('\\\\nas\\s\\b.mkv'), { directory: '\\\\nas\\s', filename: 'b.mkv' })
  assert.deepEqual(splitPath('b.mkv'), { directory: '', filename: 'b.mkv' })
  assert.deepEqual(splitPath(url('https', 'h/a/b.mkv')), {
    directory: '',
    filename: url('https', 'h/a/b.mkv')
  })
  assert.deepEqual(splitPath('av://lavfi:testsrc'), {
    directory: '',
    filename: 'av://lavfi:testsrc'
  })
})

test('the probe-built view never prints two rows for the same fact', () => {
  // The probe's own row list already carries duration/size/container, and a
  // second copy under a slightly different label is how a panel starts looking
  // like it disagrees with itself.
  const p = buildPropertiesFromProbe(
    'D:\\a\\b.mkv',
    [
      { labelKey: 'mediainfo.f.duration', value: '9:99' },
      { labelKey: 'mediainfo.f.size', value: 'wrong' },
      { labelKey: 'mediainfo.f.container', value: 'wrong' },
      { labelKey: 'mediainfo.f.trackDemuxRes', value: '1920×1080' },
      { labelKey: 'mediainfo.f.trackDemuxFps', value: '23.976 fps' }
    ],
    'matroska',
    600,
    { stat: () => STAT }
  )
  const keys = p.rows.map((r) => r.labelKey)
  for (const k of ['mediainfo.f.duration', 'mediainfo.f.size', 'mediainfo.f.container']) {
    assert.equal(keys.filter((x) => x === k).length, 1, `${k} appears twice`)
  }
  const rows = byKey(p)
  assert.equal(rows.get('mediainfo.f.duration'), '10:00')
  assert.equal(rows.get('mediainfo.f.container'), 'Matroska (MKV)')
  assert.equal(rows.get('mediainfo.f.trackDemuxRes'), '1920×1080')
})
