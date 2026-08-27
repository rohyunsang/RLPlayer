/** Types shared across main, preload and renderer. */

export interface Track {
  id: number
  type: 'video' | 'audio' | 'sub'
  title?: string
  lang?: string
  selected: boolean
  external?: boolean
  codec?: string
  /** '6ch' / '2ch'. A10: often the only thing separating two untitled tracks. */
  channels?: string
}

export interface Chapter {
  title: string
  time: number
}

export interface PlaylistItem {
  path: string
  name: string
}

export interface AudioDevice {
  name: string
  description: string
}

/** Everything the renderer paints, pushed from main whenever it changes. */
export interface PlayerState {
  path: string | null
  title: string
  idle: boolean
  paused: boolean
  eof: boolean
  timePos: number
  duration: number
  volume: number
  muted: boolean
  speed: number
  tracks: Track[]
  sid: number | false
  aid: number | false
  vid: number | false
  chapters: Chapter[]
  chapter: number
  cacheSeconds: number
  subDelay: number
  audioDelay: number
  subScale: number
  subPos: number
  fullscreen: boolean
  alwaysOnTop: boolean
  maximized: boolean
  aspect: string
  rotate: number
  /** True while a network source is playing; gates streaming-only UI. */
  network: boolean
  layoutMode: 'overlay' | 'compat'
}

/** One OSD message, pushed from core/osd. Coalesced by `kind` in the overlay. */
export interface OsdPayload {
  kind: string
  text: string
  value?: number
  durationMs?: number
}

/** A long-running job's progress, pushed from core/osd. */
export interface ProgressPayload {
  id: string
  label: string
  fraction?: number
  detail?: string
  cancellable?: boolean
  done?: boolean
}

/**
 * The keybind table the overlay resolves key events against. Keys are
 * PHYSICAL accelerators ('Ctrl+Shift+KeyS'); values name a registered command.
 * P18: storage is Record<CommandId, Accel[]>; this is the derived lookup.
 */
export interface KeybindEntry {
  commandId: string
  label: string
  accelLabel: string
}
export type ResolvedKeybinds = Record<string, KeybindEntry>

export interface Keybinds {
  [accel: string]: string
}

export interface AppConfig {
  volume: number
  muted: boolean
  speed: number
  alwaysOnTop: boolean
  /** U07 is a four-mode cycle, not a boolean; `alwaysOnTop` is the legacy half. */
  alwaysOnTopMode: 'never' | 'always' | 'while-playing' | 'fullscreen-only'
  resumePlayback: boolean
  autoLoadSubs: boolean
  playlistPanelOpen: boolean
  repeat: 'off' | 'one' | 'all'
  shuffle: boolean
  subScale: number
  /** Force our own subtitle styling over the file's ASS styling. Off by default. */
  subAssOverride: boolean
  /** Soft-limit the audio when volume goes above 100%. */
  volumeBoostLimiter: boolean
  screenshotDir: string
  audioDevice: string
  hwdec: string
  /** mpv video output driver. gpu-next by default; gpu is the safe fallback. */
  vo: string
  /**
   * 'overlay'  transparent UI window floating over the video (default)
   * 'compat'   no transparent window anywhere: the UI is docked around an
   *            inset video area. Escape hatch for Electron issue #40515, where
   *            transparent windows render black on some Windows GPUs.
   */
  layoutMode: 'overlay' | 'compat'
  window: { x?: number; y?: number; width: number; height: number; maximized: boolean }
  /** U09. Ids change when a monitor is unplugged, so the label is kept too. */
  fullscreenDisplay: { id: number; label: string } | null
  keybindPreset: 'default' | 'potplayer' | 'mpv'
  /** Legacy v0.1 overrides. The live store is keybinds.json (P18). */
  keybinds: Keybinds
  /** Per-OsdKind enable/disable (U04, P58). Missing means enabled. */
  osd: Record<string, boolean>
  /**
   * The settings descriptor registry's value bag. Only values that DIFFER from
   * their descriptor's default are present (P51).
   */
  settings: Record<string, unknown>
}

export interface ResumeEntry {
  key: string
  path: string
  position: number
  duration: number
  updatedAt: number
}

export interface ToastPayload {
  kind: 'resume' | 'info' | 'error'
  message: string
  actionLabel?: string
  action?: string
  data?: unknown
}

export interface PlaylistState {
  items: PlaylistItem[]
  index: number
  open: boolean
  repeat: 'off' | 'one' | 'all'
  shuffle: boolean
}

/** Commands the renderer may ask main to run. Keeps raw IPC off the renderer. */
export type PlayerAction =
  | { type: 'playPause' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; seconds: number; absolute?: boolean }
  | { type: 'frameStep'; back?: boolean }
  | { type: 'setVolume'; value: number }
  | { type: 'volumeBy'; delta: number }
  | { type: 'toggleMute' }
  | { type: 'setSpeed'; value: number }
  | { type: 'speedBy'; delta: number }
  | { type: 'setTrack'; kind: 'sid' | 'aid' | 'vid'; id: number | false }
  | { type: 'setSubDelay'; value: number }
  | { type: 'subDelayBy'; delta: number }
  | { type: 'setAudioDelay'; value: number }
  | { type: 'audioDelayBy'; delta: number }
  | { type: 'setSubScale'; value: number }
  | { type: 'setSubPos'; value: number }
  | { type: 'toggleSubs' }
  | { type: 'screenshot'; target: 'file' | 'clipboard' }
  | { type: 'setAspect'; value: string }
  | { type: 'rotate'; value: number }
  | { type: 'setAudioDevice'; value: string }
  | { type: 'loadSubtitle' }
  | { type: 'setChapter'; index: number }
  | { type: 'cycleAudio' }
  | { type: 'cycleSub' }
