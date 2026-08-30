import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketTime, chapterAt, LruMap } from './preview-state.ts'
import type { Chapter } from '../../../../shared/types.ts'

/**
 * The renderer half's arithmetic, with no DOM in sight.
 *
 * `shouldShowChapter` USED to be the one that earned its place here, and its
 * four tests all passed while the behaviour they described was false in the
 * shipped app: they asserted that this module stands down inside M25's +/-6 px
 * band, which is only the right answer if M25 prints exactly inside that band.
 * M25 printed at every position (24/24 measured, always chapter 0). A test of a
 * premise is not a test of the premise's truth.
 *
 * The de-duplication is the host's now — both layers tag a fragment
 * `role: 'chapter'` — and it is tested in `core/seekbar-host.test.ts`, against
 * layers that actually read `e.claimed`. What is left here is arithmetic this
 * module genuinely owns.
 */

const CHAPTERS: Chapter[] = [
  { title: 'Opening', time: 0 },
  { title: 'Part 1', time: 120 },
  { title: 'Part 2', time: 600 },
  { title: 'Credits', time: 1180 }
]

test('the caption names the chapter at or before the hover, never the next one', () => {
  assert.equal(chapterAt(CHAPTERS, 0)?.title, 'Opening')
  assert.equal(chapterAt(CHAPTERS, 119.9)?.title, 'Opening')
  assert.equal(chapterAt(CHAPTERS, 120)?.title, 'Part 1')
  assert.equal(chapterAt(CHAPTERS, 599)?.title, 'Part 1')
  assert.equal(chapterAt(CHAPTERS, 9999)?.title, 'Credits')
})

test('a hover before the first chapter has no caption', () => {
  assert.equal(chapterAt([{ title: 'Late', time: 30 }], 10), null)
  assert.equal(chapterAt([], 10), null)
})

test('chapters out of order still resolve to the latest one at or before t', () => {
  const jumbled: Chapter[] = [
    { title: 'Part 2', time: 600 },
    { title: 'Opening', time: 0 },
    { title: 'Part 1', time: 120 }
  ]
  assert.equal(chapterAt(jumbled, 500)?.title, 'Part 1')
})

test('the overlay buckets a hover the same way the main half does', () => {
  // Same shape as thumb-core.ts's bucketTime: clamp into the file, then round.
  assert.equal(bucketTime(37, 600, 2.5), 37.5)
  assert.equal(bucketTime(-5, 600, 2.5), 0)
  assert.equal(bucketTime(9999, 600, 2.5), 600)
  assert.equal(bucketTime(37, 600, 0), 37, 'a zero step is treated as one second')
})

test('the overlay cache is bounded and most-recently-used', () => {
  const lru = new LruMap<number>(2)
  lru.set('a', 1)
  lru.set('b', 2)
  assert.equal(lru.get('a'), 1)
  lru.set('c', 3)
  assert.equal(lru.get('b'), undefined)
  assert.equal(lru.get('a'), 1)
  assert.equal(lru.size, 2)
  lru.clear()
  assert.equal(lru.size, 0)
})
