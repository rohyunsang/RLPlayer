/**
 * M27 nav-thumbnails — the pure half.
 *
 * Nothing in this file imports Electron, mpv, `fs` or `FeatureContext`, so
 * `node --test` exercises the real implementation rather than a copy of it
 * (§13). The argument builder lives here on purpose: N36's spawn line is
 * twenty-nine flags long and three of them are the difference between a
 * thumbnail and a corrupted one, so it is the part that most needs a test.
 */

/** The pixel size of one preview frame. Both dimensions are always even. */
export interface ThumbGeometry {
  readonly width: number
  readonly height: number
}

/** §2.6 N36 measured at this width: 288x162, 186 624 bytes, alpha 255. */
export const DEFAULT_THUMB_WIDTH = 288
export const MIN_THUMB_WIDTH = 160
export const MAX_THUMB_WIDTH = 480

/**
 * The arguments `ctx.engine.spawn()` applies to EVERY secondary itself
 * (`core/mpv/engine.ts`), plus the pipe it owns.
 *
 * Kept here as data rather than as a comment because `thumbnailerArgs()` must
 * not contribute any of them a second time, and a test can only assert that if
 * the list is a value. N36's spec line names `--no-config`,
 * `--msg-level=all=no`, `--terminal=no`, `--idle=yes`, `--load-scripts=no` and
 * `--ytdl=no`, all six of which core now applies: repeating them would work,
 * but the next person to read the array would not know which half is load
 * bearing.
 */
export const ENGINE_APPLIED_OPTIONS: readonly string[] = [
  '--no-config',
  '--idle',
  '--terminal',
  '--msg-level',
  '--load-scripts',
  '--ytdl',
  '--input-ipc-server'
]

function even(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : r + 1
}

/**
 * The preview size for a source displayed at `dw` x `dh`.
 *
 * `dw`/`dh` come from the PLAYING instance's `video-out-params`, never from the
 * thumbnailer: `--vf=scale` makes the secondary report the scaled size, so
 * asking it its own dimensions returns the answer you just told it (measured:
 * `dwidth`/`dheight` on the thumbnailer read back 288/162). §7.7 trap 9 also
 * says `dw`/`dh` already account for `video-rotate`, so there is no swap here.
 *
 * Both dimensions are forced even because `pad=…:x=-1:y=-1` centres on an even
 * grid; an odd height leaves a one-pixel bias the pad cannot correct.
 */
export function thumbSize(
  dw: number | undefined,
  dh: number | undefined,
  targetWidth: number = DEFAULT_THUMB_WIDTH
): ThumbGeometry {
  const width = even(clamp(targetWidth, MIN_THUMB_WIDTH, MAX_THUMB_WIDTH))
  // `undefined` is a real value from the bus (§3.3.1) — a file whose video
  // params have not arrived yet reports nothing, not 0.
  const ok = typeof dw === 'number' && typeof dh === 'number' && dw > 0 && dh > 0
  const height = ok ? even((width * (dh as number)) / (dw as number)) : even((width * 9) / 16)
  return { width, height: Math.max(2, height) }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Exactly the bytes one complete BGRA frame occupies. */
export function frameBytes(g: ThumbGeometry): number {
  return g.width * g.height * 4
}

/**
 * BGRA (what mpv writes) to RGBA (what `ImageData` reads), on a copy.
 *
 * §2.6 N36: "mpv writes BGRA; swap bytes 0 and 2 for ImageData". Done here in
 * main rather than in the overlay so it is a pure function with a test, and so
 * the renderer half stays a canvas and nothing else.
 */
export function bgraToRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let i = 0; i + 3 < src.length; i += 4) {
    out[i] = src[i + 2] as number
    out[i + 1] = src[i + 1] as number
    out[i + 2] = src[i] as number
    out[i + 3] = src[i + 3] as number
  }
  return out
}

// ---------------------------------------------------------------------------
// Bucketing — the reason a hover does not re-decode
// ---------------------------------------------------------------------------

/**
 * How coarse the cache grid is. 240 buckets over the whole file means a
 * 1920-wide seek bar changes bucket every 8 px, which is finer than a person
 * can aim and coarse enough that sweeping the bar end to end costs 240 decodes
 * once and zero decodes ever after.
 */
export const DEFAULT_BUCKETS = 240

/** Seconds per cache bucket. Never finer than half a second. */
export function bucketStep(duration: number, buckets: number = DEFAULT_BUCKETS): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return 1
  return Math.max(0.5, duration / Math.max(1, buckets))
}

/** The canonical time this hover position collapses to. */
export function bucketTime(t: number, duration: number, buckets: number = DEFAULT_BUCKETS): number {
  const step = bucketStep(duration, buckets)
  const capped = duration > 0 ? clamp(t, 0, duration) : Math.max(0, t)
  return Math.round(capped / step) * step
}

/** A cache key that changes when the file changes and when the size changes. */
export function frameKey(fileKey: string, geometry: ThumbGeometry, time: number): string {
  return `${fileKey}|${geometry.width}x${geometry.height}|${time.toFixed(3)}`
}

// ---------------------------------------------------------------------------
// LRU
// ---------------------------------------------------------------------------

/**
 * A bounded most-recently-used map.
 *
 * `Map` iterates in insertion order, so re-inserting on a hit is the whole of
 * the LRU. The bound is entries rather than bytes because every entry in this
 * cache is exactly `frameBytes()` long.
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

  has(key: string): boolean {
    return this.#map.has(key)
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

  delete(key: string): void {
    this.#map.delete(key)
  }

  clear(): void {
    this.#map.clear()
  }

  keys(): string[] {
    return [...this.#map.keys()]
  }
}

// ---------------------------------------------------------------------------
// The spawn line (§2.6 N36)
// ---------------------------------------------------------------------------

export interface ThumbnailerArgsInput {
  readonly file: string
  readonly geometry: ThumbGeometry
  /** Absolute path mpv rewrites on every decoded frame (`--ofopts=update=1`). */
  readonly outputFile: string
  /** The PLAYING instance's track/edition/rotation, so the preview matches it. */
  readonly vid?: number | undefined
  readonly edition?: number | undefined
  readonly videoRotate?: number | undefined
  readonly startSec?: number | undefined
}

/**
 * N36's literal spawn line, minus the seven options `ctx.engine.spawn()`
 * already applies.
 *
 * Two deprecation fixes are in here and both are load bearing, because mpv
 * accepts the old spellings and ignores them: `--load-console=no` (NOT
 * `--load-osd-console=no`) and `--hwdec-software-fallback=1` (NOT
 * `--vd-lavc-software-fallback=1`).
 *
 * The `--vf` is a spawn argument to a process this module owns outright, not a
 * write to the playing instance's `vf` property — `core/vf-chain` owns that one
 * and `ctx.vf` is how a module reaches it. There is no chain on a headless
 * encode-mode mpv to share with anybody.
 */
export function thumbnailerArgs(input: ThumbnailerArgsInput): string[] {
  const { width: w, height: h } = input.geometry
  const args = [
    // Hold the first frame instead of playing through the file.
    '--pause=yes',
    '--keep-open=always',
    '--osc=no',
    '--load-stats-overlay=no',
    // The current spelling. `--load-osd-console=no` is accepted and inert.
    '--load-console=no',
    '--load-auto-profiles=no',
    '--media-controls=no',
    '--no-audio',
    '--no-sub',
    `--start=${input.startSec !== undefined && input.startSec > 0 ? input.startSec : 0}`,
    // Hover seeks ask for keyframes explicitly; a global hr-seek would make
    // every one of them pay the exact-seek cost.
    '--hr-seek=no',
    // Read as little as possible: this process exists to decode single frames,
    // and a readahead buffer is memory the playing instance could be using.
    '--demuxer-readahead-secs=0',
    '--demuxer-max-bytes=128KiB',
    '--vd-lavc-skiploopfilter=all',
    '--vd-lavc-fast',
    '--vd-lavc-threads=2',
    // A second GPU decoder contending with the playing one costs more than it
    // saves at 288 px, and hwdec frames would have to be copied back anyway.
    '--hwdec=no',
    // The current spelling. `--vd-lavc-software-fallback=1` is accepted and inert.
    '--hwdec-software-fallback=1',
    `--vf=scale=w=${w}:h=${h},pad=w=${w}:h=${h}:x=-1:y=-1,format=bgra`,
    '--sws-scaler=fast-bilinear',
    '--sws-allow-zimg=no',
    `--video-rotate=${input.videoRotate ?? 0}`,
    '--ovc=rawvideo',
    '--of=image2',
    '--ofopts=update=1',
    `--o=${input.outputFile}`
  ]
  // `vid`/`edition` are `false`/`undefined` far more often than they are a
  // number (§3.3.1: "undefined is a real value"), and `--vid=false` is not a
  // thing mpv accepts.
  if (typeof input.vid === 'number' && input.vid > 0) args.push(`--vid=${input.vid}`)
  if (typeof input.edition === 'number' && input.edition >= 0) {
    args.push(`--edition=${input.edition}`)
  }
  // `--` so a file whose name begins with a dash is not read as an option.
  args.push('--', input.file)
  return args
}

/** The one-shot encode line behind `nav-thumbnails.getThumb` (L30, N14). */
export function posterArgs(input: {
  file: string
  outputFile: string
  width: number
  /** Seconds, or undefined for mpv's own percentage position. */
  timeSec?: number | undefined
}): string[] {
  const start =
    typeof input.timeSec === 'number' && input.timeSec >= 0 ? String(input.timeSec) : '10%'
  return [
    '--pause=yes',
    '--osc=no',
    '--load-stats-overlay=no',
    '--load-console=no',
    '--load-auto-profiles=no',
    '--media-controls=no',
    '--no-audio',
    '--no-sub',
    `--start=${start}`,
    // A poster is asked for once and looked at for as long as the panel is
    // open, so it is worth an exact seek that the hover path cannot afford.
    '--hr-seek=yes',
    '--frames=1',
    '--hwdec=no',
    '--hwdec-software-fallback=1',
    `--vf=scale=w=${even(input.width)}:h=-2`,
    '--sws-scaler=fast-bilinear',
    '--ovc=png',
    '--of=image2',
    `--o=${input.outputFile}`,
    '--',
    input.file
  ]
}

/** True when `args` re-states an option `ctx.engine.spawn()` already applies. */
export function conflictsWithEngineArgs(args: readonly string[]): string[] {
  const names = args
    .filter((a) => a.startsWith('--'))
    .map((a) => a.split('=')[0] as string)
  return names.filter((n) => ENGINE_APPLIED_OPTIONS.includes(n))
}

// ---------------------------------------------------------------------------
// The request scheduler
// ---------------------------------------------------------------------------

export interface FrameRequest {
  readonly time: number
  readonly exact: boolean
}

/**
 * One decode in flight, and only the newest waiting request survives.
 *
 * A hover crossing a two-hour file touches a hundred buckets in a second. Every
 * one of them queued would be a hundred seeks mpv performs after the pointer
 * has left, so the queue is one slot deep: a request arriving while another is
 * running REPLACES whatever was waiting. The pointer's current position is the
 * only one anybody wants.
 *
 * The exact-on-settle upgrade is why `exact` is compared rather than only the
 * time: an exact request for a time that already has a keyframe frame is real
 * work, not a duplicate.
 */
export class FrameScheduler {
  #pending: FrameRequest | null = null
  #running = false

  readonly #run: (r: FrameRequest) => Promise<void>
  readonly #onError: (e: Error, r: FrameRequest) => void

  constructor(
    run: (r: FrameRequest) => Promise<void>,
    onError: (e: Error, r: FrameRequest) => void = () => {}
  ) {
    this.#run = run
    this.#onError = onError
  }

  get busy(): boolean {
    return this.#running
  }

  get queued(): FrameRequest | null {
    return this.#pending
  }

  request(r: FrameRequest): void {
    this.#pending = r
    if (!this.#running) void this.#drain()
  }

  /** Drop anything waiting. Used when the file changes under us. */
  reset(): void {
    this.#pending = null
  }

  async #drain(): Promise<void> {
    this.#running = true
    try {
      for (;;) {
        const next = this.#pending
        if (!next) return
        this.#pending = null
        try {
          await this.#run(next)
        } catch (e) {
          // One failed decode must not wedge the loop: the next hover has to
          // still be able to ask.
          this.#onError(e as Error, next)
        }
      }
    } finally {
      this.#running = false
    }
  }
}
