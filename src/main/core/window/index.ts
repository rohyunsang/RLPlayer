import { powerSaveBlocker, screen, type BrowserWindow, type Rectangle } from 'electron'
import { loadConfig, saveConfig } from '../../services/config'
import {
  beginDrag,
  clampRectToDisplay,
  endDrag,
  getLayoutMode,
  getUiWindow,
  getVideoWindow,
  persistBounds as persistBoundsRaw,
  setAlwaysOnTop as setAlwaysOnTopRaw,
  setFullScreen as setFullScreenRaw,
  syncOverlay,
  toggleFullScreen as toggleFullScreenRaw
} from './windows'
import type {
  DisplayInfo,
  OnTopMode,
  Rect,
  SleepBlock,
  TaskbarSurface,
  Unsubscribe,
  WindowService
} from '@shared/feature-api'

/**
 * core/window — the WindowService implementation (§3.3.7). WAVE 0 — FROZEN.
 *
 * This service exists because it was missing. M31 (24 features, 8 of them P0),
 * M32 and M33 all needed `setAlwaysOnTop`, `setFullScreen`, `setContentSize`,
 * `showInactive` and the taskbar APIs, and `FeatureContext` exposed no window
 * handle at all — so all three would have edited one 414-line file. No feature
 * module imports `windows.ts`; CI greps for it the same way it greps for
 * `UserChoice`.
 *
 * Two rules a module never has to think about:
 *   - every mpv window option is INERT under `--wid` (§7.5), so window work is
 *     Electron work, full stop;
 *   - geometry here is DIP. `video-out-params/dw|dh` are REAL PIXELS, and the
 *     conversion is made once, in `deviceToDip()`, rather than in every caller.
 */

type FsListener = (on: boolean) => void

const fsListeners = new Set<FsListener>()
const displayListeners = new Set<() => void>()
const videoRegionListeners = new Set<(r: Rect) => void>()

let onTopMode: OnTopMode = 'never'
let playing = false
let miniPlayer: { bounds: Rectangle; onTop: OnTopMode; aspect: number; chrome: string } | null = null
let chromeMode: 'full' | 'minimal' | 'none' = 'full'
let aspectLock = 0
let preFullScreenBounds: Rectangle | null = null

let sleepDisplayId = -1
let sleepAppId = -1
const sleepHolders = { display: new Set<symbol>(), 'app-suspension': new Set<symbol>() }

/** Called once, after createWindows(). */
export function initWindowService(): void {
  const main = getVideoWindow()
  if (!main) return
  main.on('enter-full-screen', () => emitFullScreen(true))
  main.on('leave-full-screen', () => emitFullScreen(false))
  screen.on('display-added', notifyDisplays)
  screen.on('display-removed', notifyDisplays)
  screen.on('display-metrics-changed', notifyDisplays)
  const cfg = loadConfig()
  onTopMode = cfg.alwaysOnTop ? 'always' : 'never'
  applyOnTop()
}

function emitFullScreen(on: boolean): void {
  if (onTopMode === 'fullscreen-only') applyOnTop()
  for (const cb of [...fsListeners]) cb(on)
}

function notifyDisplays(): void {
  for (const cb of [...displayListeners]) cb()
}

/** The bus tells us whether playback is running so 'while-playing' can work. */
export function setPlaying(on: boolean): void {
  if (playing === on) return
  playing = on
  if (onTopMode === 'while-playing') applyOnTop()
}

export function notifyVideoRegion(r: Rect): void {
  for (const cb of [...videoRegionListeners]) cb(r)
}

function applyOnTop(): void {
  const main = getVideoWindow()
  const want =
    onTopMode === 'always'
      ? true
      : onTopMode === 'while-playing'
        ? playing
        : onTopMode === 'fullscreen-only'
          ? (main?.isFullScreen() ?? false)
          : false
  setAlwaysOnTopRaw(want)
}

function rect(b: Rectangle): Rect {
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

/** §7.7 trap 10. mpv reports device pixels; Electron takes DIP. */
export function deviceToDip(px: number, win?: BrowserWindow | null): number {
  const target = win ?? getVideoWindow()
  const scale = target
    ? screen.getDisplayMatching(target.getBounds()).scaleFactor
    : screen.getPrimaryDisplay().scaleFactor
  return Math.round(px / (scale || 1))
}

function taskbarSurface(): TaskbarSurface {
  return {
    setThumbarButtons(buttons): boolean {
      return getVideoWindow()?.setThumbarButtons(buttons as never) ?? false
    },
    setProgressBar(value, opts): void {
      getVideoWindow()?.setProgressBar(value, opts as never)
    },
    setOverlayIcon(icon, description): void {
      getVideoWindow()?.setOverlayIcon(icon as never, description)
    },
    setThumbnailClip(r): void {
      getVideoWindow()?.setThumbnailClip(r)
    },
    setThumbnailToolTip(s): void {
      getVideoWindow()?.setThumbnailToolTip(s)
    }
  }
}

function refreshSleepBlockers(): void {
  const wantDisplay = sleepHolders.display.size > 0
  const wantApp = sleepHolders['app-suspension'].size > 0 || wantDisplay
  if (wantDisplay && sleepDisplayId < 0) {
    sleepDisplayId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (!wantDisplay && sleepDisplayId >= 0) {
    powerSaveBlocker.stop(sleepDisplayId)
    sleepDisplayId = -1
  }
  if (wantApp && sleepAppId < 0 && !wantDisplay) {
    sleepAppId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!wantApp && sleepAppId >= 0) {
    powerSaveBlocker.stop(sleepAppId)
    sleepAppId = -1
  }
}

/** Every handle taken by `ownerId`, so dispose() can release them all. */
const holdersByOwner = new Map<string, Set<symbol>>()

export function releaseSleepBlocksFor(ownerId: string): void {
  const owned = holdersByOwner.get(ownerId)
  if (!owned) return
  for (const token of owned) {
    sleepHolders.display.delete(token)
    sleepHolders['app-suspension'].delete(token)
  }
  holdersByOwner.delete(ownerId)
  refreshSleepBlockers()
}

export function createWindowService(ownerId: string): WindowService {
  const service: WindowService = {
    isFullScreen: () => getVideoWindow()?.isFullScreen() ?? false,
    setFullScreen(on: boolean): void {
      const main = getVideoWindow()
      if (main && on && !main.isFullScreen()) preFullScreenBounds = main.getBounds()
      setFullScreenRaw(on)
      if (main && !on && preFullScreenBounds) {
        // U09: restore the PRE-fullscreen bounds, not the ones we moved to.
        const restore = preFullScreenBounds
        preFullScreenBounds = null
        setTimeout(() => main.setBounds(restore), 0)
      }
    },
    toggleFullScreen(): void {
      service.setFullScreen(!service.isFullScreen())
    },
    setFullScreenOnDisplay(displayId: number): void {
      const main = getVideoWindow()
      const display = screen.getAllDisplays().find((d) => d.id === displayId)
      if (!main || !display) return
      // Electron cannot enter fullscreen on a display the window is not on, so
      // move first and go fullscreen second. The order is the whole feature.
      if (main.isFullScreen()) main.setFullScreen(false)
      preFullScreenBounds = main.getBounds()
      main.setBounds({
        x: display.workArea.x + 40,
        y: display.workArea.y + 40,
        width: Math.min(main.getBounds().width, display.workArea.width - 80),
        height: Math.min(main.getBounds().height, display.workArea.height - 80)
      })
      setTimeout(() => setFullScreenRaw(true), 0)
      // Ids change when a monitor is unplugged; the label is the stable half.
      saveConfig({ fullscreenDisplay: { id: display.id, label: display.label } })
    },
    onFullScreenChange(cb: FsListener): Unsubscribe {
      fsListeners.add(cb)
      return () => fsListeners.delete(cb)
    },

    setAlwaysOnTop(mode: OnTopMode): void {
      onTopMode = mode
      applyOnTop()
      saveConfig({ alwaysOnTop: mode === 'always', alwaysOnTopMode: mode })
    },
    getAlwaysOnTop: () => onTopMode,

    getContentSize(): { width: number; height: number } {
      const [width = 0, height = 0] = getVideoWindow()?.getContentSize() ?? []
      return { width, height }
    },
    setContentSize(width: number, height: number, opts): void {
      const main = getVideoWindow()
      if (!main) return
      const before = main.getBounds()
      const area = screen.getDisplayMatching(before).workArea
      const w = Math.max(480, Math.min(Math.round(width), area.width))
      const h = Math.max(320, Math.min(Math.round(height), area.height))
      // Aspect lock is "not respected for programmatic setSize"; release it
      // around the resize and put it back, or the next user drag jumps.
      const locked = aspectLock
      if (locked) main.setAspectRatio(0)
      main.setContentSize(w, h)
      if (opts?.anchor === 'center') main.center()
      if (locked) main.setAspectRatio(locked)
      syncOverlay()
    },
    getBounds: () => rect(getVideoWindow()?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }),
    setBounds(b, opts): void {
      const main = getVideoWindow()
      if (!main) return
      const cur = main.getBounds()
      const next = {
        x: b.x ?? cur.x,
        y: b.y ?? cur.y,
        width: b.width ?? cur.width,
        height: b.height ?? cur.height
      }
      main.setBounds(opts?.clamp === false ? next : { ...next, ...clampRectToDisplay(next) })
      syncOverlay()
    },
    setAspectRatio(ratio: number, extraSize): void {
      aspectLock = ratio
      getVideoWindow()?.setAspectRatio(ratio, extraSize)
    },
    center: () => getVideoWindow()?.center(),
    maximize: () => getVideoWindow()?.maximize(),
    unmaximize: () => getVideoWindow()?.unmaximize(),
    isMaximized: () => getVideoWindow()?.isMaximized() ?? false,
    minimize: () => getVideoWindow()?.minimize(),
    restore: () => getVideoWindow()?.restore(),
    showInactive: () => getVideoWindow()?.showInactive(),
    /** Focus always goes to the OVERLAY: it is the only window that sees input. */
    focusInput: () => getUiWindow()?.focus(),
    beginDrag: (mode, edge) => beginDrag(mode, edge as never),
    endDrag: () => endDrag(),
    close: () => getVideoWindow()?.close(),

    displays(): readonly DisplayInfo[] {
      return screen.getAllDisplays().map((d) => ({
        id: d.id,
        label: d.label,
        bounds: rect(d.bounds),
        workArea: rect(d.workArea),
        scaleFactor: d.scaleFactor
      }))
    },
    currentDisplay(): { id: number; label: string } {
      const main = getVideoWindow()
      const d = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
      return { id: d.id, label: d.label }
    },
    persistBounds: () => persistBoundsRaw(),
    restoreBounds(): void {
      const cfg = loadConfig()
      service.setBounds({
        x: cfg.window.x,
        y: cfg.window.y,
        width: cfg.window.width,
        height: cfg.window.height
      })
    },
    onDisplayChange(cb): Unsubscribe {
      displayListeners.add(cb)
      return () => displayListeners.delete(cb)
    },

    enterMiniPlayer(opts): void {
      const main = getVideoWindow()
      if (!main || miniPlayer) return
      // Mutates the EXISTING window: no new window, no mpv respawn, so --wid
      // embedding is untouched. Bounds, aspect, ontop and chrome are saved and
      // restored as ONE unit, which is what makes 20 in-and-out cycles exact.
      miniPlayer = {
        bounds: main.getBounds(),
        onTop: onTopMode,
        aspect: aspectLock,
        chrome: chromeMode
      }
      const area = screen.getDisplayMatching(main.getBounds()).workArea
      const width = Math.max(240, opts?.width ?? 480)
      const height = Math.round((width * 9) / 16)
      const corner = opts?.corner ?? 'br'
      const x = corner.includes('l') ? area.x + 24 : area.x + area.width - width - 24
      const y = corner.startsWith('t') ? area.y + 24 : area.y + area.height - height - 24
      if (main.isMaximized()) main.unmaximize()
      main.setMinimumSize(240, 135)
      main.setBounds({ x, y, width, height })
      service.setAlwaysOnTop('always')
      service.setChrome('minimal')
      syncOverlay()
    },
    exitMiniPlayer(): void {
      const main = getVideoWindow()
      const saved = miniPlayer
      if (!main || !saved) return
      miniPlayer = null
      main.setMinimumSize(480, 320)
      main.setBounds(saved.bounds)
      service.setAlwaysOnTop(saved.onTop)
      service.setChrome(saved.chrome as 'full' | 'minimal' | 'none')
      if (saved.aspect) service.setAspectRatio(saved.aspect)
      syncOverlay()
    },
    isMiniPlayer: () => miniPlayer !== null,

    setChrome(mode): void {
      chromeMode = mode
      getUiWindow()?.webContents.send('ui:chrome', mode)
    },
    get layoutMode(): 'overlay' | 'compat' {
      return getLayoutMode()
    },
    onVideoRegionChange(cb): Unsubscribe {
      videoRegionListeners.add(cb)
      return () => videoRegionListeners.delete(cb)
    },

    blockSleep(kind, _reason): SleepBlock {
      const token = Symbol('sleep')
      sleepHolders[kind].add(token)
      let owned = holdersByOwner.get(ownerId)
      if (!owned) {
        owned = new Set()
        holdersByOwner.set(ownerId, owned)
      }
      owned.add(token)
      refreshSleepBlockers()
      let released = false
      return {
        release(): void {
          if (released) return
          released = true
          sleepHolders[kind].delete(token)
          owned?.delete(token)
          refreshSleepBlockers()
        }
      }
    }
  }

  // M32 is the only module granted the taskbar surface; the registry grants it
  // by module id, so nobody else can reach `setThumbarButtons` at all.
  if (ownerId === 'shell-taskbar') service.taskbar = taskbarSurface()
  return service
}
