/** Types shared across main, preload and renderer. */

export interface Track {
  id: number
  type: 'video' | 'audio' | 'sub'
  title?: string
  lang?: string
  selected: boolean
  external?: boolean
  codec?: string
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
}

export interface Keybinds {
  [accel: string]: string
}

export interface AppConfig {
  volume: number
  muted: boolean
  speed: number
  alwaysOnTop: boolean
  resumePlayback: boolean
  autoLoadSubs: boolean
  playlistPanelOpen: boolean
  repeat: 'off' | 'one' | 'all'
  shuffle: boolean
  subScale: number
  screenshotDir: string
  audioDevice: string
  hwdec: string
  window: { x?: number; y?: number; width: number; height: number; maximized: boolean }
  keybinds: Keybinds
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
