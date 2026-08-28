import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { MpvClient } from './client'
import type { Chapter, PlayerState, Track } from '@shared/types'

/**
 * The mpv process and the PlayerState it feeds.
 *
 * WAVE 0 — FROZEN. Spawn arguments are no longer written here: `core/mpv/bus`
 * composes them from core's base set plus every module's `contributeArgs()`,
 * and hands the finished argv to `start()`. Property OBSERVATION is likewise
 * the bus's job — this class only knows how to turn a property change into the
 * core `PlayerState` the renderer paints.
 */

/**
 * The properties the core PlayerState is derived from. The bus subscribes to
 * these through the same refcounted path every module uses, so a module
 * observing `time-pos` costs zero extra `observe_property` calls.
 */
export const CORE_OBSERVED = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'speed',
  'track-list',
  'sid',
  'aid',
  'vid',
  'path',
  'media-title',
  'eof-reached',
  'idle-active',
  'chapter-list',
  'chapter',
  'demuxer-cache-state',
  'demuxer-via-network',
  'sub-delay',
  'audio-delay',
  'sub-scale',
  'sub-pos',
  'video-rotate',
  'video-aspect-override'
] as const

export function resolveMpvPath(): string {
  // Packaged: resources/mpv/mpv.exe sits next to app.asar via extraResources.
  // Dev: read straight out of the repo.
  const packaged = path.join(process.resourcesPath, 'mpv', 'mpv.exe')
  if (app.isPackaged && fs.existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'resources', 'mpv', 'mpv.exe')
}

export class MpvManager extends EventEmitter {
  readonly client = new MpvClient()
  private proc: ChildProcess | null = null
  private pipePath = ''
  private flushTimer: NodeJS.Timeout | null = null
  private stopping = false
  private lastStderr = ''
  /**
   * The pid, kept SEPARATELY from `proc` and never cleared until the process is
   * confirmed gone.
   *
   * `dispose()` used to be `setTimeout(() => this.proc?.kill(), 300)` inside
   * `before-quit`, which almost never fires: Electron tears the event loop down
   * long before 300 ms, so the IPC `quit` was in practice the only thing that
   * ever killed mpv and there was no fallback at all if it did not land.
   * Measured over ~50 launches: 2 silent Electron exits that orphaned mpv, and
   * 1 orphan after a graceful quit. A pid we can act on from a synchronous
   * `process.on('exit')` handler is the only fallback that cannot be skipped.
   */
  private pid: number | null = null
  private exitHook: (() => void) | null = null

  readonly state: PlayerState = {
    path: null,
    title: '',
    idle: true,
    paused: true,
    eof: false,
    timePos: 0,
    duration: 0,
    volume: 100,
    muted: false,
    speed: 1,
    tracks: [],
    sid: false,
    aid: false,
    vid: false,
    chapters: [],
    chapter: -1,
    cacheSeconds: 0,
    subDelay: 0,
    audioDelay: 0,
    subScale: 1,
    subPos: 100,
    fullscreen: false,
    alwaysOnTop: false,
    maximized: false,
    aspect: 'no',
    rotate: 0,
    network: false,
    // Overwritten from the real window topology on every pushState().
    layoutMode: 'overlay'
  }

  get running(): boolean {
    return this.proc !== null && this.client.connected
  }

  /** `args` is the composed argv from core/mpv/bus; this class adds nothing. */
  async start(args: readonly string[]): Promise<void> {
    const exe = resolveMpvPath()
    if (!fs.existsSync(exe)) {
      throw new Error(
        `mpv.exe not found at ${exe}. Run "npm run fetch:mpv" to download the playback engine.`
      )
    }
    this.stopping = false
    // Built by concatenation, never by templating: a template that folds
    // `\\.\pipe\` silently eats the backslashes (§7.7 trap 9).
    this.pipePath = '\\\\.\\pipe\\' + `rlplayer-mpv-${process.pid}-${Date.now()}`

    const argv = [`--input-ipc-server=${this.pipePath}`, ...args]

    this.proc = spawn(exe, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.pid = this.proc.pid ?? null
    this.installExitHook()
    this.proc.stderr?.on('data', (d: Buffer) => {
      this.lastStderr = d.toString().slice(-2000)
      console.error('[mpv]', d.toString().trim())
    })
    this.proc.on('exit', (code) => {
      this.proc = null
      this.pid = null
      this.removeExitHook()
      if (!this.stopping) this.emit('crashed', code, this.lastStderr)
    })
    this.proc.on('error', (e) => this.emit('crashed', -1, e.message))

    await this.client.connect(this.pipePath)

    this.client.on('mpv-event', (event: string, msg: Record<string, unknown>) => {
      this.emit('mpv-event', event, msg)
    })
  }

  /** Called by the bus for every observed property change. */
  applyProperty(name: string, data: unknown): void {
    const s = this.state
    switch (name) {
      case 'time-pos':
        s.timePos = typeof data === 'number' ? data : 0
        break
      case 'duration':
        s.duration = typeof data === 'number' ? data : 0
        break
      case 'pause':
        s.paused = data === true
        break
      case 'volume':
        s.volume = typeof data === 'number' ? Math.round(data) : s.volume
        break
      case 'mute':
        s.muted = data === true
        break
      case 'speed':
        s.speed = typeof data === 'number' ? data : 1
        break
      case 'track-list':
        s.tracks = mapTracks(data)
        break
      case 'sid':
        s.sid = typeof data === 'number' ? data : false
        break
      case 'aid':
        s.aid = typeof data === 'number' ? data : false
        break
      case 'vid':
        s.vid = typeof data === 'number' ? data : false
        break
      case 'path':
        s.path = typeof data === 'string' ? data : null
        break
      case 'media-title':
        s.title = typeof data === 'string' ? data : ''
        break
      case 'eof-reached':
        s.eof = data === true
        if (data === true) this.emit('eof')
        break
      case 'idle-active':
        s.idle = data === true
        break
      case 'chapter-list':
        s.chapters = mapChapters(data)
        break
      case 'chapter':
        s.chapter = typeof data === 'number' ? data : -1
        break
      case 'demuxer-cache-state':
        s.cacheSeconds = readCacheSeconds(data)
        break
      case 'demuxer-via-network':
        s.network = data === true
        break
      case 'sub-delay':
        s.subDelay = typeof data === 'number' ? data : 0
        break
      case 'audio-delay':
        s.audioDelay = typeof data === 'number' ? data : 0
        break
      case 'sub-scale':
        s.subScale = typeof data === 'number' ? data : 1
        break
      case 'sub-pos':
        s.subPos = typeof data === 'number' ? data : 100
        break
      case 'video-rotate':
        s.rotate = typeof data === 'number' ? data : 0
        break
      case 'video-aspect-override':
        // V22: mpv's "no override" value is the string 'no', not '-1'.
        s.aspect = data === undefined || data === null ? 'no' : String(data)
        break
      default:
        return
    }
    this.scheduleFlush()
  }

  /**
   * time-pos alone fires many times a second. Coalesce every state change into
   * at most one renderer message per frame-ish interval.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.emit('state')
    }, 100)
  }

  /**
   * Load a file, optionally resuming at `startAt` seconds.
   *
   * `-1` before the options map is mandatory: without it mpv HARD-ERRORS with
   * `{"error":"invalid parameter"}` (it does not silently drop the map, which
   * is what an earlier revision of the spec claimed three times). The `start`
   * option gets the first painted frame right so there is no flash at 0:00;
   * the explicit `absolute+exact` seek afterwards is what makes resume land on
   * the frame the user left rather than the nearest keyframe.
   */
  async loadFile(file: string, startAt?: number): Promise<void> {
    const resume = typeof startAt === 'number' && startAt > 1
    if (resume) {
      await this.client.command(['loadfile', file, 'replace', -1, { start: String(startAt) }])
    } else {
      await this.client.command(['loadfile', file, 'replace'])
    }
    if (resume) {
      // N41: wait for playback-restart, not file-loaded. The verified order is
      // start-file → file-loaded → seek → playback-restart, and a write made at
      // file-loaded can be dropped outright.
      await this.waitForEvent('playback-restart', 8000)
      await this.client.command(['seek', startAt, 'absolute+exact']).catch(() => {})
    }
    await this.client.setProperty('pause', false).catch(() => {})
  }

  waitForEvent(event: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.client.off('mpv-event', onEvent)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      const onEvent = (name: string): void => {
        if (name === event) done()
      }
      this.client.on('mpv-event', onEvent)
    })
  }

  async stop(): Promise<void> {
    await this.client.command(['stop']).catch(() => {})
  }

  /**
   * Used by the bus for a respawn: tear mpv down without emitting 'crashed'.
   *
   * It goes through the same escalation as the quit path rather than its own
   * hand-rolled 400 ms timeout, because a respawn that leaves the OLD mpv alive
   * puts two processes on one HWND — the exact failure the ladder exists for.
   */
  async shutdown(): Promise<void> {
    const result = await this.terminate(400)
    this.proc = null
    if (result.orphaned) {
      throw new Error('the previous mpv process would not exit; refusing to spawn a second one')
    }
  }

  /**
   * The quit path, with a fallback that cannot be skipped.
   *
   * Four escalating steps, each with a real deadline, and a SYNCHRONOUS last
   * resort registered on `process.on('exit')` so that even a path that never
   * awaits this — an uncaught throw, `app.exit()`, a window closing while the
   * quit hook is mid-flight — still reaps the child.
   *
   *   1. `quit` over the JSON IPC pipe. mpv shuts its VO down cleanly.
   *   2. `proc.kill()` (TerminateProcess on Windows) after `graceMs`.
   *   3. `taskkill /T /F` on the pid, for the case observed 3 times in 14 runs
   *      where mpv survived step 2: the D3D11 swapchain teardown can leave the
   *      process wedged in a kernel wait, and only the tree kill clears it.
   *   4. Verify. Steps 2 and 3 both RETURN before Windows has finished, so the
   *      loop below actually re-checks rather than trusting the exit code —
   *      which is why "taskkill said it worked" was never proof.
   */
  async terminate(graceMs = 1200): Promise<{ orphaned: boolean; escalated: string[] }> {
    this.stopping = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    const escalated: string[] = []

    await this.client.command(['quit']).catch(() => {})
    this.client.close()

    if (await this.waitForExit(graceMs)) return { orphaned: false, escalated }

    escalated.push('kill')
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    if (await this.waitForExit(600)) return { orphaned: false, escalated }

    escalated.push('taskkill /T /F')
    this.hardKill()
    const gone = await this.waitForExit(1500)
    if (gone) return { orphaned: false, escalated }
    console.error(`[mpv] pid ${this.pid} survived every kill; it is orphaned`)
    return { orphaned: true, escalated }
  }

  /** Polls the OS rather than trusting a kill's return value. */
  private async waitForExit(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!this.alive()) {
        this.pid = null
        this.removeExitHook()
        return true
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return !this.alive()
  }

  private alive(): boolean {
    const pid = this.pid
    if (pid === null) return false
    try {
      // Signal 0 does not deliver a signal; it only asks whether the pid exists
      // and is ours. On Windows it throws ESRCH once the process is reaped.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private hardKill(): void {
    const pid = this.pid
    if (pid === null) return
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* exit code 128 means "no such process", which is the outcome we wanted */
    }
  }

  /**
   * The fallback that cannot be skipped.
   *
   * `process.on('exit')` handlers must be synchronous, which is exactly why
   * this is `execFileSync`: at that point there is no event loop left to await
   * anything on, and an orphaned mpv holding a file handle is worse than a
   * 40 ms stall on a process that is exiting anyway.
   */
  private installExitHook(): void {
    if (this.exitHook) return
    const hook = (): void => {
      if (this.alive()) this.hardKill()
    }
    this.exitHook = hook
    process.on('exit', hook)
  }

  private removeExitHook(): void {
    if (!this.exitHook) return
    process.off('exit', this.exitHook)
    this.exitHook = null
  }

  /**
   * Kept for callers that cannot await (the crash path). It starts the same
   * escalation and relies on the `process.on('exit')` hook for the rest.
   */
  dispose(): void {
    void this.terminate()
  }
}

function mapTracks(data: unknown): Track[] {
  if (!Array.isArray(data)) return []
  const out: Track[] = []
  for (const raw of data as Record<string, unknown>[]) {
    const type = raw.type
    if (type !== 'video' && type !== 'audio' && type !== 'sub') continue
    out.push({
      id: Number(raw.id),
      type,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      lang: typeof raw.lang === 'string' ? raw.lang : undefined,
      selected: raw.selected === true,
      external: raw.external === true,
      codec: typeof raw.codec === 'string' ? raw.codec : undefined,
      // A10: "5.1" vs "stereo" is how a user tells two audio tracks apart when
      // both are titled nothing at all. Dropping it made the menu unusable on
      // exactly the releases that need it most.
      channels:
        typeof raw['audio-channels'] === 'number'
          ? `${raw['audio-channels'] as number}ch`
          : typeof raw['demux-channel-count'] === 'number'
            ? `${raw['demux-channel-count'] as number}ch`
            : undefined
    })
  }
  return out
}

function mapChapters(data: unknown): Chapter[] {
  if (!Array.isArray(data)) return []
  return (data as Record<string, unknown>[]).map((c, i) => ({
    title: typeof c.title === 'string' && c.title ? c.title : `Chapter ${i + 1}`,
    time: typeof c.time === 'number' ? c.time : 0
  }))
}

function readCacheSeconds(data: unknown): number {
  if (!data || typeof data !== 'object') return 0
  const v = (data as Record<string, unknown>)['cache-duration']
  return typeof v === 'number' ? v : 0
}
