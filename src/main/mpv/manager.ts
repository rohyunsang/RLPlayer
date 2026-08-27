import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { MpvClient } from './client'
import type { Chapter, PlayerState, Track } from '@shared/types'

/** Properties mpv pushes to us; everything the UI shows is derived from these. */
const OBSERVED = [
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
  'demuxer-cache-state',
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

export interface MpvOptions {
  hwnd: string
  volume: number
  muted: boolean
  speed: number
  hwdec: string
  audioDevice: string
  subScale: number
  subAssOverride: boolean
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
    cacheSeconds: 0,
    subDelay: 0,
    audioDelay: 0,
    subScale: 1,
    subPos: 100,
    fullscreen: false,
    alwaysOnTop: false,
    maximized: false,
    aspect: '-1',
    rotate: 0
  }

  async start(opts: MpvOptions): Promise<void> {
    const exe = resolveMpvPath()
    if (!fs.existsSync(exe)) {
      throw new Error(
        `mpv.exe not found at ${exe}. Run "npm run fetch:mpv" to download the playback engine.`
      )
    }
    this.pipePath = `\\\\.\\pipe\\rlplayer-mpv-${process.pid}-${Date.now()}`

    const args = [
      `--wid=${opts.hwnd}`,
      `--input-ipc-server=${this.pipePath}`,
      // Never read the user's global mpv config: RLPlayer must behave predictably.
      '--no-config',
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=yes',
      // mpv must not fight the overlay for input; the UI window owns all of it.
      '--input-default-bindings=no',
      '--input-vo-keyboard=no',
      '--input-cursor=no',
      '--osc=no',
      '--no-osd-bar',
      '--osd-level=0',
      '--terminal=yes',
      '--msg-level=all=error',
      // Zero network at startup: no youtube-dl hook, no scripts.
      '--ytdl=no',
      '--load-scripts=no',
      '--screenshot-format=png',
      '--screenshot-png-compression=3',
      '--volume-max=150',
      `--volume=${opts.volume}`,
      `--mute=${opts.muted ? 'yes' : 'no'}`,
      `--speed=${opts.speed}`,
      `--sub-scale=${opts.subScale}`,
      `--hwdec=${opts.hwdec || 'auto-safe'}`,
      '--vo=gpu-next',
      '--profile=high-quality',
      // Cheap and kills most judder on non-24Hz displays.
      '--video-sync=display-resample',
      // Subtitle auto-loading is mpv's job, not ours: `fuzzy` matches
      // `Show.S01E02.en.srt` against `Show.S01E02.mkv`, and sub-file-paths
      // covers the conventional subfolder names releases use.
      '--sub-auto=fuzzy',
      '--audio-file-auto=fuzzy',
      '--sub-file-paths=subs:Subs:subtitles:Subtitles:SUBS',
      // Render release-group styling as authored. Forcing our own font is
      // available in settings but must not be the default.
      `--sub-ass-override=${opts.subAssOverride ? 'force' : 'no'}`
    ]
    if (opts.audioDevice && opts.audioDevice !== 'auto') {
      args.push(`--audio-device=${opts.audioDevice}`)
    }

    this.proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

    this.client.on('property-change', (name: string, data: unknown) =>
      this.onProperty(name, data)
    )
    this.client.on('mpv-event', (event: string, msg: Record<string, unknown>) => {
      this.emit('mpv-event', event, msg)
    })

    for (const p of OBSERVED) await this.client.observeProperty(p)
    this.emit('state')
  }

  private onProperty(name: string, data: unknown): void {
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
      case 'demuxer-cache-state':
        s.cacheSeconds = readCacheSeconds(data)
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
        s.aspect = data === undefined || data === null ? '-1' : String(data)
        break
      default:
        break
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

  /** Load a file, optionally resuming at `startAt` seconds. */
  async loadFile(file: string, startAt?: number): Promise<void> {
    await this.client.command(['loadfile', file, 'replace'])
    if (startAt && startAt > 1) {
      // Seek only once mpv reports the file open, otherwise the seek is dropped.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.client.off('mpv-event', onEvent)
          resolve()
        }, 8000)
        const onEvent = (event: string): void => {
          if (event !== 'file-loaded') return
          this.client.off('mpv-event', onEvent)
          clearTimeout(timer)
          resolve()
        }
        this.client.on('mpv-event', onEvent)
      })
      // absolute+exact, never a plain keyframe seek: resuming to the nearest
      // keyframe can land tens of seconds away from where the user stopped.
      await this.client.command(['seek', startAt, 'absolute+exact']).catch(() => {})
    }
    await this.client.setProperty('pause', false).catch(() => {})
  }

  async stop(): Promise<void> {
    await this.client.command(['stop']).catch(() => {})
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
      codec: typeof raw.codec === 'string' ? raw.codec : undefined
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
