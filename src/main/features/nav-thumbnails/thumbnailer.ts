import fs from 'node:fs'
import type { EngineService, Logger, SecondaryEngine } from '@shared/feature-api'
import { frameBytes, thumbnailerArgs, type ThumbGeometry } from './thumb-core.ts'

/**
 * M27 nav-thumbnails — the second mpv, and the frame reader.
 *
 * The process is `ctx.engine.spawn()`'s, never `child_process`': core registers
 * it, reaps it on the quit path BEFORE the playing instance, covers it with one
 * synchronous `process.on('exit')` fallback and idle-kills it (§12). "No orphan
 * mpv on quit" has to mean all of them.
 *
 * ---------------------------------------------------------------------------
 * THE READ PATH, AND WHY IT IS NOT THE ONE THE SPEC WRITES DOWN
 * ---------------------------------------------------------------------------
 * §2.6's N36 row gives the read side as:
 *
 *     rm(dst); rename(out, dst); accept only if size === W*H*4; readFileSync(dst)
 *
 * Measured against the pinned mpv (v0.41.0-923-g7b8915bc1, samples/bbb_long.mp4,
 * 288x162), that returns THE PREVIOUS FRAME. Asking for the same timestamp twice
 * in a row is the shortest proof, because a correct reader must answer with the
 * same pixels both times:
 *
 *     spec order   t=40 -> [0,0,0]        t=40 -> [32,71,51]     (differ)
 *                  t=150 -> [32,71,51]    t=150 -> [129,154,188] (differ)
 *     this order   t=40 -> [32,71,51]     t=40 -> [32,71,51]     (agree)
 *                  t=150 -> [129,154,188] t=150 -> [129,154,188] (agree)
 *
 * The first read of the spec order returns the `--start=` frame — black, because
 * the file opens on black — for a request at t=40, and every read after that is
 * one behind. The size check cannot see it: a stale frame is also exactly
 * W*H*4 bytes, which is the whole reason the check looks sufficient.
 *
 * The fix is one line and it is an ORDERING, not a validation: delete the output
 * file BEFORE issuing the seek, so any file that appears afterwards was written
 * by that seek. Then poll for `size === W*H*4` and only then rename it aside.
 * `--ofopts=update=1` rewrites the same path per frame and `--pause=yes` means
 * no frame is produced except in answer to a seek, so "a file exists" becomes
 * an unambiguous signal instead of a race.
 */

export interface ThumbnailerOptions {
  readonly engine: EngineService
  readonly log: Logger
  /** The media file this instance is pinned to. A new file needs a new one. */
  readonly file: string
  readonly geometry: ThumbGeometry
  readonly outputFile: string
  readonly vid?: number | undefined
  readonly edition?: number | undefined
  readonly videoRotate?: number | undefined
  /** §6.3's M27 criterion: the process dies 60 s after the last hover. */
  readonly idleTimeoutMs?: number
  /** Test seams. Defaults are the measured ones. */
  readonly pollIntervalMs?: number
  readonly frameTimeoutMs?: number
}

const POLL_MS = 5
/** Measured worst case on the pinned binary was 185 ms for an exact seek. */
const FRAME_TIMEOUT_MS = 3000

export class Thumbnailer {
  readonly #opts: ThumbnailerOptions
  readonly #dst: string
  #engine: SecondaryEngine | null = null
  #starting: Promise<SecondaryEngine> | null = null
  #closed = false

  constructor(opts: ThumbnailerOptions) {
    this.#opts = opts
    this.#dst = `${opts.outputFile}.frame`
  }

  get file(): string {
    return this.#opts.file
  }

  get geometry(): ThumbGeometry {
    return this.#opts.geometry
  }

  /** True once a process exists. The first hover is what pays for it (N36). */
  get spawned(): boolean {
    return this.#engine !== null || this.#starting !== null
  }

  /**
   * Lazy spawn. ~40-60 MB RSS, so a session that never hovers the seek bar
   * never pays for it, and one that hovers twice pays once.
   */
  async #ensure(): Promise<SecondaryEngine> {
    if (this.#closed) throw new Error('thumbnailer closed')
    const live = this.#engine
    if (live && live.running) return live
    if (this.#starting) return this.#starting
    const args = thumbnailerArgs({
      file: this.#opts.file,
      geometry: this.#opts.geometry,
      outputFile: this.#opts.outputFile,
      vid: this.#opts.vid,
      edition: this.#opts.edition,
      videoRotate: this.#opts.videoRotate
    })
    this.#starting = this.#opts.engine
      .spawn({
        purpose: 'thumbnail',
        args,
        idleTimeoutMs: this.#opts.idleTimeoutMs ?? 60_000
      })
      .then((e) => {
        // Closing while the spawn was in flight must not leave a live process
        // behind; core would reap it on quit, but not before then.
        if (this.#closed) {
          void e.close()
          throw new Error('thumbnailer closed while spawning')
        }
        this.#engine = e
        return e
      })
      .finally(() => {
        this.#starting = null
      })
    return this.#starting
  }

  /**
   * One frame at `time`.
   *
   * `exact: false` is the keyframe seek that runs while the pointer is moving;
   * `exact: true` is the settle-time upgrade. Returns the raw BGRA bytes mpv
   * wrote, or null when the seek produced no frame inside the timeout — an
   * audio-only file and a stream whose demuxer is still filling both do that,
   * and neither is an error worth a toast.
   */
  async grab(time: number, exact: boolean): Promise<Uint8Array | null> {
    const engine = await this.#ensure()
    // Whatever is at the output path right now belongs to the PREVIOUS seek.
    // Removing it first is what makes "a file appeared" mean "this seek
    // finished" — see the header.
    this.#discard(this.#opts.outputFile)
    await engine.command([
      'async',
      'seek',
      time,
      exact ? 'absolute+exact' : 'absolute+keyframes'
    ])
    return this.#readFrame()
  }

  async #readFrame(): Promise<Uint8Array | null> {
    const want = frameBytes(this.#opts.geometry)
    const interval = this.#opts.pollIntervalMs ?? POLL_MS
    const deadline = Date.now() + (this.#opts.frameTimeoutMs ?? FRAME_TIMEOUT_MS)
    for (;;) {
      try {
        // A short frame is one mpv is still writing; a long one cannot happen
        // with rawvideo at a fixed size, so it means the geometry moved and the
        // frame belongs to a size nobody asked for.
        if (fs.statSync(this.#opts.outputFile).size === want) {
          this.#discard(this.#dst)
          // The rename is what takes the frame away from mpv, so nothing can
          // read the same file twice and believe it is two frames.
          fs.renameSync(this.#opts.outputFile, this.#dst)
          const bytes = fs.readFileSync(this.#dst)
          if (bytes.length === want) return new Uint8Array(bytes)
        }
      } catch {
        // ENOENT while the seek is still running, or EPERM in the sliver where
        // mpv still holds the handle. Both are "not yet", not "failed".
      }
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  #discard(file: string): void {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* a locked file is retried on the next grab; it is never fatal */
    }
  }

  /** Idempotent. Core reaps whatever is left on quit, so this is politeness. */
  async close(): Promise<void> {
    this.#closed = true
    const engine = this.#engine
    this.#engine = null
    try {
      await engine?.close()
    } catch (e) {
      this.#opts.log.warn('closing the thumbnailer engine failed:', (e as Error).message)
    }
    this.#discard(this.#opts.outputFile)
    this.#discard(this.#dst)
  }
}
