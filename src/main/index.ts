import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, Menu } from 'electron'
import { Player } from './player'
import { createWindows, getUiWindow, getVideoWindow, persistBounds, showWindows } from './windows'
import { broadcastKeybinds, handleIncomingPaths, registerIpc } from './ipc'
import { loadConfig } from './services/config'

/**
 * RLPlayer main process.
 *
 * Two things this file deliberately does NOT do:
 *   - no auto-updater, and no network request of any kind at startup
 *   - no telemetry
 * Those absences are the whole reason this app exists; see README.
 */

app.setAppUserModelId('com.rohyunsang.rlplayer')
// The custom titlebar in the overlay replaces it; a native menu bar would sit
// behind mpv's child HWND anyway.
Menu.setApplicationMenu(null)

let player: Player | null = null

/**
 * Pull openable file paths out of an argv. Works for the packaged exe
 * (`rlplayer.exe movie.mkv`), for `electron . movie.mkv` in dev, and for the
 * argv handed over by a second instance.
 */
function filesFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => {
    if (typeof a !== 'string' || a.startsWith('-')) return false
    try {
      return fs.statSync(path.resolve(a)).isFile()
    } catch {
      return false
    }
  })
}

// Single instance: a second launch (double-clicked file, drop onto the exe)
// hands its paths to the running window instead of opening a second player.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv)
    if (player && files.length > 0) void handleIncomingPaths(player, files)
    const video = getVideoWindow()
    if (video?.isMinimized()) video.restore()
    video?.show()
    getUiWindow()?.focus()
  })

  app.whenReady().then(main).catch((e: Error) => {
    dialog.showErrorBox('RLPlayer 시작 실패', e.stack ?? e.message)
    app.quit()
  })
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  createWindows()

  player = new Player()
  registerIpc(player)

  try {
    await player.start()
  } catch (e) {
    dialog.showErrorBox(
      '재생 엔진을 시작할 수 없습니다',
      `${(e as Error).message}\n\n"npm run fetch:mpv"를 실행해 mpv를 내려받으세요.`
    )
    app.quit()
    return
  }

  showWindows(cfg.window.maximized)
  broadcastKeybinds()
  player.pushState()
  player.pushPlaylist()

  const files = filesFromArgv(process.argv)
  if (files.length > 0) await handleIncomingPaths(player, files)
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  persistBounds()
  // Flush the resume position before mpv goes away, or the last few seconds of
  // playback are lost on every exit.
  player?.dispose()
  player = null
})
