import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppConfig,
  AudioDevice,
  OsdPayload,
  PlayerAction,
  PlayerState,
  PlaylistState,
  ProgressPayload,
  ResolvedKeybinds,
  ToastPayload
} from '@shared/types'

/**
 * WAVE 0, then FROZEN. Nobody edits this file again.
 *
 * TWO surfaces, deliberately:
 *
 *  1. `window.rl` — the GENERIC bridge (§3.3.4). One `invoke`/`send`/`on`, with
 *     a shape check on the channel name. Every feature module's renderer half
 *     talks through this, so shipping a module never means adding a method
 *     here. The regex is a shape check, NOT the security boundary: main only
 *     has a handler for channels a module actually registered under its own id,
 *     so a channel nobody published cannot be reached at all.
 *
 *  2. `window.rlplayer` — the typed CORE surface. It carries the core player
 *     state, config and the app shell, and feature modules do not extend it.
 *
 * Raw `ipcRenderer` is never exposed on either.
 */

const CHANNEL_RE = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/

function check(channel: string): void {
  if (!CHANNEL_RE.test(channel)) throw new Error(`bad channel: ${channel}`)
}

const rl = {
  invoke(channel: string, req?: unknown): Promise<unknown> {
    check(channel)
    return ipcRenderer.invoke(channel, req)
  },
  send(channel: string, req?: unknown): void {
    check(channel)
    ipcRenderer.send(channel, req)
  },
  on(channel: string, cb: (payload: unknown) => void): () => void {
    check(channel)
    const h = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.off(channel, h)
  }
}

const api = {
  // --- push channels ---
  onState(cb: (s: PlayerState) => void): () => void {
    const h = (_e: unknown, s: PlayerState): void => cb(s)
    ipcRenderer.on('player:state', h)
    return () => ipcRenderer.off('player:state', h)
  },
  onPlaylist(cb: (p: PlaylistState) => void): () => void {
    const h = (_e: unknown, p: PlaylistState): void => cb(p)
    ipcRenderer.on('playlist:state', h)
    return () => ipcRenderer.off('playlist:state', h)
  },
  onToast(cb: (t: ToastPayload) => void): () => void {
    const h = (_e: unknown, t: ToastPayload): void => cb(t)
    ipcRenderer.on('ui:toast', h)
    return () => ipcRenderer.off('ui:toast', h)
  },
  onOsd(cb: (o: OsdPayload) => void): () => void {
    const h = (_e: unknown, o: OsdPayload): void => cb(o)
    ipcRenderer.on('ui:osd', h)
    return () => ipcRenderer.off('ui:osd', h)
  },
  onProgress(cb: (p: ProgressPayload) => void): () => void {
    const h = (_e: unknown, p: ProgressPayload): void => cb(p)
    ipcRenderer.on('ui:progress', h)
    return () => ipcRenderer.off('ui:progress', h)
  },
  onKeybinds(cb: (k: ResolvedKeybinds) => void): () => void {
    const h = (_e: unknown, k: ResolvedKeybinds): void => cb(k)
    ipcRenderer.on('ui:keybinds', h)
    return () => ipcRenderer.off('ui:keybinds', h)
  },
  onChrome(cb: (mode: 'full' | 'minimal' | 'none') => void): () => void {
    const h = (_e: unknown, m: 'full' | 'minimal' | 'none'): void => cb(m)
    ipcRenderer.on('ui:chrome', h)
    return () => ipcRenderer.off('ui:chrome', h)
  },
  /** Main asking the overlay to run a named UI action (from the menu). */
  onUiCommand(cb: (name: string) => void): () => void {
    const h = (_e: unknown, name: string): void => cb(name)
    ipcRenderer.on('ui:command', h)
    return () => ipcRenderer.off('ui:command', h)
  },

  // --- commands: what the keyboard and the menus speak now ---
  invokeCommand(id: string, arg?: unknown): void {
    ipcRenderer.send('core-input:invoke', { id, arg })
  },
  keybinds(): Promise<ResolvedKeybinds> {
    return ipcRenderer.invoke('core-input:keybinds')
  },

  // --- playback (transitional: the legacy PlayerAction surface, §5.10) ---
  action(a: PlayerAction): void {
    ipcRenderer.send('player:action', a)
  },
  runBinding(name: string): void {
    ipcRenderer.send('player:binding', name)
  },
  restart(): void {
    ipcRenderer.send('player:restart')
  },
  toastAction(id: number): void {
    ipcRenderer.send('ui:toastAction', id)
  },

  // --- opening files ---
  openDialog(): void {
    ipcRenderer.send('file:openDialog')
  },
  openPaths(paths: string[]): void {
    ipcRenderer.send('file:openPaths', paths)
  },
  /**
   * Electron removed File.path; this is the supported way to recover a real
   * filesystem path from a dropped File.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // --- playlist: M28's own channels ---
  playlist: {
    play(index: number): void {
      ipcRenderer.send('playlist:play', index)
    },
    remove(index: number): void {
      ipcRenderer.send('playlist:remove', index)
    },
    reorder(from: number, to: number): void {
      ipcRenderer.send('playlist:reorder', { from, to })
    },
    togglePanel(): void {
      ipcRenderer.send('playlist:togglePanel')
    },
    setRepeat(mode: 'off' | 'one' | 'all'): void {
      ipcRenderer.send('playlist:setRepeat', mode)
    },
    setShuffle(on: boolean): void {
      ipcRenderer.send('playlist:setShuffle', on)
    },
    request(): void {
      ipcRenderer.send('playlist:request')
    }
  },

  // --- window chrome: M31's own channels, plus the layout plumbing ---
  window: {
    minimize(): void {
      ipcRenderer.send('shell-window:minimize')
    },
    toggleMaximize(): void {
      ipcRenderer.send('shell-window:toggleMaximize')
    },
    close(): void {
      ipcRenderer.send('shell-window:close')
    },
    beginDrag(mode: 'move' | 'resize', edge?: string): void {
      ipcRenderer.send('shell-window:beginDrag', { mode, edge })
    },
    endDrag(): void {
      ipcRenderer.send('shell-window:endDrag')
    },
    toggleFullscreen(): void {
      ipcRenderer.send('shell-window:toggleFullscreen')
    },
    setFullscreen(on: boolean): void {
      ipcRenderer.send('shell-window:setFullscreen', on)
    },
    toggleAlwaysOnTop(): void {
      ipcRenderer.send('shell-window:cycleOnTop')
    },
    /**
     * Compat layout only: tell main which rectangle of the page is reserved for
     * video, so it can place mpv's inset child window over exactly that area.
     */
    setVideoRegion(r: { x: number; y: number; width: number; height: number }): void {
      ipcRenderer.send('window:videoRegion', r)
    }
  },

  /** Native popup menu (renders above mpv's child HWND, unlike HTML). */
  menu: {
    popup(x?: number, y?: number): void {
      ipcRenderer.send('ui:popupMenu', { x, y })
    }
  },

  // --- config & settings ---
  config: {
    get(): Promise<AppConfig> {
      return ipcRenderer.invoke('config:get')
    },
    set(patch: Partial<AppConfig>): Promise<AppConfig> {
      return ipcRenderer.invoke('config:set', patch)
    },
    reset(): Promise<AppConfig> {
      return ipcRenderer.invoke('config:reset')
    }
  },
  settings: {
    open(): void {
      ipcRenderer.send('settings:open')
    },
    close(): void {
      ipcRenderer.send('settings:close')
    }
  },

  // --- system ---
  system: {
    audioDevices(): Promise<AudioDevice[]> {
      return ipcRenderer.invoke('audio-devices:list')
    },
    /** Windows will not let an app make itself the default handler. */
    openDefaultAppsSettings(): void {
      ipcRenderer.send('system:openDefaultApps')
    },
    openReleasesPage(): void {
      ipcRenderer.send('core-input:invoke', { id: 'core.openReleases' })
    },
    openConfigFolder(): void {
      ipcRenderer.send('system:openConfigFolder')
    },
    /** Window topology is fixed at creation, so layout changes need a restart. */
    relaunch(): void {
      ipcRenderer.send('system:relaunch')
    },
    chooseScreenshotDir(): Promise<string | null> {
      return ipcRenderer.invoke('system:chooseScreenshotDir')
    },
    info(): Promise<{
      version: string
      portable: boolean
      configPath: string
      readOnly: boolean
      mpv: string
    }> {
      return ipcRenderer.invoke('system:info')
    }
  }
}

export type RlPlayerApi = typeof api
export type RlBridge = typeof rl

contextBridge.exposeInMainWorld('rlplayer', api)
contextBridge.exposeInMainWorld('rl', rl)
