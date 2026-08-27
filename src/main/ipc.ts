import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppConfig, AudioDevice, PlayerAction } from '@shared/types'
import { activeKeybinds, configFilePath, dataDir, DEFAULT_CONFIG, isPortable, loadConfig, saveConfig } from './services/config'
import { resolveMpvPath } from './mpv/manager'
import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, isMediaFile } from './services/playlist'
import {
  beginDrag,
  endDrag,
  getUiWindow,
  getVideoWindow,
  setFullScreen,
  setVideoRegion,
  toggleMaximize
} from './windows'
import type { Player } from './player'
import { popupMainMenu } from './menu'

export const RELEASES_URL = 'https://github.com/rohyunsang/RLPlayer/releases'

const SUB_EXTENSIONS = ['srt', 'ass', 'ssa', 'sub', 'vtt', 'smi', 'idx', 'lrc']

export function isSubtitleFile(file: string): boolean {
  return SUB_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())
}

let settingsWindow: BrowserWindow | null = null

export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 620,
    height: 700,
    minWidth: 520,
    minHeight: 480,
    title: 'RLPlayer 설정',
    backgroundColor: '#16181d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })
  settingsWindow.setMenu(null)
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    void settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'))
  }
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

export function broadcastKeybinds(): void {
  getUiWindow()?.webContents.send('ui:keybinds', activeKeybinds())
}

/** Turn a keybind action string ('seek:-5') into a player action and run it. */
export async function runBinding(player: Player, binding: string): Promise<void> {
  const [name, rawArg] = binding.split(':')
  const arg = rawArg === undefined ? NaN : Number(rawArg)

  switch (name) {
    case 'playPause':
      return player.dispatch({ type: 'playPause' })
    case 'stop':
      return player.dispatch({ type: 'stop' })
    case 'seek':
      return player.dispatch({ type: 'seek', seconds: arg })
    case 'seekStart':
      return player.dispatch({ type: 'seek', seconds: 0, absolute: true })
    case 'seekEnd':
      return player.dispatch({
        type: 'seek',
        seconds: Math.max(0, player.mpv.state.duration - 3),
        absolute: true
      })
    case 'volume':
      return player.dispatch({ type: 'volumeBy', delta: arg })
    case 'mute':
      return player.dispatch({ type: 'toggleMute' })
    case 'speed':
      return player.dispatch({ type: 'speedBy', delta: arg })
    case 'speedReset':
      return player.dispatch({ type: 'setSpeed', value: 1 })
    case 'frameBack':
      return player.dispatch({ type: 'frameStep', back: true })
    case 'frameForward':
      return player.dispatch({ type: 'frameStep' })
    case 'screenshot':
      return player.dispatch({ type: 'screenshot', target: 'file' })
    case 'screenshotClipboard':
      return player.dispatch({ type: 'screenshot', target: 'clipboard' })
    case 'toggleSubs':
      return player.dispatch({ type: 'toggleSubs' })
    case 'cycleSub':
      return player.dispatch({ type: 'cycleSub' })
    case 'cycleAudio':
      return player.dispatch({ type: 'cycleAudio' })
    case 'subDelay':
      return player.dispatch({ type: 'subDelayBy', delta: arg })
    case 'audioDelay':
      return player.dispatch({ type: 'audioDelayBy', delta: arg })
    case 'chapterNext':
      return player.dispatch({ type: 'setChapter', index: currentChapter(player) + 1 })
    case 'chapterPrev':
      return player.dispatch({ type: 'setChapter', index: currentChapter(player) - 1 })
    case 'next':
      return player.next()
    case 'previous':
      return player.previous()
    case 'fullscreen':
      return void player.toggleFullscreen()
    case 'exitFullscreen':
      setFullScreen(false)
      player.pushState()
      return
    case 'alwaysOnTop':
      return void player.toggleAlwaysOnTop()
    case 'togglePlaylist':
      return void togglePlaylistPanel(player)
    case 'open':
      return openFileDialog(player)
    case 'settings':
      return void openSettingsWindow()
    case 'quit':
      return void app.quit()
    default:
      return
  }
}

function currentChapter(player: Player): number {
  const { chapters, timePos } = player.mpv.state
  let idx = 0
  for (let i = 0; i < chapters.length; i++) {
    if ((chapters[i]?.time ?? 0) <= timePos + 0.25) idx = i
  }
  return idx
}

function togglePlaylistPanel(player: Player): void {
  saveConfig({ playlistPanelOpen: !loadConfig().playlistPanelOpen })
  player.pushPlaylist()
}

export async function openFileDialog(player: Player): Promise<void> {
  const win = getVideoWindow()
  if (!win) return
  const res = await dialog.showOpenDialog(win, {
    title: '동영상 열기',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '동영상', extensions: VIDEO_EXTENSIONS },
      { name: '오디오', extensions: AUDIO_EXTENSIONS },
      { name: '모든 파일', extensions: ['*'] }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) return
  await player.openMany(res.filePaths)
}

/**
 * Route dropped/CLI paths: subtitle files attach to the current video, media
 * files start playing.
 */
export async function handleIncomingPaths(player: Player, paths: string[]): Promise<void> {
  const clean = paths.filter((p) => typeof p === 'string' && p.length > 0)
  if (clean.length === 0) return

  const subs = clean.filter(isSubtitleFile)
  const media = clean.filter((p) => !isSubtitleFile(p))

  if (media.length > 0) {
    await player.openMany(media)
    // A video and its subtitle dropped together: attach after the load.
    for (const s of subs) await player.attachSubtitle(s)
    return
  }
  for (const s of subs) await player.attachSubtitle(s)
}

export function registerIpc(player: Player): void {
  ipcMain.on('player:action', (_e, action: PlayerAction) => {
    void player.dispatch(action)
  })
  ipcMain.on('player:binding', (_e, binding: string) => {
    if (typeof binding === 'string') void runBinding(player, binding)
  })

  ipcMain.on('player:restart', () => void player.restartCurrent())

  ipcMain.on('file:openDialog', () => void openFileDialog(player))
  ipcMain.on('file:openPaths', (_e, paths: string[]) => {
    if (Array.isArray(paths)) void handleIncomingPaths(player, paths)
  })

  ipcMain.on('playlist:play', (_e, i: number) => void player.playIndex(i))
  ipcMain.on('playlist:remove', (_e, i: number) => void player.removeIndex(i))
  ipcMain.on('playlist:reorder', (_e, { from, to }: { from: number; to: number }) =>
    player.reorder(from, to)
  )
  ipcMain.on('playlist:togglePanel', () => togglePlaylistPanel(player))
  ipcMain.on('playlist:setRepeat', (_e, mode: 'off' | 'one' | 'all') => player.setRepeat(mode))
  ipcMain.on('playlist:setShuffle', (_e, on: boolean) => player.setShuffle(on))

  ipcMain.on('window:minimize', () => getVideoWindow()?.minimize())
  ipcMain.on('window:toggleMaximize', () => {
    toggleMaximize()
    player.pushState()
  })
  ipcMain.on('window:close', () => getVideoWindow()?.close())
  ipcMain.on('window:beginDrag', (_e, { mode, edge }: { mode: 'move' | 'resize'; edge?: string }) =>
    beginDrag(mode, edge as never)
  )
  ipcMain.on('window:endDrag', () => endDrag())
  ipcMain.on('window:toggleFullscreen', () => player.toggleFullscreen())
  ipcMain.on('window:setFullscreen', (_e, on: boolean) => {
    setFullScreen(on)
    player.pushState()
  })
  ipcMain.on('window:toggleAlwaysOnTop', () => player.toggleAlwaysOnTop())
  ipcMain.on('window:videoRegion', (_e, r: Electron.Rectangle) => {
    if (r && Number.isFinite(r.width) && Number.isFinite(r.height)) setVideoRegion(r)
  })

  ipcMain.on('ui:popupMenu', (_e, { x, y }: { x?: number; y?: number }) => {
    popupMainMenu(player, x, y)
  })

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<AppConfig>) => {
    const before = loadConfig()
    const next = saveConfig(patch)
    await applyConfigChanges(player, before, next)
    return next
  })
  ipcMain.handle('config:reset', async () => {
    const before = loadConfig()
    const next = saveConfig({ ...DEFAULT_CONFIG, window: before.window })
    await applyConfigChanges(player, before, next)
    return next
  })

  ipcMain.on('settings:open', () => openSettingsWindow())
  ipcMain.on('settings:close', () => settingsWindow?.close())

  ipcMain.handle('system:audioDevices', async (): Promise<AudioDevice[]> => {
    try {
      const list = await player.mpv.client.getProperty<
        { name: string; description: string }[]
      >('audio-device-list')
      return Array.isArray(list)
        ? list.map((d) => ({ name: d.name, description: d.description || d.name }))
        : []
    } catch {
      return []
    }
  })
  ipcMain.on('system:openDefaultApps', () => {
    // Windows deliberately blocks apps from claiming default-handler status;
    // the honest path is to send the user to the Settings page.
    void shell.openExternal('ms-settings:defaultapps')
  })
  ipcMain.on('system:openReleases', () => void shell.openExternal(RELEASES_URL))
  ipcMain.on('system:openConfigFolder', () => void shell.openPath(dataDir()))
  ipcMain.on('system:relaunch', () => {
    player.flush()
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('system:chooseScreenshotDir', async () => {
    const win = settingsWindow ?? getVideoWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '스크린샷 저장 폴더',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('system:info', () => ({
    version: app.getVersion(),
    portable: isPortable(),
    configPath: configFilePath(),
    mpv: resolveMpvPath()
  }))
}

/** Push settings changes that mpv or the windows need to act on immediately. */
async function applyConfigChanges(
  player: Player,
  before: AppConfig,
  next: AppConfig
): Promise<void> {
  const c = player.mpv.client
  if (!player.isStarted) return

  if (next.subScale !== before.subScale) {
    await c.setProperty('sub-scale', next.subScale).catch(() => {})
  }
  if (next.subAssOverride !== before.subAssOverride) {
    await c.setProperty('sub-ass-override', next.subAssOverride ? 'force' : 'no').catch(() => {})
  }
  if (next.audioDevice !== before.audioDevice) {
    await c.setProperty('audio-device', next.audioDevice).catch(() => {})
  }
  if (next.hwdec !== before.hwdec) {
    await c.setProperty('hwdec', next.hwdec).catch(() => {})
  }
  if (next.keybindPreset !== before.keybindPreset || next.keybinds !== before.keybinds) {
    broadcastKeybinds()
  }
  player.pushState()
  player.pushPlaylist()
}

export { isMediaFile }
