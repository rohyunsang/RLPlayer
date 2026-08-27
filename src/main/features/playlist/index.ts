import fs from 'node:fs'
import path from 'node:path'
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isMediaFile,
  isSubtitleFile
} from '@shared/media-types'
import { scanFolder, shuffleOrder } from '../../services/playlist.ts'
import { loadConfig, saveConfig } from '../../services/config.ts'
import type { PlaylistItem, PlaylistState } from '@shared/types'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'

/**
 * M28 playlist — the queue, file opening and resume.
 *
 * WAVE 0 SEED: the new owner of `next`, `previous`, `stop` and
 * `togglePlaylist`, and of everything the 578-line `Player` class used to do
 * with files. It is the single entry point for "play these files"
 * (`playlist.openPaths`, §3.7.3), which is why M33's shell integration, M34's
 * associations and M35's URL pipeline all call it rather than issuing their
 * own `loadfile`.
 *
 * The app owns the playlist and mpv's own playlist always holds one entry
 * (§7.6). That is what keeps Explorer sort order, per-file resume, multi-select
 * and non-destructive shuffle; the cost is a ~200 ms gap between episodes.
 */

const POSITION_SAVE_INTERVAL_MS = 5000

let ctx: FeatureContext
let items: PlaylistItem[] = []
let index = -1
let shuffleQueue: number[] = []
let shufflePos = 0
let currentFile: string | null = null
let saveTimer: NodeJS.Timeout | null = null

const state = (): { idle: boolean; timePos: number; duration: number } => ({
  idle: ctx.mpv.peek<boolean>('idle-active') === true,
  timePos: ctx.mpv.peek<number>('time-pos') ?? 0,
  duration: ctx.mpv.peek<number>('duration') ?? 0
})

function push(): void {
  const cfg = loadConfig()
  const payload: PlaylistState = {
    items,
    index,
    open: cfg.playlistPanelOpen,
    repeat: cfg.repeat,
    shuffle: cfg.shuffle
  }
  ctx.ipc.send('playlist:state', payload)
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

function reshuffleIfNeeded(): void {
  if (!loadConfig().shuffle) return
  shuffleQueue = shuffleOrder(items.length, index)
  shufflePos = 0
}

/**
 * Everything that must happen before the current file goes away: flush its
 * position and let every per-file slice capture. mpv's `end-file` arrives with
 * some properties already reset, so this is done here rather than reactively.
 */
function flushCurrent(): void {
  ctx.perFile.captureNow()
}

async function playCurrent(): Promise<void> {
  const item = items[index]
  if (!item) return
  currentFile = item.path
  const cfg = loadConfig()

  const entry = cfg.resumePlayback ? ctx.perFile.resumeFor(item.path) : null
  const startAt = entry?.position

  if (startAt && startAt > 1) {
    // §7.7 trap 2: the `-1` is mandatory. Without it, `loadfile` with an
    // options map HARD-ERRORS with {"error":"invalid parameter"} — it does not
    // silently drop the map.
    await ctx.mpv.command(['loadfile', item.path, 'replace', -1, { start: String(startAt) }])
    // N41: playback-restart, not file-loaded. `start` gets the first painted
    // frame right; the exact seek is what makes resume land on the frame the
    // user left rather than the nearest keyframe.
    await once('playback-restart', 8000)
    await ctx.mpv.command(['seek', startAt, 'absolute+exact']).catch(() => undefined)
  } else {
    await ctx.mpv.command(['loadfile', item.path, 'replace'])
  }
  // `pause` is core-owned (it is the transport, §3.7), so this goes through
  // core's command rather than a raw property write.
  await ctx.commands.invoke('core.play')

  if (entry) {
    ctx.osd.toast({
      kind: 'resume',
      message: `${formatTime(entry.position)} 부터 이어서 재생합니다`,
      actionLabel: '처음부터',
      onAction: () => void restartCurrent()
    })
  }
  push()
}

function once(event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = ctx.mpv.onEvent(event, () => {
      clearTimeout(timer)
      off()
      resolve()
    })
    const timer = setTimeout(() => {
      off()
      resolve()
    }, timeoutMs)
  })
}

async function open(file: string): Promise<void> {
  if (!file) return
  let resolved: string
  try {
    resolved = fs.realpathSync.native(file)
  } catch {
    resolved = path.resolve(file)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    ctx.osd.toast({ kind: 'error', message: `파일을 찾을 수 없습니다: ${path.basename(file)}` })
    return
  }
  flushCurrent()
  const scan = scanFolder(resolved)
  items = scan.items
  index = scan.index
  reshuffleIfNeeded()
  await playCurrent()
}

async function openMany(files: string[]): Promise<void> {
  const media = files.filter((f) => {
    try {
      return fs.statSync(f).isFile() && isMediaFile(f)
    } catch {
      return false
    }
  })
  if (media.length === 0) {
    const first = files[0]
    if (first) await open(first)
    return
  }
  if (media.length === 1) return open(media[0]!)

  flushCurrent()
  items = media.map((p) => ({ path: p, name: path.basename(p) }))
  index = 0
  reshuffleIfNeeded()
  await playCurrent()
}

/** The single entry point for "play these files" (§3.7.3). */
async function openPaths(paths: string[]): Promise<void> {
  const clean = paths.filter((p) => typeof p === 'string' && p.length > 0)
  if (clean.length === 0) return

  // U34: a dropped FOLDER is a perfectly ordinary thing to open, and v0.1
  // discarded it because it only looked at files.
  const expanded: string[] = []
  for (const p of clean) {
    try {
      if (fs.statSync(p).isDirectory()) {
        for (const name of fs.readdirSync(p)) {
          const full = path.join(p, name)
          if (isMediaFile(full)) expanded.push(full)
        }
        continue
      }
    } catch {
      continue
    }
    expanded.push(p)
  }

  const subs = expanded.filter(isSubtitleFile)
  const media = expanded.filter((p) => !isSubtitleFile(p))

  if (media.length > 0) {
    await openMany(media)
    // A video and its subtitle dropped together: attach after the load.
    for (const s of subs) await attach(s)
    return
  }
  for (const s of subs) await attach(s)
}

async function attach(file: string): Promise<void> {
  // M17 owns sid and the external-track set; we ask rather than sub-add here.
  await ctx.commands.invoke('subs-tracks.addFile', file)
}

async function next(auto = false): Promise<void> {
  const cfg = loadConfig()
  if (items.length === 0) return

  if (auto && cfg.repeat === 'one') {
    await ctx.mpv.command(['seek', 0, 'absolute']).catch(() => undefined)
    await ctx.commands.invoke('core.play')
    return
  }

  let nextIndex: number
  if (cfg.shuffle && shuffleQueue.length > 0) {
    shufflePos++
    if (shufflePos >= shuffleQueue.length) {
      if (auto && cfg.repeat !== 'all') return stopAtEnd()
      shuffleQueue = shuffleOrder(items.length, -1)
      shufflePos = 0
    }
    nextIndex = shuffleQueue[shufflePos] ?? 0
  } else {
    nextIndex = index + 1
    if (nextIndex >= items.length) {
      if (auto && cfg.repeat !== 'all') return stopAtEnd()
      nextIndex = 0
    }
  }
  flushCurrent()
  index = nextIndex
  await playCurrent()
}

async function previous(): Promise<void> {
  if (items.length === 0) return
  // Match every other player: within the first 3s go back a file, otherwise
  // restart the current one.
  if (state().timePos > 3) {
    await ctx.mpv.command(['seek', 0, 'absolute']).catch(() => undefined)
    return
  }
  const cfg = loadConfig()
  flushCurrent()
  if (cfg.shuffle && shuffleQueue.length > 0) {
    shufflePos = Math.max(0, shufflePos - 1)
    index = shuffleQueue[shufflePos] ?? 0
  } else {
    index = index - 1 < 0 ? items.length - 1 : index - 1
  }
  await playCurrent()
}

async function stopAtEnd(): Promise<void> {
  await ctx.commands.invoke('core.pause')
}

async function restartCurrent(): Promise<void> {
  if (currentFile) ctx.perFile.forget(currentFile)
  await ctx.mpv.command(['seek', 0, 'absolute']).catch(() => undefined)
  await ctx.commands.invoke('core.play')
}

function savePosition(): void {
  const s = state()
  if (!currentFile || s.idle) return
  if (s.duration <= 0 || s.timePos <= 0) return
  ctx.perFile.recordPosition(currentFile, s.timePos, s.duration)
}

const mod: FeatureModule = {
  id: 'playlist',
  ownsProperties: [
    'loop-file',
    'loop-playlist',
    'gapless-audio',
    'prefetch-playlist',
    'image-display-duration'
  ],

  setup(c): void {
    ctx = c

    ctx.mpv.onEvent('end-file', (msg) => {
      if (msg.reason === 'error') {
        const name = currentFile ? path.basename(currentFile) : ''
        ctx.osd.toast({
          kind: 'error',
          message: `재생할 수 없는 파일입니다${name ? `: ${name}` : ''}`
        })
      }
      if (msg.reason === 'eof') {
        savePosition()
        void next(true)
      }
    })

    saveTimer = setInterval(savePosition, POSITION_SAVE_INTERVAL_MS)
    ctx.lifecycle.onQuit(() => {
      savePosition()
      flushCurrent()
    })

    // --- renderer channels. `playlist:*` is this module's namespace. ---
    ctx.ipc.on<number>('playlist:play', (i) => void playIndex(i))
    ctx.ipc.on<number>('playlist:remove', (i) => void removeIndex(i))
    ctx.ipc.on<{ from: number; to: number }>('playlist:reorder', (r) => reorder(r.from, r.to))
    ctx.ipc.on('playlist:togglePanel', () => togglePanel())
    ctx.ipc.on<'off' | 'one' | 'all'>('playlist:setRepeat', (m) => {
      saveConfig({ repeat: m })
      push()
    })
    ctx.ipc.on<boolean>('playlist:setShuffle', (on) => {
      saveConfig({ shuffle: on })
      if (on) reshuffleIfNeeded()
      push()
    })
    ctx.ipc.on('playlist:request', () => push())

    ctx.commands.register([
      {
        id: 'playlist.next',
        labelKey: 'playlist.next',
        category: 'playlist',
        defaults: {
          default: ['Ctrl+ArrowRight', 'Ctrl+PageDown'],
          potplayer: ['PageDown'],
          mpv: ['Shift+Period']
        },
        run: () => next(false)
      },
      {
        id: 'playlist.prev',
        labelKey: 'playlist.prev',
        category: 'playlist',
        defaults: {
          default: ['Ctrl+ArrowLeft', 'Ctrl+PageUp'],
          potplayer: ['PageUp'],
          mpv: ['Shift+Comma']
        },
        run: previous
      },
      {
        id: 'playlist.stop',
        labelKey: 'playlist.stop',
        category: 'playlist',
        run: async () => {
          savePosition()
          flushCurrent()
          await ctx.mpv.command(['stop']).catch(() => undefined)
          currentFile = null
          push()
        }
      },
      {
        id: 'playlist.togglePanel',
        labelKey: 'playlist.togglePanel',
        category: 'playlist',
        defaults: { default: ['KeyL'], potplayer: ['KeyL'], mpv: ['KeyL'] },
        run: () => togglePanel()
      },
      {
        id: 'playlist.restartCurrent',
        labelKey: 'playlist.restartCurrent',
        category: 'playlist',
        internal: true,
        run: restartCurrent
      },
      {
        /** The mediator every other module uses to play something. */
        id: 'playlist.openPaths',
        labelKey: 'playlist.openPaths',
        category: 'playlist',
        internal: true,
        run: (arg) => openPaths(Array.isArray(arg) ? (arg as string[]) : [String(arg)])
      },
      {
        id: 'playlist.playIndex',
        labelKey: 'playlist.playIndex',
        category: 'playlist',
        internal: true,
        run: (arg) => playIndex(Number(arg))
      },
      {
        id: 'playlist.open',
        labelKey: 'playlist.open',
        category: 'playlist',
        defaults: { default: ['Ctrl+KeyO'], potplayer: ['Ctrl+KeyO'], mpv: ['Ctrl+KeyO'] },
        run: async () => {
          const files = await ctx.dialog.openFiles({
            titleKey: 'playlist.openTitle',
            multi: true,
            filters: [
              { name: '동영상', extensions: [...VIDEO_EXTENSIONS] },
              { name: '오디오', extensions: [...AUDIO_EXTENSIONS] },
              { name: '모든 파일', extensions: ['*'] }
            ]
          })
          if (files.length > 0) await openPaths(files)
        }
      },
      {
        /**
         * L50/N51 share this (§3.7.3). Written once here so M25's skip-intro
         * and the playlist's own "add similar files" agree on what a series is.
         * Returns a value, which is why CommandService gained query().
         */
        id: 'playlist.seriesPrefix',
        labelKey: 'playlist.seriesPrefix',
        category: 'playlist',
        internal: true,
        run: (arg) => seriesPrefix(String(arg ?? ''))
      }
    ])

    ctx.menu.contribute({
      id: 'playlist.menuOpen',
      labelKey: 'playlist.menuTitle',
      order: 10,
      items: [{ commandId: 'playlist.open' }]
    })
    ctx.menu.contribute({
      id: 'playlist.menuQueue',
      labelKey: 'playlist.menuTitle',
      order: 30,
      items: [
        {
          commandId: 'playlist.togglePanel',
          checked: loadConfig().playlistPanelOpen
        },
        { commandId: 'playlist.next' },
        { commandId: 'playlist.prev' },
        { commandId: 'playlist.stop' }
      ]
    })

    ctx.i18n.register('ko', {
      'playlist.next': '다음 파일',
      'playlist.prev': '이전 파일',
      'playlist.stop': '정지',
      'playlist.togglePanel': '재생목록',
      'playlist.restartCurrent': '처음부터 재생',
      'playlist.openPaths': '파일 열기',
      'playlist.playIndex': '목록에서 재생',
      'playlist.open': '열기...',
      'playlist.openTitle': '동영상 열기',
      'playlist.seriesPrefix': '시리즈 접두어',
      'playlist.menuTitle': '재생목록'
    })
    ctx.i18n.register('en', {
      'playlist.next': 'Next file',
      'playlist.prev': 'Previous file',
      'playlist.stop': 'Stop',
      'playlist.togglePanel': 'Playlist',
      'playlist.restartCurrent': 'Play from start',
      'playlist.openPaths': 'Open files',
      'playlist.playIndex': 'Play from list',
      'playlist.open': 'Open...',
      'playlist.openTitle': 'Open video',
      'playlist.seriesPrefix': 'Series prefix',
      'playlist.menuTitle': 'Playlist'
    })

    push()
  },

  dispose(): void {
    if (saveTimer) clearInterval(saveTimer)
    saveTimer = null
  }
}

/**
 * The stable part of an episode filename: everything before the episode
 * numbering. 'Show.Name.S01E04.1080p.mkv' and 'Show.Name.S01E05.1080p.mkv'
 * both yield 'Show.Name'.
 */
export function seriesPrefix(file: string): string {
  const base = path.basename(file, path.extname(file))
  const cut = base.search(
    /[._\s-]*(?:[Ss]\d{1,2}[._\s-]?[Ee]\d{1,3}|[Ee][Pp]?\d{1,3}|\d{1,3}\s*화|\[\d{1,3}\]|\d{1,3}(?!\d))/
  )
  return (cut > 0 ? base.slice(0, cut) : base).replace(/[._\s-]+$/, '')
}

async function playIndex(i: number): Promise<void> {
  if (i < 0 || i >= items.length) return
  flushCurrent()
  index = i
  await playCurrent()
}

async function removeIndex(i: number): Promise<void> {
  if (i < 0 || i >= items.length) return
  items.splice(i, 1)
  if (i < index) index--
  else if (i === index) {
    index = Math.min(index, items.length - 1)
    if (items.length === 0) {
      await ctx.mpv.command(['stop']).catch(() => undefined)
      currentFile = null
    } else {
      await playCurrent()
    }
  }
  push()
}

function reorder(from: number, to: number): void {
  if (from < 0 || from >= items.length) return
  if (to < 0 || to >= items.length) return
  const [moved] = items.splice(from, 1)
  if (!moved) return
  items.splice(to, 0, moved)
  // Keep `index` pointing at the file that is actually playing.
  if (currentFile) {
    const cur = currentFile.toLowerCase()
    const found = items.findIndex((it) => it.path.toLowerCase() === cur)
    if (found !== -1) index = found
  }
  push()
}

function togglePanel(): void {
  saveConfig({ playlistPanelOpen: !loadConfig().playlistPanelOpen })
  push()
}

export default mod
