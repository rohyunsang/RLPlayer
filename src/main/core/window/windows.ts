import path from 'node:path'
import { app, BrowserWindow, screen, shell, type Rectangle } from 'electron'
import { loadConfig, saveConfig } from '../../services/config'

/**
 * Window topology.
 *
 * On Windows, mpv with --wid creates a CHILD HWND inside the window we give it,
 * and a child HWND always renders ABOVE Chromium's compositor output. Nothing
 * Chromium paints in that same window can ever be seen. Everything below is a
 * consequence of that one fact.
 *
 * OVERLAY MODE (default)
 *   mainWindow      opaque, frameless. Its HWND is handed to mpv, so mpv's
 *                   child fills it edge to edge. Paints nothing itself.
 *   rendererWindow  transparent, frameless, created with `parent: mainWindow`.
 *                   Electron parent windows are OWNED TOP-LEVEL windows, not
 *                   HWND children, so this composites above mpv's child. All
 *                   HTML UI lives here and it captures every input event.
 *
 * COMPAT MODE (Electron issue #40515 escape hatch)
 *   Transparent windows render black for a minority of Windows GPU/driver
 *   combinations, which would leave those users staring at a black rectangle
 *   with no way out. So compat mode uses NO transparent window at all:
 *     mainWindow    opaque, frameless, hosts the HTML UI directly.
 *     mpvHost       opaque owned child sized to just the video region the
 *                   renderer reports. The UI is docked around it rather than
 *                   floating over it, so no Chromium pixels ever need to sit
 *                   under mpv's child HWND.
 *   The renderer code is shared; only geometry and the transparent flag differ.
 */

export type LayoutMode = 'overlay' | 'compat'

let mainWindow: BrowserWindow | null = null
let rendererWindow: BrowserWindow | null = null
let mpvHost: BrowserWindow | null = null
let layout: LayoutMode = 'overlay'
/** Video rect in CSS px relative to the content area, reported by the renderer. */
let videoRegion: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let syncScheduled = false

const alive = (w: BrowserWindow | null): BrowserWindow | null =>
  w && !w.isDestroyed() ? w : null

/** The top-level window: bounds, taskbar entry, fullscreen, dialog parent. */
export function getVideoWindow(): BrowserWindow | null {
  return alive(mainWindow)
}

/** The window hosting the HTML UI; all renderer IPC goes here. */
export function getUiWindow(): BrowserWindow | null {
  return alive(rendererWindow)
}

/** The window whose HWND mpv embeds into. */
export function getMpvHostWindow(): BrowserWindow | null {
  return alive(layout === 'compat' ? mpvHost : mainWindow)
}

export function getLayoutMode(): LayoutMode {
  return layout
}

/**
 * Read the HWND as a decimal string for mpv's --wid.
 *
 * getNativeWindowHandle() returns an 8-byte buffer on x64, but the value MUST
 * be read as an UNSIGNED 32-bit integer: mpv's manual specifies --wid is cast
 * to uint32_t, and w32_common.c rejects anything not > 0. Reading it as signed
 * 32-bit or as a full 64-bit value makes mpv silently ignore --wid and open its
 * own floating window instead of embedding. (Windows guarantees window handles
 * fit in 32 bits, so this truncation is correct, not lossy.)
 */
export function getHwnd(win: BrowserWindow): string {
  const hwnd = win.getNativeWindowHandle().readUInt32LE(0)
  if (!(hwnd > 0)) {
    throw new Error(
      `native window handle was ${hwnd}; mpv requires --wid > 0 and would refuse to embed`
    )
  }
  return String(hwnd)
}

/**
 * Keep the secondary window glued to the main one. Coalesced to one call per
 * tick: calling setBounds synchronously inside a resize storm is the single
 * biggest source of overlay flicker.
 */
function syncBounds(): void {
  if (syncScheduled) return
  syncScheduled = true
  setImmediate(() => {
    syncScheduled = false
    const main = alive(mainWindow)
    if (!main || main.isMinimized()) return
    const content = main.getContentBounds()

    if (layout === 'overlay') {
      const ui = alive(rendererWindow)
      if (!ui) return
      applyBounds(ui, content)
      return
    }

    const host = alive(mpvHost)
    if (!host) return
    // Compat: place mpv over exactly the region the renderer reserved for it.
    applyBounds(host, {
      x: content.x + Math.round(videoRegion.x),
      y: content.y + Math.round(videoRegion.y),
      width: Math.max(1, Math.round(videoRegion.width)),
      height: Math.max(1, Math.round(videoRegion.height))
    })
  })
}

function applyBounds(win: BrowserWindow, b: Rectangle): void {
  const cur = win.getBounds()
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return
  win.setBounds(b)
}

export function syncOverlay(): void {
  syncBounds()
}

/** Called from IPC when the renderer's video area moves or resizes. */
export function setVideoRegion(r: Rectangle): void {
  videoRegion = r
  if (layout === 'compat') syncBounds()
}

/**
 * `spellcheck: false` is not cosmetic and it is not optional.
 *
 * Electron turns Chromium's spellchecker on by default. The moment a window
 * contains a text input — which Wave 0's generated settings form added — the
 * spellchecker downloads a dictionary for the app locale from
 * `redirector.gvt1.com`, and the 302 that answers it carries the user's public
 * IPv6 address. Every cold launch of the packaged build did this. It is the
 * single largest hole this app has had, and it arrived through a default nobody
 * typed. See src/main/core/no-network.ts.
 *
 * MEASURED CAVEAT, and it matters: this flag ALONE does not stop the download.
 * With only this set (session call and command-line switch both off, DNS
 * blackhole off) the packaged build still completed the fetch. The dictionary
 * is a per-PROFILE resource, so `session.setSpellCheckerEnabled(false)` in
 * core/no-network.ts is the layer that actually closes it. This one is kept
 * because it costs a line and because a window created later should not be the
 * thing that reopens the question — but do not read it as the fix.
 *
 * Every BrowserWindow in this process must set it, so it lives in the shared
 * helpers rather than being spelled out per call site; `no-network.test.ts`
 * fails if a `webPreferences` block in this file or in `src/main/ipc.ts` omits
 * it.
 */
const NO_SPELLCHECK = { spellcheck: false } as const

function rendererPreload(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    backgroundThrottling: false,
    ...NO_SPELLCHECK
  }
}

function loadUi(win: BrowserWindow): void {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // The UI must never navigate away or open browser windows of its own.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

export function createWindows(): void {
  const cfg = loadConfig()
  layout = cfg.layoutMode === 'compat' ? 'compat' : 'overlay'

  const bounds = clampToDisplay({
    x: cfg.window.x,
    y: cfg.window.y,
    width: cfg.window.width,
    height: cfg.window.height
  })

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 320,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'RLPlayer',
    webPreferences:
      layout === 'compat'
        ? rendererPreload()
        : { nodeIntegration: false, contextIsolation: true, ...NO_SPELLCHECK }
  })
  mainWindow.setMenu(null)

  if (layout === 'compat') {
    // The shell paints the whole UI; mpv gets its own inset child window.
    rendererWindow = mainWindow
    loadUi(mainWindow)

    mpvHost = new BrowserWindow({
      parent: mainWindow,
      frame: false,
      show: false,
      backgroundColor: '#000000',
      resizable: false,
      skipTaskbar: true,
      // Clicks on the video must not pull keyboard focus away from the shell,
      // which is the only window that can see key events.
      focusable: false,
      hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, ...NO_SPELLCHECK }
    })
    void mpvHost.loadURL('data:text/html,<body style="margin:0;background:#000"></body>')
  } else {
    // mpv fills the main window; the UI floats above it in an owned window.
    void mainWindow.loadURL('data:text/html,<body style="margin:0;background:#000"></body>')

    rendererWindow = new BrowserWindow({
      parent: mainWindow,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      show: false,
      thickFrame: false,
      webPreferences: rendererPreload()
    })
    rendererWindow.setMenu(null)
    loadUi(rendererWindow)
  }

  const syncEvents = [
    'move',
    'resize',
    'restore',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen'
  ] as const
  for (const ev of syncEvents) {
    // These event-name overloads are mutually exclusive, so the union has to be
    // narrowed to one of them for the call to typecheck.
    mainWindow.on(ev as 'move', syncBounds)
  }

  if (layout === 'overlay') {
    // Only the overlay can see input. If the shell window ever takes focus --
    // a taskbar click, Alt+Tab, or being raised by the OS -- hand focus
    // straight back, or the keyboard silently stops working.
    mainWindow.on('focus', () => alive(rendererWindow)?.focus())
  }

  const secondary = layout === 'compat' ? mpvHost : rendererWindow
  mainWindow.on('minimize', () => secondary?.hide())
  mainWindow.on('restore', () => {
    secondary?.showInactive()
    syncBounds()
    if (layout === 'overlay') rendererWindow?.focus()
  })

  mainWindow.on('close', () => {
    persistBounds()
    if (secondary && !secondary.isDestroyed() && secondary !== mainWindow) secondary.destroy()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererWindow = null
    mpvHost = null
    /**
     * The player IS the app. `window-all-closed` only fires when EVERY window
     * has gone, and the settings window is a top-level BrowserWindow created on
     * demand that nobody closes — so with it open, closing the player left the
     * process running forever. Measured: 0 s to exit without the settings
     * window, still alive after 16 s with it, 2 out of 2.
     */
    app.quit()
  })

  if (cfg.alwaysOnTop) setAlwaysOnTop(true)
}

export function showWindows(maximized: boolean): void {
  const main = alive(mainWindow)
  if (!main) return
  main.show()
  if (maximized) main.maximize()
  syncBounds()

  if (layout === 'compat') {
    alive(mpvHost)?.showInactive()
    main.focus()
    return
  }
  const ui = alive(rendererWindow)
  ui?.showInactive()
  // The overlay, not the main window, must own keyboard focus: it is the only
  // window that can see input.
  ui?.focus()
}

function clampToDisplay(b: {
  x?: number
  y?: number
  width: number
  height: number
}): { x?: number; y?: number; width: number; height: number } {
  let width = Math.max(480, Math.round(b.width))
  let height = Math.max(320, Math.round(b.height))
  if (b.x === undefined || b.y === undefined) return { width, height }

  const area = screen.getDisplayMatching({ x: b.x, y: b.y, width, height }).workArea

  // Restore the window strictly INSIDE one display's work area. A geometry
  // saved under a different monitor layout can otherwise leave the window
  // straddling two displays, which has been observed to leave mpv's D3D11
  // swapchain rendering black. Returning undefined coordinates lets Electron
  // centre the window instead.
  width = Math.min(width, area.width)
  height = Math.min(height, area.height)
  const x = Math.round(Math.min(Math.max(b.x, area.x), area.x + area.width - width))
  const y = Math.round(Math.min(Math.max(b.y, area.y), area.y + area.height - height))

  const fits =
    x >= area.x &&
    y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height
  return fits ? { x, y, width, height } : { width, height }
}

export function persistBounds(): void {
  const main = alive(mainWindow)
  if (!main || main.isFullScreen()) return
  const maximized = main.isMaximized()
  const b = maximized ? main.getNormalBounds() : main.getBounds()
  saveConfig({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

/**
 * U07. BOTH windows, with the correct relative levels.
 *
 * On Windows, 'floating'...'status' sit BELOW the taskbar while 'pop-up-menu'
 * and above sit above it. Getting this pair wrong is how the overlay ends up
 * underneath the video, so no caller chooses the level -- WindowService does.
 */
export function setAlwaysOnTop(on: boolean): void {
  alive(mainWindow)?.setAlwaysOnTop(on, 'floating')
  // The secondary window has to outrank the main one even when it is topmost.
  if (layout === 'overlay') alive(rendererWindow)?.setAlwaysOnTop(on, 'pop-up-menu')
  else alive(mpvHost)?.setAlwaysOnTop(on, 'pop-up-menu')
  saveConfig({ alwaysOnTop: on })
}

/** The window a dialog must be parented to: in overlay layout the OVERLAY,
 *  because parenting to the video window puts the dialog behind it. */
export function getDialogParent(): BrowserWindow | null {
  return alive(layout === 'overlay' ? rendererWindow : mainWindow) ?? alive(mainWindow)
}

export function clampRectToDisplay(b: {
  x?: number
  y?: number
  width: number
  height: number
}): { x?: number; y?: number; width: number; height: number } {
  return clampToDisplay(b)
}

export function setFullScreen(on: boolean): void {
  const main = alive(mainWindow)
  if (!main) return
  main.setFullScreen(on)
  syncBounds()
}

export function toggleFullScreen(): boolean {
  const main = alive(mainWindow)
  if (!main) return false
  const next = !main.isFullScreen()
  setFullScreen(next)
  return next
}

export function toggleMaximize(): void {
  const main = alive(mainWindow)
  if (!main) return
  if (main.isMaximized()) main.unmaximize()
  else main.maximize()
}

// --- manual move / resize -------------------------------------------------
// In overlay mode the UI window covers the frame completely, so Windows never
// delivers hit-test messages for it. Both gestures are driven here by polling
// the cursor while the renderer holds pointer capture.

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

let dragTimer: NodeJS.Timeout | null = null

export function beginDrag(mode: 'move' | 'resize', edge?: Edge): void {
  const main = alive(mainWindow)
  if (!main || main.isFullScreen()) return
  endDrag()

  const start = screen.getCursorScreenPoint()
  const origin = main.getBounds()
  const wasMaximized = main.isMaximized()

  dragTimer = setInterval(() => {
    const win = alive(mainWindow)
    if (!win) return endDrag()
    const now = screen.getCursorScreenPoint()
    const dx = now.x - start.x
    const dy = now.y - start.y

    if (mode === 'move') {
      // Dragging a maximized window restores it and keeps dragging, the way a
      // normal Windows titlebar behaves.
      if (wasMaximized && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        win.unmaximize()
        const nb = win.getBounds()
        win.setPosition(Math.round(now.x - nb.width / 2), Math.round(now.y - 20))
        endDrag()
        beginDrag('move')
        return
      }
      win.setPosition(origin.x + dx, origin.y + dy)
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
    win.setBounds({ x, y, width, height })
  }, 16)
}

export function endDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}
