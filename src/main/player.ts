import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, clipboard, ClipboardItem, dialog } from 'electron'
import { MpvManager } from './mpv/manager'
import { loadConfig, saveConfig } from './services/config'
import { recordPosition, lookupPosition, forget } from './services/resume'
import { scanFolder, shuffleOrder, isMediaFile } from './services/playlist'
import {
  getHwnd,
  getLayoutMode,
  getMpvHostWindow,
  getUiWindow,
  getVideoWindow,
  setAlwaysOnTop,
  toggleFullScreen
} from './windows'
import type { PlayerAction, PlaylistItem, PlaylistState, ToastPayload } from '@shared/types'

const POSITION_SAVE_INTERVAL_MS = 5000

export class Player {
  readonly mpv = new MpvManager()
  private items: PlaylistItem[] = []
  private index = -1
  private shuffleQueue: number[] = []
  private shufflePos = 0
  private saveTimer: NodeJS.Timeout | null = null
  private currentFile: string | null = null
  private started = false
  private boostActive = false

  async start(): Promise<void> {
    // In compat mode this is a separate inset child window, not the shell.
    const host = getMpvHostWindow()
    if (!host) throw new Error('mpv host window missing')
    const cfg = loadConfig()

    await this.mpv.start({
      hwnd: getHwnd(host),
      volume: cfg.volume,
      muted: cfg.muted,
      speed: cfg.speed,
      hwdec: cfg.hwdec,
      audioDevice: cfg.audioDevice,
      subScale: cfg.subScale,
      subAssOverride: cfg.subAssOverride,
      vo: cfg.vo
    })
    this.started = true

    this.mpv.on('state', () => this.pushState())
    this.mpv.on('eof', () => void this.onEof())
    this.mpv.on('crashed', (code: number, detail: string) => {
      this.toast({
        kind: 'error',
        message: `재생 엔진이 종료되었습니다 (code ${code}). ${detail.split('\n')[0] ?? ''}`.trim()
      })
    })

    this.saveTimer = setInterval(() => this.savePosition(), POSITION_SAVE_INTERVAL_MS)
  }

  get isStarted(): boolean {
    return this.started
  }

  // --- opening ------------------------------------------------------------

  async open(file: string): Promise<void> {
    if (!file) return
    let resolved: string
    try {
      resolved = fs.realpathSync.native(file)
    } catch {
      resolved = path.resolve(file)
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      this.toast({ kind: 'error', message: `파일을 찾을 수 없습니다: ${path.basename(file)}` })
      return
    }

    // Flush the outgoing file's position before we lose track of it.
    this.savePosition()

    const scan = scanFolder(resolved)
    this.items = scan.items
    this.index = scan.index
    this.reshuffleIfNeeded()
    await this.playCurrent()
  }

  /** Queue several dropped paths as an explicit playlist (no folder scan). */
  async openMany(files: string[]): Promise<void> {
    const media = files.filter((f) => {
      try {
        return fs.statSync(f).isFile() && isMediaFile(f)
      } catch {
        return false
      }
    })
    if (media.length === 0) {
      const first = files[0]
      if (first) await this.open(first)
      return
    }
    if (media.length === 1) return this.open(media[0]!)

    this.savePosition()
    this.items = media.map((p) => ({ path: p, name: path.basename(p) }))
    this.index = 0
    this.reshuffleIfNeeded()
    await this.playCurrent()
  }

  private async playCurrent(): Promise<void> {
    const item = this.items[this.index]
    if (!item) return
    const cfg = loadConfig()
    this.currentFile = item.path

    const entry = cfg.resumePlayback ? lookupPosition(item.path) : null
    await this.mpv.loadFile(item.path, entry?.position)

    if (entry) {
      this.toast({
        kind: 'resume',
        message: `${formatTime(entry.position)} 부터 이어서 재생합니다`,
        actionLabel: '처음부터',
        action: 'restart',
        data: item.path
      })
    }

    // External subtitles are found by mpv itself via --sub-auto=fuzzy and
    // --sub-file-paths; see MpvManager.start().
    await this.applyBoostFilter(this.mpv.state.volume)
    this.pushPlaylist()
    this.pushState()
  }

  /**
   * Attach a subtitle file to whatever is already playing, rather than
   * replacing playback with it. This is what dropping a .srt on the window
   * should do.
   */
  async attachSubtitle(file: string): Promise<void> {
    if (this.mpv.state.idle) {
      this.toast({ kind: 'error', message: '먼저 동영상을 재생해 주세요' })
      return
    }
    try {
      await this.mpv.client.command(['sub-add', file, 'select'])
      this.toast({ kind: 'info', message: `자막 추가됨: ${path.basename(file)}` })
    } catch (e) {
      this.toast({ kind: 'error', message: `자막을 불러올 수 없습니다: ${(e as Error).message}` })
    }
  }

  // --- playlist -----------------------------------------------------------

  private reshuffleIfNeeded(): void {
    const cfg = loadConfig()
    if (!cfg.shuffle) return
    this.shuffleQueue = shuffleOrder(this.items.length, this.index)
    this.shufflePos = 0
  }

  async next(auto = false): Promise<void> {
    const cfg = loadConfig()
    if (this.items.length === 0) return

    if (auto && cfg.repeat === 'one') {
      await this.mpv.client.command(['seek', 0, 'absolute']).catch(() => {})
      await this.mpv.client.setProperty('pause', false)
      return
    }

    let nextIndex: number
    if (cfg.shuffle && this.shuffleQueue.length > 0) {
      this.shufflePos++
      if (this.shufflePos >= this.shuffleQueue.length) {
        if (auto && cfg.repeat !== 'all') return this.stopAtEnd()
        this.shuffleQueue = shuffleOrder(this.items.length, -1)
        this.shufflePos = 0
      }
      nextIndex = this.shuffleQueue[this.shufflePos] ?? 0
    } else {
      nextIndex = this.index + 1
      if (nextIndex >= this.items.length) {
        if (auto && cfg.repeat !== 'all') return this.stopAtEnd()
        nextIndex = 0
      }
    }
    this.index = nextIndex
    await this.playCurrent()
  }

  async previous(): Promise<void> {
    if (this.items.length === 0) return
    // Match every other player: within the first 3s, go back a file; otherwise
    // restart the current one.
    if (this.mpv.state.timePos > 3) {
      await this.mpv.client.command(['seek', 0, 'absolute']).catch(() => {})
      return
    }
    const cfg = loadConfig()
    if (cfg.shuffle && this.shuffleQueue.length > 0) {
      this.shufflePos = Math.max(0, this.shufflePos - 1)
      this.index = this.shuffleQueue[this.shufflePos] ?? 0
    } else {
      this.index = this.index - 1 < 0 ? this.items.length - 1 : this.index - 1
    }
    await this.playCurrent()
  }

  async playIndex(i: number): Promise<void> {
    if (i < 0 || i >= this.items.length) return
    this.savePosition()
    this.index = i
    await this.playCurrent()
  }

  async removeIndex(i: number): Promise<void> {
    if (i < 0 || i >= this.items.length) return
    this.items.splice(i, 1)
    if (i < this.index) this.index--
    else if (i === this.index) {
      this.index = Math.min(this.index, this.items.length - 1)
      if (this.items.length === 0) {
        await this.mpv.stop()
        this.currentFile = null
      } else {
        await this.playCurrent()
      }
    }
    this.pushPlaylist()
  }

  reorder(from: number, to: number): void {
    if (from < 0 || from >= this.items.length) return
    if (to < 0 || to >= this.items.length) return
    const [moved] = this.items.splice(from, 1)
    if (!moved) return
    this.items.splice(to, 0, moved)
    // Keep `index` pointing at the file that is actually playing.
    if (this.currentFile) {
      const cur = this.currentFile.toLowerCase()
      const found = this.items.findIndex((it) => it.path.toLowerCase() === cur)
      if (found !== -1) this.index = found
    }
    this.pushPlaylist()
  }

  private async stopAtEnd(): Promise<void> {
    await this.mpv.client.setProperty('pause', true).catch(() => {})
  }

  private async onEof(): Promise<void> {
    this.savePosition()
    await this.next(true)
  }

  // --- resume -------------------------------------------------------------

  private savePosition(): void {
    const s = this.mpv.state
    if (!this.currentFile || s.idle) return
    if (s.duration <= 0 || s.timePos <= 0) return
    recordPosition(this.currentFile, s.timePos, s.duration)
  }

  flush(): void {
    this.savePosition()
  }

  async restartCurrent(): Promise<void> {
    if (this.currentFile) forget(this.currentFile)
    await this.mpv.client.command(['seek', 0, 'absolute']).catch(() => {})
    await this.mpv.client.setProperty('pause', false).catch(() => {})
  }

  // --- actions from the renderer -----------------------------------------

  async dispatch(action: PlayerAction): Promise<void> {
    const c = this.mpv.client
    const s = this.mpv.state
    if (!this.started) return

    switch (action.type) {
      case 'playPause':
        if (s.idle) return
        await c.setProperty('pause', !s.paused)
        break
      case 'play':
        await c.setProperty('pause', false)
        break
      case 'pause':
        await c.setProperty('pause', true)
        break
      case 'stop':
        this.savePosition()
        await this.mpv.stop()
        this.currentFile = null
        break
      case 'seek':
        if (s.idle) return
        // No reply awaited: scrubbing sends these many times a second.
        c.commandNoReply(['seek', action.seconds, action.absolute ? 'absolute' : 'relative'])
        break
      case 'frameStep':
        await c.command([action.back ? 'frame-back-step' : 'frame-step']).catch(() => {})
        break
      case 'setVolume': {
        const v = clamp(action.value, 0, 150)
        await c.setProperty('volume', v)
        await this.applyBoostFilter(v)
        saveConfig({ volume: v })
        break
      }
      case 'volumeBy': {
        const v = clamp(Math.round(s.volume + action.delta), 0, 150)
        await c.setProperty('volume', v)
        await this.applyBoostFilter(v)
        saveConfig({ volume: v })
        break
      }
      case 'toggleMute':
        await c.setProperty('mute', !s.muted)
        saveConfig({ muted: !s.muted })
        break
      case 'setSpeed': {
        const v = clamp(action.value, 0.25, 4)
        await c.setProperty('speed', v)
        saveConfig({ speed: v })
        break
      }
      case 'speedBy': {
        const v = clamp(round2(s.speed + action.delta), 0.25, 4)
        await c.setProperty('speed', v)
        saveConfig({ speed: v })
        break
      }
      case 'setTrack':
        await c.setProperty(action.kind, action.id === false ? 'no' : action.id)
        break
      case 'cycleAudio':
        await c.command(['cycle', 'aid']).catch(() => {})
        break
      case 'cycleSub':
        await c.command(['cycle', 'sid']).catch(() => {})
        break
      case 'toggleSubs':
        await c.setProperty('sid', s.sid === false ? 'auto' : 'no')
        break
      case 'setSubDelay':
        await c.setProperty('sub-delay', round2(action.value))
        break
      case 'subDelayBy':
        await c.setProperty('sub-delay', round2(s.subDelay + action.delta))
        break
      case 'setAudioDelay':
        await c.setProperty('audio-delay', round2(action.value))
        break
      case 'audioDelayBy':
        await c.setProperty('audio-delay', round2(s.audioDelay + action.delta))
        break
      case 'setSubScale': {
        const v = clamp(action.value, 0.2, 4)
        await c.setProperty('sub-scale', v)
        saveConfig({ subScale: v })
        break
      }
      case 'setSubPos':
        await c.setProperty('sub-pos', clamp(Math.round(action.value), 0, 150))
        break
      case 'setAspect':
        await c.setProperty('video-aspect-override', action.value)
        break
      case 'rotate':
        await c.setProperty('video-rotate', ((action.value % 360) + 360) % 360)
        break
      case 'setAudioDevice':
        await c.setProperty('audio-device', action.value)
        saveConfig({ audioDevice: action.value })
        break
      case 'setChapter':
        await c.setProperty('chapter', action.index).catch(() => {})
        break
      case 'screenshot':
        await this.screenshot(action.target)
        break
      case 'loadSubtitle':
        await this.pickSubtitle()
        break
      default:
        break
    }
  }

  // --- volume boost -------------------------------------------------------

  /**
   * Above 100%, raw gain clips badly on exactly the content people boost for:
   * quiet dialogue in a wide-dynamic-range film. Swap in a soft limiter on the
   * boost path instead -- dynaudnorm lifts the quiet passages, alimiter catches
   * the peaks before they square off.
   *
   * The filter is added and removed rather than left permanently in the chain,
   * so normal playback at <=100% is bit-exact and costs nothing.
   */
  private async applyBoostFilter(volume: number): Promise<void> {
    const want = loadConfig().volumeBoostLimiter && volume > 100
    if (want === this.boostActive) return
    try {
      if (want) {
        await this.mpv.client.command([
          'af',
          'add',
          '@rlboost:lavfi=[dynaudnorm=f=250:g=9:p=0.85:m=4.0,alimiter=limit=0.94:level=false]'
        ])
      } else {
        await this.mpv.client.command(['af', 'remove', '@rlboost'])
      }
      this.boostActive = want
    } catch (e) {
      // A build without those lavfi filters should still play audio; just log.
      console.error('[player] volume boost filter failed:', (e as Error).message)
    }
  }

  // --- screenshots --------------------------------------------------------

  private async screenshot(target: 'file' | 'clipboard'): Promise<void> {
    if (this.mpv.state.idle) return
    if (target === 'clipboard') {
      const tmp = path.join(os.tmpdir(), `rlplayer-shot-${Date.now()}.png`)
      try {
        // mpv has no clipboard output, so render to a temp PNG and hand the
        // bytes to Electron's clipboard.
        await this.mpv.client.command(['screenshot-to-file', tmp, 'subtitles'])
        const png = await fs.promises.readFile(tmp)
        if (png.length === 0) throw new Error('empty image')
        const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
        await clipboard.write([new ClipboardItem({ 'image/png': blob })])
        this.toast({ kind: 'info', message: '스크린샷을 클립보드에 복사했습니다' })
      } catch (e) {
        this.toast({ kind: 'error', message: `스크린샷 실패: ${(e as Error).message}` })
      } finally {
        fs.promises.rm(tmp, { force: true }).catch(() => {})
      }
      return
    }

    const cfg = loadConfig()
    const dir = cfg.screenshotDir || path.join(app.getPath('pictures'), 'RLPlayer')
    try {
      fs.mkdirSync(dir, { recursive: true })
      const stem = this.currentFile
        ? path.basename(this.currentFile, path.extname(this.currentFile))
        : 'screenshot'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const out = path.join(dir, `${sanitizeFileName(stem)}_${stamp}.png`)
      await this.mpv.client.command(['screenshot-to-file', out, 'subtitles'])
      this.toast({ kind: 'info', message: `저장됨: ${path.basename(out)}` })
    } catch (e) {
      this.toast({ kind: 'error', message: `스크린샷 실패: ${(e as Error).message}` })
    }
  }

  private async pickSubtitle(): Promise<void> {
    const win = getVideoWindow()
    if (!win) return
    const res = await dialog.showOpenDialog(win, {
      title: '자막 파일 열기',
      properties: ['openFile'],
      filters: [
        { name: '자막', extensions: ['srt', 'ass', 'ssa', 'sub', 'vtt', 'smi', 'idx'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    })
    const file = res.filePaths[0]
    if (!file) return
    await this.mpv.client.command(['sub-add', file, 'select']).catch(() => {})
  }

  // --- outbound -----------------------------------------------------------

  pushState(): void {
    const ui = getUiWindow()
    if (!ui) return
    const video = getVideoWindow()
    const s = this.mpv.state
    s.fullscreen = video?.isFullScreen() ?? false
    s.maximized = video?.isMaximized() ?? false
    s.alwaysOnTop = video?.isAlwaysOnTop() ?? false
    s.layoutMode = getLayoutMode()
    ui.webContents.send('player:state', s)
  }

  pushPlaylist(): void {
    const ui = getUiWindow()
    if (!ui) return
    const cfg = loadConfig()
    const payload: PlaylistState = {
      items: this.items,
      index: this.index,
      open: cfg.playlistPanelOpen,
      repeat: cfg.repeat,
      shuffle: cfg.shuffle
    }
    ui.webContents.send('playlist:state', payload)
  }

  toast(payload: ToastPayload): void {
    getUiWindow()?.webContents.send('ui:toast', payload)
  }

  setShuffle(on: boolean): void {
    saveConfig({ shuffle: on })
    if (on) this.reshuffleIfNeeded()
    this.pushPlaylist()
  }

  setRepeat(mode: 'off' | 'one' | 'all'): void {
    saveConfig({ repeat: mode })
    this.pushPlaylist()
  }

  toggleAlwaysOnTop(): void {
    const video = getVideoWindow()
    if (!video) return
    setAlwaysOnTop(!video.isAlwaysOnTop())
    this.pushState()
  }

  toggleFullscreen(): void {
    toggleFullScreen()
    this.pushState()
  }

  dispose(): void {
    if (this.saveTimer) clearInterval(this.saveTimer)
    this.savePosition()
    this.mpv.dispose()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'screenshot'
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}
