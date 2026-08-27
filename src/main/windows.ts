import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import { loadConfig, saveConfig } from './services/config'

/**
 * Two-window design (validated by spike; see docs/03-architecture.md).
 *
 *  videoWindow  frameless, opaque, owns the native HWND we hand to mpv --wid.
 *               mpv creates a CHILD HWND inside it, which on Windows always
 *               renders above Chromium's compositor output. So nothing of ours
 *               may be painted here -- it would be invisible.
 *
 *  uiWindow     transparent, frameless, created with `parent: videoWindow`.
 *               Electron parent windows are OWNED TOP-LEVEL windows, not HWND
 *               children, so they composite above mpv's child HWND. All HTML UI
 *               lives here, and it captures every mouse/keyboard event.
 *
 * The cost of that trick is that the UI window fully covers the video window,
 * so the video window can never see input: window move and edge-resize have to
 * be driven manually from the overlay (see beginDrag below).
 */

export interface Windows {
  videoWindow: BrowserWindow
  uiWindow: BrowserWindow
}

let videoWindow: BrowserWindow | null = null
let uiWindow: BrowserWindow | null = null
let syncScheduled = false

export function getWindows(): Windows | null {
  if (!videoWindow || !uiWindow || videoWindow.isDestroyed() || uiWindow.isDestroyed()) return null
  return { videoWindow, uiWindow }
}

export function getUiWindow(): BrowserWindow | null {
  return uiWindow && !uiWindow.isDestroyed() ? uiWindow : null
}

export function getVideoWindow(): BrowserWindow | null {
  return videoWindow && !videoWindow.isDestroyed() ? videoWindow : null
}

/**
 * Read the HWND as a decimal string for mpv's --wid.
 * getNativeWindowHandle() returns an 8-byte little-endian buffer on x64.
 */
export function getHwnd(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle()
  if (buf.length === 8) return buf.readBigUInt64LE(0).toString()
  return String(buf.readUInt32LE(0))
}

/**
 * Keep the overlay exactly on top of the video window. Called on every move,
 * resize, maximize and fullscreen transition. Coalesced into an animation-frame
 * -ish tick: calling setBounds synchronously inside a resize storm is the main
 * source of overlay flicker.
 */
function syncBounds(): void {
  if (syncScheduled) return
  syncScheduled = true
  setImmediate(() => {
    syncScheduled = false
    if (!videoWindow || !uiWindow) return
    if (videoWindow.isDestroyed() || uiWindow.isDestroyed()) return
    if (videoWindow.isMinimized()) return
    const b = videoWindow.getContentBounds()
    const cur = uiWindow.getBounds()
    if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return
    uiWindow.setBounds(b)
  })
}

export function syncOverlay(): void {
  syncBounds()
}

export function createWindows(): Windows {
  const cfg = loadConfig()

  const bounds = clampToDisplay({
    x: cfg.window.x,
    y: cfg.window.y,
    width: cfg.window.width,
    height: cfg.window.height
  })

  videoWindow = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 320,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'RLPlayer',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })

  // The video window paints nothing: mpv's child HWND covers it entirely.
  void videoWindow.loadURL('data:text/html,<body style="margin:0;background:#000"></body>')

  uiWindow = new BrowserWindow({
    parent: videoWindow,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    // Movement is driven from the parent; letting Windows animate the child
    // separately is what produces the trailing-overlay effect while dragging.
    thickFrame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  uiWindow.setMenu(null)

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void uiWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`)
  } else {
    void uiWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  for (const ev of [
    'move',
    'resize',
    'restore',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen'
  ] as const) {
    videoWindow.on(ev, syncBounds)
  }

  videoWindow.on('minimize', () => uiWindow?.hide())
  videoWindow.on('restore', () => {
    uiWindow?.showInactive()
    syncBounds()
    uiWindow?.focus()
  })

  videoWindow.on('close', () => {
    persistBounds()
    if (uiWindow && !uiWindow.isDestroyed()) uiWindow.destroy()
  })
  videoWindow.on('closed', () => {
    videoWindow = null
  })
  uiWindow.on('closed', () => {
    uiWindow = null
  })

  // Never let the overlay navigate away or spawn browser windows.
  uiWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  uiWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (cfg.alwaysOnTop) setAlwaysOnTop(true)

  return { videoWindow, uiWindow }
}

export function showWindows(maximized: boolean): void {
  if (!videoWindow || !uiWindow) return
  videoWindow.show()
  if (maximized) videoWindow.maximize()
  syncBounds()
  uiWindow.showInactive()
  // The overlay, not the video window, must own keyboard focus: it is the only
  // window that can see input.
  uiWindow.focus()
}

function clampToDisplay(b: {
  x?: number
  y?: number
  width: number
  height: number
}): { x?: number; y?: number; width: number; height: number } {
  const width = Math.max(480, Math.round(b.width))
  const height = Math.max(320, Math.round(b.height))
  if (b.x === undefined || b.y === undefined) return { width, height }
  // A saved position on a monitor that is no longer attached would open the
  // window off-screen; fall back to centering in that case.
  const area = screen.getDisplayMatching({ x: b.x, y: b.y, width, height }).workArea
  const visible =
    b.x + width > area.x && b.x < area.x + area.width &&
    b.y + height > area.y && b.y < area.y + area.height
  return visible ? { x: Math.round(b.x), y: Math.round(b.y), width, height } : { width, height }
}

export function persistBounds(): void {
  if (!videoWindow || videoWindow.isDestroyed()) return
  if (videoWindow.isFullScreen()) return
  const maximized = videoWindow.isMaximized()
  const b = maximized ? videoWindow.getNormalBounds() : videoWindow.getBounds()
  saveConfig({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

export function setAlwaysOnTop(on: boolean): void {
  videoWindow?.setAlwaysOnTop(on)
  // The overlay must outrank the video window even when that is topmost.
  uiWindow?.setAlwaysOnTop(on, 'pop-up-menu')
  saveConfig({ alwaysOnTop: on })
}

export function setFullScreen(on: boolean): void {
  if (!videoWindow) return
  videoWindow.setFullScreen(on)
  syncBounds()
}

export function toggleFullScreen(): boolean {
  if (!videoWindow) return false
  const next = !videoWindow.isFullScreen()
  setFullScreen(next)
  return next
}

export function toggleMaximize(): void {
  if (!videoWindow) return
  if (videoWindow.isMaximized()) videoWindow.unmaximize()
  else videoWindow.maximize()
}

// --- manual move / resize -------------------------------------------------
// The overlay covers the video window completely, so Windows never delivers
// hit-test messages for the frame. We drive both gestures ourselves by polling
// the cursor while the overlay holds pointer capture.

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

let dragTimer: NodeJS.Timeout | null = null

export function beginDrag(mode: 'move' | 'resize', edge?: Edge): void {
  if (!videoWindow || videoWindow.isFullScreen()) return
  endDrag()

  const start = screen.getCursorScreenPoint()
  const origin = videoWindow.getBounds()
  const wasMaximized = videoWindow.isMaximized()

  dragTimer = setInterval(() => {
    if (!videoWindow || videoWindow.isDestroyed()) return endDrag()
    const now = screen.getCursorScreenPoint()
    const dx = now.x - start.x
    const dy = now.y - start.y

    if (mode === 'move') {
      // Dragging a maximized window restores it and continues the drag, the
      // way a normal Windows titlebar behaves.
      if (wasMaximized && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        videoWindow.unmaximize()
        const nb = videoWindow.getBounds()
        videoWindow.setPosition(Math.round(now.x - nb.width / 2), Math.round(now.y - 20))
        endDrag()
        beginDrag('move')
        return
      }
      videoWindow.setPosition(origin.x + dx, origin.y + dy)
      return
    }

    let { x, y, width, height } = origin
    const minW = 480
    const minH = 320
    if (edge?.includes('e')) width = Math.max(minW, origin.width + dx)
    if (edge?.includes('s')) height = Math.max(minH, origin.height + dy)
    if (edge?.includes('w')) {
      width = Math.max(minW, origin.width - dx)
      x = origin.x + (origin.width - width)
    }
    if (edge?.includes('n')) {
      height = Math.max(minH, origin.height - dy)
      y = origin.y + (origin.height - height)
    }
    videoWindow.setBounds({ x, y, width, height })
  }, 16)
}

export function endDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}
