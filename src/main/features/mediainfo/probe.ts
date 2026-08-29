/**
 * M29 mediainfo -- L22, the headless mpv probe, and L21's cache on top of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PROBE IS FOR
 * ---------------------------------------------------------------------------
 * L21: "duration for a non-playing file is **not** available from the playing
 * instance". The playlist wants a duration column, L40 wants a hover tooltip,
 * and neither can be answered by reading `duration` off the mpv that is playing
 * something else. So: a second, idle mpv, `loadfile` per file, read the demuxer,
 * `stop`.
 *
 * Four things this file gets right on purpose, each because the spec measured
 * them:
 *
 *  1. LAZY, AND ONE AT A TIME. "Serialise requests one file at a time." A probe
 *     is a `loadfile` on a single shared instance -- two in flight would race on
 *     the same demuxer -- and L21's real requirement is that opening a 500-row
 *     playlist does not probe 500 files. Nothing spawns until the first request.
 *  2. `demux-*` ONLY. "`video-params`/`audio-params` are **not** available (they
 *     need an initialised decoder) -- use `demux-*` in the probe path." The
 *     engine runs with `--no-video --no-audio`, which does NOT hide tracks:
 *     `track-list` comes from the demuxer and every `demux-*` field is there.
 *     Reading `video-params` here would return `undefined` for every file and a
 *     column of dashes is indistinguishable from a broken probe.
 *  3. A TIMEOUT, AND `stop` EITHER WAY. A file on a disconnected network share
 *     blocks `file-loaded` for as long as the OS feels like it. After the
 *     timeout the entry is answered as a failure and `stop` is issued anyway, or
 *     the instance stays wedged on that file and every later probe answers with
 *     its data.
 *  4. THE PIPE NAME IS CORE'S. `ctx.engine.spawn()` generates a random
 *     `--input-ipc-server` per instance, which L22 calls mandatory: mpv's IPC is
 *     "explicitly insecure" and exposes the `run` command. This file never names
 *     a pipe, and that is why it uses `ctx.engine` rather than
 *     `ctx.paths.mpvBinary()` plus `child_process`.
 *
 * Every dependency is injected so the whole thing is testable with no mpv, no
 * Electron and no disk (docs/parity/02-wave0-api.md section 13).
 */
import { formatBytes, formatDuration, formatFps, textOr, UNKNOWN } from './format.ts'
import type { InfoRow, ProbeSummary } from '@shared/features/mediainfo/wire'

/** The slice of `SecondaryEngine` the probe uses. */
export interface ProbeEngine {
  readonly running: boolean
  command<T = unknown>(args: unknown[]): Promise<T>
  getProperty<T = unknown>(name: string): Promise<T>
  onEvent(event: string, cb: (msg: Record<string, unknown>) => void): () => void
  close(): Promise<void>
}

export interface FileStat {
  size: number
  mtimeMs: number
  birthtimeMs: number
}

export interface ProbeDeps {
  /** Spawns the engine. Called at most once per live instance. */
  spawn(): Promise<ProbeEngine>
  /** `fs.statSync`, or null when the path is gone. Size and date are free. */
  stat(path: string): FileStat | null
  /** Milliseconds to wait for `file-loaded`. L22 says 2 s. */
  timeoutMs(): number
  /** Close the engine this long after the last request. 0 keeps it forever. */
  idleMs(): number
  /** False turns the probe off entirely; every request answers 'disabled'. */
  enabled(): boolean
  log: { warn(...args: unknown[]): void }
  /** Entries restored from disk at boot (L21: "persist results"). */
  restore?(): Record<string, ProbeSummary>
  /** Called after a successful probe so the caller can persist the cache. */
  persist?(entries: Record<string, ProbeSummary>): void
}

const MAX_CACHE_ENTRIES = 2000

/**
 * L21's cache key: "persist results keyed by `path + size + mtimeMs`".
 *
 * Not the path alone. A re-encode that keeps the filename is a different file,
 * and a cache keyed on the path would show the old duration for ever -- which is
 * exactly the kind of stale-metadata bug that makes users distrust the column.
 */
export function cacheKey(path: string, stat: FileStat | null): string {
  if (!stat) return `${path}|?|?`
  return `${path}|${stat.size}|${Math.round(stat.mtimeMs)}`
}

function countType(list: unknown, type: string): number {
  if (!Array.isArray(list)) return 0
  return list.filter((t) => t !== null && typeof t === 'object' && (t as Record<string, unknown>)['type'] === type)
    .length
}

/**
 * The tooltip L40 renders. Built here, as a string, so M28's playlist row does
 * not have to know anything about media info to show one.
 */
export function tooltipFor(s: Omit<ProbeSummary, 'tooltip'>): string {
  const parts: string[] = []
  if (s.durationSec !== null) parts.push(formatDuration(s.durationSec))
  if (s.container) parts.push(s.container)
  if (s.sizeBytes !== null) parts.push(formatBytes(s.sizeBytes).replace(/ \(.*\)$/, ''))
  const tracks: string[] = []
  if (s.videoCount > 0) tracks.push(`V${s.videoCount}`)
  if (s.audioCount > 0) tracks.push(`A${s.audioCount}`)
  if (s.subCount > 0) tracks.push(`S${s.subCount}`)
  if (tracks.length > 0) parts.push(tracks.join('/'))
  if (!s.ok && s.reason) parts.push(`(${s.reason})`)
  return parts.join(' · ')
}

function rowsFor(raw: Readonly<Record<string, unknown>>, stat: FileStat | null): InfoRow[] {
  const rows: InfoRow[] = []
  const push = (labelKey: string, value: string): void => {
    if (value !== UNKNOWN) rows.push({ labelKey, value })
  }
  push('mediainfo.f.duration', formatDuration(raw['duration']))
  push('mediainfo.f.container', textOr(raw['file-format']))
  push('mediainfo.f.size', formatBytes(stat ? stat.size : raw['file-size']))
  const list = Array.isArray(raw['track-list']) ? (raw['track-list'] as unknown[]) : []
  const first = list.find(
    (t) => t !== null && typeof t === 'object' && (t as Record<string, unknown>)['type'] === 'video'
  ) as Record<string, unknown> | undefined
  if (first) {
    const w = first['demux-w']
    const h = first['demux-h']
    if (typeof w === 'number' && typeof h === 'number') {
      // "as declared by the container" (L24) -- `demux-*` are claims, and this
      // path has nothing better, so the label says which it is.
      push('mediainfo.f.trackDemuxRes', `${w}×${h}`)
    }
    push('mediainfo.f.trackDemuxFps', formatFps(first['demux-fps']))
  }
  return rows
}

/**
 * A serialised, cached, lazily-spawned metadata probe.
 *
 * One instance per module. `dispose()` closes the engine; the engine is also
 * reaped by core on the quit path, so `dispose()` is politeness rather than the
 * guarantee (section 12).
 */
export class MediaProbe {
  readonly #deps: ProbeDeps
  readonly #cache = new Map<string, ProbeSummary>()
  #engine: ProbeEngine | null = null
  #starting: Promise<ProbeEngine> | null = null
  /** The tail of the request chain. Every probe awaits the previous one. */
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  #inFlight = 0

  constructor(deps: ProbeDeps) {
    this.#deps = deps
    const restored = deps.restore?.()
    if (restored) {
      for (const [k, v] of Object.entries(restored).slice(-MAX_CACHE_ENTRIES)) {
        this.#cache.set(k, v)
      }
    }
  }

  /** For the stats overlay and the tests: how many files are remembered. */
  get cacheSize(): number {
    return this.#cache.size
  }

  get queueLength(): number {
    return this.#inFlight
  }

  /** A cached answer, without spawning anything. L40's hover path checks this
   *  first so a traversal of a 500-row list enqueues nothing. */
  peek(path: string): ProbeSummary | null {
    const stat = this.#deps.stat(path)
    return this.#cache.get(cacheKey(path, stat)) ?? null
  }

  async probe(path: string): Promise<ProbeSummary> {
    const stat = this.#deps.stat(path)
    const key = cacheKey(path, stat)
    const hit = this.#cache.get(key)
    if (hit) return hit

    const base: Omit<ProbeSummary, 'tooltip'> = {
      path,
      ok: false,
      durationSec: null,
      sizeBytes: stat ? stat.size : null,
      modifiedMs: stat ? Math.round(stat.mtimeMs) : null,
      container: null,
      title: null,
      videoCount: 0,
      audioCount: 0,
      subCount: 0,
      rows: []
    }

    if (!this.#deps.enabled()) return this.#finish(key, { ...base, reason: 'disabled' }, false)
    if (this.#disposed) return this.#finish(key, { ...base, reason: 'disposed' }, false)
    if (!stat) return this.#finish(key, { ...base, reason: 'missing' }, false)

    this.#inFlight++
    const run = this.#queue.then(
      () => this.#runOne(path, stat, base, key),
      () => this.#runOne(path, stat, base, key)
    )
    // The chain must survive a rejection, or one bad file stops every later
    // probe for the lifetime of the process.
    this.#queue = run.then(
      () => undefined,
      () => undefined
    )
    try {
      return await run
    } finally {
      this.#inFlight--
    }
  }

  async #runOne(
    path: string,
    stat: FileStat,
    base: Omit<ProbeSummary, 'tooltip'>,
    key: string
  ): Promise<ProbeSummary> {
    let engine: ProbeEngine
    try {
      engine = await this.#ensure()
    } catch (e) {
      this.#deps.log.warn('probe engine failed to start:', (e as Error).message)
      return this.#finish(key, { ...base, reason: 'engine' }, false)
    }

    /**
     * The subscriptions are held in `let`s that `cleanup()` reads, rather than
     * closed over as `const`s below the callbacks that call it. A fake engine in
     * a test -- and, for a cached demuxer, a real one -- can deliver
     * `file-loaded` synchronously from inside `onEvent()`, and a `const` declared
     * after the callback would be a TDZ ReferenceError at exactly that moment.
     * The renderer host's own `ctx.state.subscribe` replay bug in section 10 is
     * the same shape: "declare first, subscribe last".
     */
    const loaded = new Promise<'loaded' | 'error' | 'timeout'>((resolve) => {
      let offLoaded: (() => void) | null = null
      let offEnd: (() => void) | null = null
      let timer: NodeJS.Timeout | null = null
      let settled = false
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        offLoaded?.()
        offEnd?.()
      }
      const settle = (r: 'loaded' | 'error' | 'timeout'): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(r)
      }
      offLoaded = engine.onEvent('file-loaded', () => settle('loaded'))
      // mpv answers an unreadable file with `end-file`, not with silence. Waiting
      // the full timeout for it would make a folder of broken files take
      // 2 seconds each.
      offEnd = engine.onEvent('end-file', (msg) => {
        if (msg['reason'] === 'error' || msg['reason'] === 'unknown') settle('error')
      })
      timer = setTimeout(() => settle('timeout'), Math.max(100, this.#deps.timeoutMs()))
      timer.unref?.()
      if (settled) cleanup()
    })

    try {
      // Trap 1: the options-map form of `loadfile` hard-errors without the
      // insertion index. Nothing here passes options, and the explicit `-1` is
      // still spelled out so the shape is never one argument away from the
      // failing one.
      await engine.command(['loadfile', path, 'replace', -1])
    } catch (e) {
      this.#deps.log.warn(`probe loadfile failed for ${path}:`, (e as Error).message)
      return this.#finish(key, { ...base, reason: 'error' }, false)
    }

    const outcome = await loaded
    if (outcome !== 'loaded') {
      await engine.command(['stop']).catch(() => {})
      return this.#finish(key, { ...base, reason: outcome }, false)
    }

    const raw: Record<string, unknown> = {}
    for (const name of ['duration', 'track-list', 'metadata', 'file-format', 'file-size']) {
      // "property unavailable" is a normal answer -- `file-size` on a stream,
      // `duration` on a live source -- so a rejection is a missing field, never
      // a failed probe.
      raw[name] = await engine.getProperty(name).catch(() => undefined)
    }
    await engine.command(['stop']).catch(() => {})

    const list = raw['track-list']
    const meta = raw['metadata']
    const title =
      meta !== null && typeof meta === 'object'
        ? ((meta as Record<string, unknown>)['title'] ?? (meta as Record<string, unknown>)['TITLE'])
        : undefined

    return this.#finish(
      key,
      {
        ...base,
        ok: true,
        durationSec: typeof raw['duration'] === 'number' ? raw['duration'] : null,
        container: typeof raw['file-format'] === 'string' ? raw['file-format'] : null,
        title: typeof title === 'string' ? title : null,
        videoCount: countType(list, 'video'),
        audioCount: countType(list, 'audio'),
        subCount: countType(list, 'sub'),
        rows: rowsFor(raw, stat)
      },
      true
    )
  }

  #finish(key: string, s: Omit<ProbeSummary, 'tooltip'>, cache: boolean): ProbeSummary {
    const full: ProbeSummary = { ...s, tooltip: tooltipFor(s) }
    if (cache) {
      this.#cache.set(key, full)
      // Insertion-ordered eviction: the oldest key is the first one Map yields.
      while (this.#cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.#cache.keys().next()
        if (oldest.done) break
        this.#cache.delete(oldest.value)
      }
      this.#deps.persist?.(Object.fromEntries(this.#cache))
    }
    return full
  }

  async #ensure(): Promise<ProbeEngine> {
    if (this.#engine && this.#engine.running) return this.#engine
    if (this.#starting) return this.#starting
    this.#starting = this.#deps
      .spawn()
      .then((e) => {
        this.#engine = e
        this.#starting = null
        return e
      })
      .catch((e) => {
        this.#starting = null
        throw e
      })
    return this.#starting
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const e = this.#engine
    this.#engine = null
    if (e) await e.close().catch(() => {})
  }

  /** The spawn arguments L22 specifies, minus the ones core always applies. */
  static engineArgs(): string[] {
    return [
      // No output devices at all: this instance must never take the audio
      // device from the playing mpv or flash a window.
      '--vo=null',
      '--ao=null',
      // "`--no-video --no-audio` does **not** hide tracks: `track-list` comes
      // from the demuxer and every `demux-*` field is available."
      '--no-video',
      '--no-audio',
      // Without this the instance sits at EOF holding the file open, and the
      // next `loadfile` races the previous file's teardown.
      '--keep-open=no'
    ]
  }
}
