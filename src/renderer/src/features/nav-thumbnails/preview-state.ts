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
 * Whether THIS layer should print the chapter title, given that M25 also does.
 *
 * M25's `nav-chapters.ticks` layer contributes a chapter fragment whenever its
 * own `hitTest` claims the pointer, which is within `tolerancePx` (6, the host's
 * default) of a tick, and it only draws ticks at all with two or more chapters.
 * N37 wants the chapter for ANY hover position, so the two overlap in exactly
 * that 12 px band and would print the same title twice.
 *
 * There is no API to ask another layer whether it claimed a hover — and there
 * should not be one; a layer being able to see another layer's hit is how two
 * modules start depending on each other's internals. The band is derivable from
 * public information instead: the chapter list is in `PlayerState`, and
 * `timeToX` is on the layer context.
 */
export function shouldShowChapter(
  chapters: readonly Chapter[],
  t: number,
  pxPerSec: number,
  tolerancePx = 6
): boolean {
  if (chapters.length === 0) return false
  if (chapters.length < 2) return true // M25 draws no ticks, so nothing collides
  if (!(pxPerSec > 0)) return true
  const band = tolerancePx / pxPerSec
  return !chapters.some((ch) => Math.abs(ch.time - t) <= band)
}

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
