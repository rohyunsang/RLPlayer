import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketTime, chapterAt, LruMap, shouldShowChapter } from './preview-state.ts'
import type { Chapter } from '../../../../shared/types.ts'

/**
 * The renderer half's arithmetic, with no DOM in sight.
 *
 * `shouldShowChapter` is the one that earns its place: it is the only thing
 * stopping N37's caption and M25's tick tooltip from printing the same chapter
 * title twice inside the one shared `.seek-hover` box, and it has to do it
 * without either module knowing anything about the other.
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

test('the caption stands down inside M25 tick tolerance, and nowhere else', () => {
  // A 1200 px bar over a 1200 s file: 1 px per second, so M25's 6 px tolerance
  // is a 6 s band on either side of every tick.
  const pxPerSec = 1
  assert.equal(shouldShowChapter(CHAPTERS, 300, pxPerSec), true, 'mid-chapter is ours')
  assert.equal(shouldShowChapter(CHAPTERS, 120, pxPerSec), false, 'exactly on a tick is M25s')
  assert.equal(shouldShowChapter(CHAPTERS, 124, pxPerSec), false, 'inside the tolerance band')
  assert.equal(shouldShowChapter(CHAPTERS, 127, pxPerSec), true, 'outside it again')
})

test('the band scales with the bar, not with the file', () => {
  // The same 6 px on a 120 px bar over the same 1200 s file is a 60 s band.
  assert.equal(shouldShowChapter(CHAPTERS, 150, 0.1), false)
  assert.equal(shouldShowChapter(CHAPTERS, 300, 0.1), true)
})

test('with fewer than two chapters M25 draws no ticks, so the caption always shows', () => {
  const one: Chapter[] = [{ title: 'Only', time: 0 }]
  assert.equal(shouldShowChapter(one, 0, 1), true)
  assert.equal(shouldShowChapter([], 0, 1), false, 'no chapters means no caption at all')
})

test('a zero-width bar does not divide by zero', () => {
  assert.equal(shouldShowChapter(CHAPTERS, 300, 0), true)
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
