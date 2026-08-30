import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineService, Logger } from '@shared/feature-api'
import { posterArgs } from './thumb-core.ts'

/**
 * M27 nav-thumbnails — the `nav-thumbnails.getThumb` mediator's engine.
 *
 * §2.6 L30 was corrected to split the playlist's thumbnail VIEW MODE (M28's,
 * because the rows are M28's files) from the THUMBNAIL itself (M27's, because
 * the second mpv is M27's). This is the M27 half: one frame from an arbitrary
 * file, cached as a PNG under `ctx.paths.thumbCacheDir()`, which is also what
 * N14 asks for when M26 pins a bookmark.
 *
 * WHY A SEPARATE PROCESS FROM THE HOVER THUMBNAILER, given L30's "build ONE
 * shared engine, not two". The shared thing is the SPAWNER — `ctx.engine`, in
 * core, which is what that warning was written against and what did not exist
 * when it was written. The instance cannot be shared: the hover thumbnailer is
 * pinned to the playing file by its argv and writes raw BGRA to a fixed path
 * through `--o`, and `--o`, `--start` and the input file are all spawn-scoped.
 * A poster for a playlist row two hundred entries down is a different file.
 *
 * Requests are serialised, so a playlist scrolling forty rows past the viewport
 * produces at most ONE mpv at a time rather than forty.
 *
 * `--frames=1` does NOT end the process, because `ctx.engine.spawn()` always
 * applies `--idle=yes`: mpv writes its frame and then sits idle. The wait is
 * therefore on the FILE, never on the exit code, and `close()` is what ends it.
 */

export interface PosterOptions {
  readonly engine: EngineService
  readonly log: Logger
  /** `ctx.paths.thumbCacheDir()`. */
  readonly dir: string
  /** Prune the directory to this many bytes after each write (N38's warning). */
  readonly limitBytes: number
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

export interface PosterRequest {
  readonly path: string
  /** Seconds. Omitted means 10% in, which skips most title cards. */
  readonly timeSec?: number | undefined
  readonly width?: number | undefined
}

const POLL_MS = 20
const TIMEOUT_MS = 12_000
const DEFAULT_WIDTH = 320

/**
 * Identity for a cached poster.
 *
 * Size and mtime are in the key because a path is not an identity: re-encoding
 * a file in place under the same name is exactly how a stale thumbnail outlives
 * the frame it came from.
 */
export function posterKey(req: {
  path: string
  size: number
  mtimeMs: number
  width: number
  timeSec: number | null
}): string {
  const h = crypto.createHash('sha1')
  h.update(
    [req.path.toLowerCase(), req.size, Math.round(req.mtimeMs), req.width, req.timeSec ?? 'auto'].join(
      '|'
    )
  )
  return h.digest('hex')
}

/**
 * Delete oldest-first until the directory fits.
 *
 * §2.6 N38: "an LRU byte cap or a 4K library silently eats a gigabyte". mtime
 * is the recency signal rather than a sidecar index, because the index would be
 * one more thing that can disagree with the disk.
 */
export function pruneDir(dir: string, limitBytes: number): { removed: number; bytes: number } {
  let entries: Array<{ file: string; size: number; mtimeMs: number }> = []
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { file: path.join(dir, f), size: st.size, mtimeMs: st.mtimeMs }
      })
  } catch {
    return { removed: 0, bytes: 0 }
  }
  let total = entries.reduce((n, e) => n + e.size, 0)
  if (total <= limitBytes) return { removed: 0, bytes: total }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let removed = 0
  for (const e of entries) {
    if (total <= limitBytes) break
    try {
      fs.rmSync(e.file, { force: true })
      total -= e.size
      removed++
    } catch {
      /* someone else has it open; the next prune will get it */
    }
  }
  return { removed, bytes: total }
}

export class PosterCache {
  readonly #opts: PosterOptions
  /** One request at a time, whoever asked. */
  #chain: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(opts: PosterOptions) {
    this.#opts = opts
  }

  /** The cached PNG's absolute path, generating it if this is the first ask. */
  async get(req: PosterRequest): Promise<string | null> {
    const next = this.#chain.then(
      () => this.#run(req),
      () => this.#run(req)
    )
    this.#chain = next.catch(() => undefined)
    return next
  }

  async #run(req: PosterRequest): Promise<string | null> {
    if (this.#closed) return null
    let stat: fs.Stats
    try {
      stat = fs.statSync(req.path)
    } catch {
      // A queue entry for a file that has been moved or unplugged is normal.
      return null
    }
    const width = req.width ?? DEFAULT_WIDTH
    const timeSec = typeof req.timeSec === 'number' ? req.timeSec : null
    const key = posterKey({
      path: req.path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      width,
      timeSec
    })
    const out = path.join(this.#opts.dir, `${key}.png`)
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      // Touch it so the LRU prune reads it as recently used.
      try {
        const now = new Date()
        fs.utimesSync(out, now, now)
      } catch {
        /* not fatal; it only costs this entry some of its lifetime */
      }
      return out
    }

    fs.mkdirSync(this.#opts.dir, { recursive: true })
    // A partial file from a previous failed attempt would be returned as a
    // valid poster by the existsSync above on the next call.
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* ignore */
    }

    const engine = await this.#opts.engine.spawn({
      purpose: 'thumbnail',
      args: posterArgs({
        file: req.path,
        outputFile: out,
        width,
        timeSec: timeSec ?? undefined
      }),
      // A backstop only: the finally below closes it on every path. It exists
      // because `--frames=1` plus core's `--idle=yes` means mpv never exits by
      // itself, so a throw between here and the finally would leave it sitting.
      idleTimeoutMs: 20_000
    })
    try {
      const ok = await this.#awaitFile(out)
      if (!ok) {
        this.#opts.log.warn(`no poster frame for ${path.basename(req.path)}`)
        try {
          fs.rmSync(out, { force: true })
        } catch {
          /* ignore */
        }
        return null
      }
      pruneDir(this.#opts.dir, this.#opts.limitBytes)
      return out
    } finally {
      await engine.close().catch(() => undefined)
    }
  }

  /** A PNG is done when its size stops growing, not when mpv says anything. */
  async #awaitFile(file: string): Promise<boolean> {
    const interval = this.#opts.pollIntervalMs ?? POLL_MS
    const deadline = Date.now() + (this.#opts.timeoutMs ?? TIMEOUT_MS)
    let last = -1
    let stable = 0
    for (;;) {
      let size = -1
      try {
        size = fs.statSync(file).size
      } catch {
        size = -1
      }
      if (size > 0 && size === last) {
        if (++stable >= 2) return true
      } else {
        stable = 0
      }
      last = size
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  dispose(): void {
    this.#closed = true
  }
}
