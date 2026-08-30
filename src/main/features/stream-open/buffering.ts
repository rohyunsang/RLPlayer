/**
 * M35 R16 / R24 — the buffering model.
 *
 * A pure reducer from the raw mpv property values to the one object the renderer
 * paints. No mpv, no DOM: `buffering.test.ts` drives it with the literal shapes
 * the spec says were measured over JSON IPC, including the ones that are absent.
 *
 * THE RULE THAT SHAPES THE WHOLE FILE. R16 says "gate all this UI on
 * `demuxer-via-network`". So `network: false` is a distinct variant carrying
 * NOTHING else, rather than a flag beside fields that happen to be zero. A local
 * file and a stalled stream both have `cache-buffering-state` around 0, and the
 * difference between "not applicable" and "0%" is the difference between a clean
 * seek bar and a permanently-buffering one.
 */

/** One entry of `demuxer-cache-state/seekable-ranges`. */
export interface CacheRange {
  readonly start: number
  readonly end: number
}

/** The subset of `demuxer-cache-state` R16 names, all of it optional. */
export interface DemuxerCacheState {
  readonly 'fw-bytes'?: unknown
  readonly 'raw-input-rate'?: unknown
  readonly 'seekable-ranges'?: unknown
  readonly 'bof-cached'?: unknown
  readonly 'eof-cached'?: unknown
  readonly 'cache-end'?: unknown
  readonly 'reader-pts'?: unknown
  readonly 'cache-duration'?: unknown
  readonly 'file-cache-bytes'?: unknown
}

/** Exactly what the module peeks off the bus, `undefined` included. */
export interface BufferInputs {
  readonly viaNetwork: unknown
  readonly pausedForCache: unknown
  readonly bufferingState: unknown
  readonly cacheSpeed: unknown
  readonly cacheDuration: unknown
  readonly cacheTime: unknown
  readonly duration: unknown
  readonly seekable: unknown
  readonly cacheState: DemuxerCacheState | undefined
}

export type BufferState =
  | { readonly network: false }
  | {
      readonly network: true
      /** True while playback is stalled waiting for the cache. */
      readonly stalled: boolean
      /** 0..100, the number to render. `null` when mpv has not said. */
      readonly percent: number | null
      /** Seconds of readahead, or `null`. */
      readonly seconds: number | null
      /** Bytes of forward cache, or `null`. */
      readonly forwardBytes: number | null
      /** Bytes/s, a SOFT hint: the manual says it may be inaccurate or missing. */
      readonly inputRate: number | null
      /** Bytes/s the cache is filling at, or `null`. */
      readonly cacheSpeed: number | null
      /** Bytes on disk when R18's cache-on-disk is on, or `null`. */
      readonly fileCacheBytes: number | null
      /** R24: the cached window, merged and sorted. Possibly empty. */
      readonly ranges: readonly CacheRange[]
      readonly bofCached: boolean
      readonly eofCached: boolean
      /** R24: a live stream, so the seek bar shows the window and not 0..duration. */
      readonly live: boolean
    }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown): boolean {
  return v === true
}

/**
 * Merge and sort the seekable ranges.
 *
 * mpv reports them in demuxer order and they can touch or overlap after a seek.
 * Painting them unmerged draws seams on the seek bar that look like gaps in the
 * buffer, which is the opposite of what R16 wants the widget to communicate.
 * Anything that is not a pair of finite numbers with `end > start` is dropped:
 * `[]`, `null` entries and a `{start: 5, end: 5}` empty range all reach here.
 */
export function normalizeRanges(raw: unknown): CacheRange[] {
  if (!Array.isArray(raw)) return []
  const clean: CacheRange[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const start = num(rec['start'])
    const end = num(rec['end'])
    if (start === null || end === null || end <= start) continue
    clean.push({ start, end })
  }
  clean.sort((a, b) => a.start - b.start)

  const merged: CacheRange[] = []
  for (const r of clean) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) {
      if (r.end > last.end) merged[merged.length - 1] = { start: last.start, end: r.end }
      continue
    }
    merged.push(r)
  }
  return merged
}

/**
 * R24's live test.
 *
 * `duration` is 0 or unknown for a live stream, and `seekable` is false until
 * `--force-seekable=yes` makes seeking-within-the-cache work — at which point
 * mpv reports the media as seekable while the duration is still unknown. So the
 * test is on the DURATION, not on `seekable`: with force-seekable on, a
 * seekable-based test flips a live stream to "not live" and the seek bar goes
 * back to pretending there is a 0..duration timeline to scrub.
 */
export function isLive(duration: unknown, seekable: unknown): boolean {
  const d = num(duration)
  if (d === null || d <= 0) return true
  void seekable
  return false
}

export function deriveBufferState(i: BufferInputs): BufferState {
  // The gate. `demuxer-via-network` is `undefined` before the first file and
  // `false` for a local one; neither is a stream.
  if (!bool(i.viaNetwork)) return { network: false }

  const cs = i.cacheState ?? {}
  const percent = num(i.bufferingState)
  return {
    network: true,
    stalled: bool(i.pausedForCache),
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
    // `demuxer-cache-duration` is the property; `cache-duration` inside
    // `demuxer-cache-state` is the same number and is the fallback, because the
    // property is unavailable on some sources while the struct still has it.
    seconds: num(i.cacheDuration) ?? num(cs['cache-duration']),
    forwardBytes: num(cs['fw-bytes']),
    inputRate: num(cs['raw-input-rate']),
    cacheSpeed: num(i.cacheSpeed),
    fileCacheBytes: num(cs['file-cache-bytes']),
    ranges: normalizeRanges(cs['seekable-ranges']),
    bofCached: bool(cs['bof-cached']),
    eofCached: bool(cs['eof-cached']),
    live: isLive(i.duration, i.seekable)
  }
}

/** Human bytes for the stats overlay. No locale formatting: it is a number. */
export function formatBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

export function formatRate(n: number | null): string {
  return n === null ? '—' : `${formatBytes(n)}/s`
}

/**
 * The R24 seek window, for a bar that must not pretend to be 0..duration.
 *
 * Returns the span the cached ranges actually cover. `null` when there is
 * nothing cached, so the caller renders an empty bar rather than a 0..0 one that
 * divides by zero.
 */
export function seekWindow(ranges: readonly CacheRange[]): { start: number; end: number } | null {
  if (ranges.length === 0) return null
  const first = ranges[0] as CacheRange
  const last = ranges[ranges.length - 1] as CacheRange
  return { start: first.start, end: last.end }
}
