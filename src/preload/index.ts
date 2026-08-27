import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppConfig,
  AudioDevice,
  Keybinds,
  PlayerAction,
  PlayerState,
  PlaylistState,
  ToastPayload
} from '@shared/types'

/**
 * The only surface the renderer ever sees. Raw ipcRenderer is deliberately not
 * exposed: every call below is a named, typed operation, so a compromised
 * renderer cannot reach arbitrary main-process channels.
 */
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
  onKeybinds(cb: (k: Keybinds) => void): () => void {
    const h = (_e: unknown, k: Keybinds): void => cb(k)
    ipcRenderer.on('ui:keybinds', h)
    return () => ipcRenderer.off('ui:keybinds', h)
  },
  /** Main asking the overlay to run a named UI action (from the menu). */
  onUiCommand(cb: (name: string) => void): () => void {
    const h = (_e: unknown, name: string): void => cb(name)
    ipcRenderer.on('ui:command', h)
    return () => ipcRenderer.off('ui:command', h)
  },

  // --- playback ---
  action(a: PlayerAction): void {
    ipcRenderer.send('player:action', a)
  },
  /** Run a keybind action string such as 'seek:-5'. */
  runBinding(name: string): void {
    ipcRenderer.send('player:binding', name)
  },
  /** Dismiss a resume offer and play the current file from the start. */
  restart(): void {
    ipcRenderer.send('player:restart')
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

  // --- playlist ---
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
    }
  },

  // --- window chrome (the overlay covers the real frame) ---
  window: {
    minimize(): void {
      ipcRenderer.send('window:minimize')
    },
    toggleMaximize(): void {
      ipcRenderer.send('window:toggleMaximize')
    },
    close(): void {
      ipcRenderer.send('window:close')
    },
    beginDrag(mode: 'move' | 'resize', edge?: string): void {
      ipcRenderer.send('window:beginDrag', { mode, edge })
    },
    endDrag(): void {
      ipcRenderer.send('window:endDrag')
    },
    toggleFullscreen(): void {
      ipcRenderer.send('window:toggleFullscreen')
    },
    setFullscreen(on: boolean): void {
      ipcRenderer.send('window:setFullscreen', on)
    },
    toggleAlwaysOnTop(): void {
      ipcRenderer.send('window:toggleAlwaysOnTop')
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
      return ipcRenderer.invoke('system:audioDevices')
    },
    /** Windows will not let an app make itself the default handler. */
    openDefaultAppsSettings(): void {
      ipcRenderer.send('system:openDefaultApps')
    },
    openReleasesPage(): void {
      ipcRenderer.send('system:openReleases')
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
    info(): Promise<{ version: string; portable: boolean; configPath: string; mpv: string }> {
      return ipcRenderer.invoke('system:info')
    }
  }
}

export type RlPlayerApi = typeof api

contextBridge.exposeInMainWorld('rlplayer', api)
