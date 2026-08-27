import { spawn, type ChildProcess } from 'node:child_process'
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
    this.proc.stderr?.on('data', (d: Buffer) => {
      this.lastStderr = d.toString().slice(-2000)
      console.error('[mpv]', d.toString().trim())
    })
    this.proc.on('exit', (code) => {
      this.proc = null
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

  /** Used by the bus for a respawn: tear mpv down without emitting 'crashed'. */
  async shutdown(): Promise<void> {
    this.stopping = true
    await this.client.command(['quit']).catch(() => {})
    this.client.close()
    const proc = this.proc
    this.proc = null
    if (proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill()
          resolve()
        }, 400)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  dispose(): void {
    this.stopping = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.client.command(['quit']).catch(() => {})
    this.client.close()
    setTimeout(() => this.proc?.kill(), 300)
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
