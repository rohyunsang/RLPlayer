import type { Chapter } from '../../../../shared/types.ts'

/**
 * M27 nav-thumbnails, renderer half — the parts with no DOM in them.
 *
 * Split out so `node --test` can exercise the hover arithmetic directly. The
 * chapter-collision rule below is the one worth testing: it is the difference
 * between N37 and M25 composing in one tooltip and the two of them printing the
 * same chapter title twice.
 */

/**
 * The canonical time a hover position collapses to.
 *
 * Deliberately the same shape as `bucketTime()` in the main half — clamp, then
 * round to the step main sent in its status push — so the overlay can answer a
 * hover out of its own cache without a round trip. Main re-buckets every request
 * anyway and its answer carries the authoritative time, so a disagreement here
 * costs one wasted decode and never a wrong frame.
 */
export function bucketTime(t: number, duration: number, stepSec: number): number {
  const step = stepSec > 0 ? stepSec : 1
  const capped = duration > 0 ? Math.min(Math.max(t, 0), duration) : Math.max(0, t)
  return Math.round(capped / step) * step
}

/** N37: the chapter whose `time` is the greatest one at or before `t`. */
export function chapterAt(chapters: readonly Chapter[], t: number): Chapter | null {
  // A full scan rather than a break on the first chapter past `t`: mpv lists
  // chapters in order today, and a silently wrong caption is not worth assuming
  // it always will.
  let found: Chapter | null = null
  for (const ch of chapters) {
    if (ch.time <= t + 1e-6 && (found === null || ch.time > found.time)) found = ch
  }
  return found
}

/**
 * `shouldShowChapter()` USED TO BE HERE, AND ITS DELETION IS THE POINT.
 *
 * It answered "should this layer print the chapter title, given that M25 also
 * does?" by re-deriving M25's hit-test band from the chapter list, the bar width
 * and M25's `tolerancePx`. The premise — "M25 only prints within +/-6 px of a
 * tick" — was false twice:
 *
 *   1. M25 printed at EVERY position. Its tooltip did
 *      `chapters[Number(e.handle)]` and the host passed `''` for "no handle", so
 *      `Number('') === 0` named chapter 0 unconditionally. Measured over 24
 *      positions in the packaged build: 24/24 said "Intro", and 22 of them
 *      contradicted this module's caption inside the same box.
 *   2. Even with that fixed, M25 prints only when its `hitTest` WINS against
 *      every other layer on the bar. Whether it did is not derivable from
 *      anything a foreign module can see, and an API that let one layer ask
 *      would be an API that couples two modules' internals.
 *
 * So the de-duplication moved to the host, which is the only thing that knows
 * who claimed the pointer: both layers tag their fragment `role: 'chapter'` and
 * `SeekbarHost.tooltips()` keeps one. There is no arithmetic left to test here,
 * which is the correct amount for a question this module cannot answer.
 */

/**
 * A bounded most-recently-used map, so sweeping the bar twice decodes once.
 *
 * Duplicated deliberately rather than imported from the main half: the two
 * processes share no bundle, and reaching across `src/main` from the overlay to
 * save fifteen lines would drag Node-side code into the renderer chunk.
 */
export class LruMap<V> {
  readonly #limit: number
  readonly #map = new Map<string, V>()

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  get size(): number {
    return this.#map.size
  }

  get(key: string): V | undefined {
    const v = this.#map.get(key)
    if (v === undefined) return undefined
    this.#map.delete(key)
    this.#map.set(key, v)
    return v
  }

  set(key: string, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    while (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next()
      if (oldest.done === true) break
      this.#map.delete(oldest.value)
    }
  }

  clear(): void {
    this.#map.clear()
  }
}
