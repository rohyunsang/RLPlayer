import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BOOKMARKS,
  cycleAbLoop,
  defaultTitle,
  formatPrecise,
  formatTime,
  loopCountToMpv,
  loopPoint,
  makeId,
  mergeBookmarks,
  nextBookmark,
  nudgePoint,
  parseImport,
  prevBookmark,
  remainingLoops,
  sanitizeBookmarks,
  subtitleLoop,
  toExportJson,
  toFfmetadata,
  type Bookmark
} from './bookmarks.ts'

/**
 * M26's own logic, exercised directly.
 *
 * The cases below are not "does the happy path work". Every one of them is a
 * value §2.5 says was MEASURED against the pinned mpv and that a reasonable
 * implementation gets wrong: a cleared A-B point that is the string `"no"` and
 * not a number, an `ab-loop-count` whose "infinite" is `"inf"` and whose `0`
 * means "off", a `remaining-ab-loops` that reads `-1` rather than null, and a
 * `sub-start` that is null when no line is on screen.
 */

const bm = (t: number, title: string, b?: number): Bookmark => {
  const out: Bookmark = { id: makeId(), t, title, createdAt: t }
  if (b !== undefined) out.b = b
  return out
}

// --- mpv value coercion (N17, N21) -----------------------------------------

test('a cleared A-B point is null, never 0', () => {
  // The measured value. `typeof data === 'number'` would have read this as
  // unset-and-therefore-0 and drawn a loop region starting at the file's start.
  assert.equal(loopPoint('no'), null)
  assert.equal(loopPoint(undefined), null)
  assert.equal(loopPoint(null), null)
  assert.equal(loopPoint(2.466667), 2.466667)
  // 0 IS a legitimate A point: a loop that starts at the first frame.
  assert.equal(loopPoint(0), 0)
})

test('loop count 0 means infinite and is written as the string "inf"', () => {
  // §2.5 N21: writing 0 to ab-loop-count DISABLES A-B looping entirely, so
  // "the user asked for unlimited repeats" must never reach mpv as 0.
  assert.equal(loopCountToMpv(0), 'inf')
  assert.equal(loopCountToMpv(-3), 'inf')
  assert.equal(loopCountToMpv(Number.NaN), 'inf')
  assert.equal(loopCountToMpv(3), 3)
  assert.equal(loopCountToMpv(3.9), 3)
  assert.equal(loopCountToMpv(100000), 999)
})

test('remaining-ab-loops reads -1 for "infinite", not null', () => {
  assert.equal(remainingLoops(-1), null)
  assert.equal(remainingLoops(undefined), null)
  assert.equal(remainingLoops(0), 0)
  assert.equal(remainingLoops(2), 2)
})

// --- the A-B cycle (N17) ---------------------------------------------------

test('the one-key cycle is A then B then clear', () => {
  const first = cycleAbLoop({ a: null, b: null }, 10)
  assert.deepEqual(first, { a: 10, b: null })
  const second = cycleAbLoop(first, 25)
  assert.deepEqual(second, { a: 10, b: 25 })
  assert.deepEqual(cycleAbLoop(second, 40), { a: null, b: null })
})

test('a B behind A restarts the cycle instead of storing an inverted pair', () => {
  // mpv cannot play b < a, and storing it silently is how "A-B does nothing"
  // gets reported as a bug with no reproduction.
  assert.deepEqual(cycleAbLoop({ a: 30, b: null }, 12), { a: 12, b: null })
  assert.deepEqual(cycleAbLoop({ a: 30, b: null }, 30), { a: 30, b: null })
})

test('an A at 0 is a real A, so the second press still sets B', () => {
  assert.deepEqual(cycleAbLoop({ a: 0, b: null }, 5), { a: 0, b: 5 })
})

// --- nudging (N18) ---------------------------------------------------------

test('nudging an unset endpoint is a no-op, because mpv errors on it', () => {
  // `['add','ab-loop-a',0.1]` on a property holding "no" is an mpv ERROR.
  assert.equal(nudgePoint(null, 0.1), null)
  assert.equal(nudgePoint(null, -0.1), null)
})

test('nudging rounds to milliseconds and never goes negative', () => {
  assert.equal(nudgePoint(1.2, 0.1), 1.3)
  assert.equal(nudgePoint(0.05, -0.1), 0)
  // 0.1 + 0.2 in binary floating point is 0.30000000000000004; a loop point
  // that grows a tail of digits every nudge is unreadable in the OSD.
  assert.equal(nudgePoint(0.1, 0.2), 0.3)
})

// --- the subtitle loop (N20 / S41) -----------------------------------------

test('no subtitle on screen yields no loop rather than a zero-length one', () => {
  assert.equal(subtitleLoop(null, null, 0, 0.2), null)
  assert.equal(subtitleLoop(12, null, 0, 0.2), null)
  assert.equal(subtitleLoop(undefined, undefined, 0, 0.2), null)
})

test('the subtitle loop applies sub-delay and adds a tail to B', () => {
  // A/B are VIDEO time and sub-start/sub-end are SUBTITLE time; without the
  // delay the loop drifts by exactly the sync the user just corrected.
  const loop = subtitleLoop(10, 12, 0.5, 0.2)
  assert.deepEqual(loop, { a: 10.5, b: 12.7 })
})

test('a negative sub-delay cannot push A below zero', () => {
  const loop = subtitleLoop(0.2, 1.5, -1, 0.2)
  assert.equal(loop?.a, 0)
})

test('a zero-length subtitle line produces no loop', () => {
  assert.equal(subtitleLoop(5, 5, 0, 0), null)
})

// --- next / previous (N12) -------------------------------------------------

test('next and previous respect the 0.25s dead zone', () => {
  const list = [bm(10, 'a'), bm(20, 'b'), bm(30, 'c')]
  // Standing one frame past a bookmark, "next" must not return the bookmark
  // you are standing on.
  assert.equal(nextBookmark(list, 10.1)?.title, 'b')
  assert.equal(prevBookmark(list, 19.9)?.title, 'a')
  assert.equal(nextBookmark(list, 30), null)
  assert.equal(prevBookmark(list, 10), null)
})

test('next and previous work on an unsorted list', () => {
  const list = [bm(30, 'c'), bm(10, 'a'), bm(20, 'b')]
  assert.equal(nextBookmark(list, 0)?.title, 'a')
  assert.equal(prevBookmark(list, 100)?.title, 'c')
})

// --- the store's parser ----------------------------------------------------

test('sanitize survives a hand-edited record', () => {
  const parsed = sanitizeBookmarks([
    { t: '12.5', title: 'string time' },
    { t: 5 },
    { t: -1, title: 'negative' },
    { title: 'no time' },
    null,
    'nonsense',
    { t: 40, title: 'inverted section', b: 30 }
  ])
  assert.deepEqual(
    parsed.map((b) => [b.t, b.title, b.b]),
    [
      [5, defaultTitle(5), undefined],
      [12.5, 'string time', undefined],
      [40, 'inverted section', undefined]
    ]
  )
})

test('sanitize gives duplicate ids new ones so the panel can address a row', () => {
  const parsed = sanitizeBookmarks([
    { id: 'same', t: 1, title: 'x' },
    { id: 'same', t: 2, title: 'y' }
  ])
  assert.equal(parsed.length, 2)
  assert.notEqual(parsed[0]?.id, parsed[1]?.id)
})

test('sanitize caps the list', () => {
  const many = Array.from({ length: MAX_BOOKMARKS + 50 }, (_, i) => ({ t: i, title: `#${i}` }))
  assert.equal(sanitizeBookmarks(many).length, MAX_BOOKMARKS)
})

test('sanitize of a non-array is an empty list, not a throw', () => {
  assert.deepEqual(sanitizeBookmarks(undefined), [])
  assert.deepEqual(sanitizeBookmarks({ bookmarks: [] }), [])
})

// --- formatting ------------------------------------------------------------

test('timecodes carry hours only when there are hours', () => {
  assert.equal(formatTime(72), '1:12')
  assert.equal(formatTime(3723), '1:02:03')
  assert.equal(formatTime(-5), '0:00')
  assert.equal(formatTime(Number.NaN), '0:00')
})

test('an A-B endpoint reads to a tenth, which is what the nudge moves', () => {
  assert.equal(formatPrecise(72.44), '1:12.4')
  assert.equal(formatPrecise(72.99), '1:12.9')
  assert.equal(formatPrecise(0), '0:00.0')
})

test('a bookmark is never nameless', () => {
  assert.equal(defaultTitle(72), '1:12')
})

// --- export / import (N15) -------------------------------------------------

test('ffmetadata borrows the next start, or the duration, as an END', () => {
  const text = toFfmetadata([bm(10, 'one'), bm(20, 'two')], 60)
  assert.match(text, /^;FFMETADATA1\n/)
  assert.match(text, /START=10000\nEND=20000\ntitle=one/)
  assert.match(text, /START=20000\nEND=60000\ntitle=two/)
})

test('a section bookmark exports its own END', () => {
  const text = toFfmetadata([bm(10, 'section', 14.5)], 60)
  assert.match(text, /START=10000\nEND=14500/)
})

test('END always exceeds START, or ffmpeg drops the chapter silently', () => {
  // A bookmark AT the end of the file, and a live stream whose duration is 0,
  // both leave nothing to borrow an END from.
  assert.match(toFfmetadata([bm(60, 'last')], 60), /START=60000\nEND=61000/)
  assert.match(toFfmetadata([bm(60, 'live')], 0), /START=60000\nEND=61000/)
  assert.match(toFfmetadata([bm(0, 'first')], 0), /START=0\nEND=1000/)
})

test('ffmetadata escapes the five characters its parser treats as syntax', () => {
  const text = toFfmetadata([bm(1, 'a=b;c#d\\e')], 10)
  assert.match(text, /title=a\\=b\\;c\\#d\\\\e/)
})

test('our own JSON round-trips', () => {
  const list = [bm(10, 'one'), bm(20, 'two', 25)]
  const back = parseImport(toExportJson('C:\\v\\a.mkv', list))
  assert.deepEqual(
    back.map((b) => [b.t, b.title, b.b]),
    [
      [10, 'one', undefined],
      [20, 'two', 25]
    ]
  )
})

test('ffmetadata round-trips, including the timebase and the escapes', () => {
  const back = parseImport(toFfmetadata([bm(10.25, 'a=b'), bm(20, 'two')], 60))
  assert.deepEqual(
    back.map((b) => [b.t, b.title]),
    [
      [10.25, 'a=b'],
      [20, 'two']
    ]
  )
})

test('an ffmetadata file with a different timebase is read in that timebase', () => {
  const back = parseImport(
    [';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000000', 'START=2500000', 'END=3000000', 'title=x'].join(
      '\n'
    )
  )
  assert.equal(back[0]?.t, 2.5)
})

test('import never throws on a file that is not ours', () => {
  assert.deepEqual(parseImport(''), [])
  assert.deepEqual(parseImport('{ not json'), [])
  assert.deepEqual(parseImport('hello'), [])
  // An ffmetadata file with global tags and no chapters is valid and empty.
  assert.deepEqual(parseImport(';FFMETADATA1\ntitle=whole file\n'), [])
})

test('merge skips a bookmark that is already there and honours the cap', () => {
  const existing = [bm(10, 'one')]
  const merged = mergeBookmarks(existing, [bm(10.005, 'one'), bm(30, 'three')])
  assert.deepEqual(merged.map((b) => b.title), ['one', 'three'])
  const full = Array.from({ length: MAX_BOOKMARKS }, (_, i) => bm(i, `#${i}`))
  assert.equal(mergeBookmarks(full, [bm(9999, 'extra')]).length, MAX_BOOKMARKS)
})

test('ids are unique across a burst in the same millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => makeId(1_700_000_000_000)))
  assert.equal(ids.size, 500)
})
