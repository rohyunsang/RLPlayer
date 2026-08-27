import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AppConfig, Keybinds } from '@shared/types'

/**
 * Default keybinds. Deliberately the conventions people already have muscle
 * memory for from PotPlayer / VLC / mpv. Users can edit these in config.json.
 */
export const DEFAULT_KEYBINDS: Keybinds = {
  Space: 'playPause',
  K: 'playPause',
  ArrowRight: 'seek:5',
  ArrowLeft: 'seek:-5',
  'Shift+ArrowRight': 'seek:60',
  'Shift+ArrowLeft': 'seek:-60',
  'Ctrl+ArrowRight': 'seek:30',
  'Ctrl+ArrowLeft': 'seek:-30',
  ArrowUp: 'volume:5',
  ArrowDown: 'volume:-5',
  F: 'fullscreen',
  Escape: 'exitFullscreen',
  M: 'mute',
  '[': 'speed:-0.25',
  ']': 'speed:0.25',
  Backspace: 'speedReset',
  ',': 'frameBack',
  '.': 'frameForward',
  S: 'screenshot',
  'Ctrl+S': 'screenshotClipboard',
  N: 'next',
  P: 'previous',
  L: 'togglePlaylist',
  T: 'alwaysOnTop',
  V: 'toggleSubs',
  J: 'cycleSub',
  A: 'cycleAudio',
  'Ctrl+O': 'open',
  'Ctrl+,': 'settings',
  'Shift+G': 'subDelay:0.1',
  'Shift+F': 'subDelay:-0.1',
  'Shift+A': 'audioDelay:0.1',
  'Shift+Z': 'audioDelay:-0.1',
  Home: 'seekStart',
  End: 'seekEnd'
}

export const DEFAULT_CONFIG: AppConfig = {
  volume: 100,
  muted: false,
  speed: 1,
  alwaysOnTop: false,
  resumePlayback: true,
  autoLoadSubs: true,
  playlistPanelOpen: false,
  repeat: 'off',
  shuffle: false,
  subScale: 1,
  screenshotDir: '',
  audioDevice: 'auto',
  hwdec: 'auto-safe',
  window: { width: 1100, height: 660, maximized: false },
  keybinds: DEFAULT_KEYBINDS
}

/**
 * Portable mode: if `portable.txt` sits next to the executable, every bit of
 * state lives in a `data/` folder beside the exe instead of %APPDATA%.
 */
export function isPortable(): boolean {
  try {
    return fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'portable.txt'))
  } catch {
    return false
  }
}

export function dataDir(): string {
  const dir = isPortable()
    ? path.join(path.dirname(app.getPath('exe')), 'data')
    : app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const configPath = (): string => path.join(dataDir(), 'config.json')

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Shallow-merge persisted values over defaults so new keys appear on upgrade. */
function merge(base: AppConfig, patch: Record<string, unknown>): AppConfig {
  const out: AppConfig = { ...base, window: { ...base.window }, keybinds: { ...base.keybinds } }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in base)) continue
    if (k === 'window' && isPlainObject(v)) {
      out.window = { ...out.window, ...(v as AppConfig['window']) }
    } else if (k === 'keybinds' && isPlainObject(v)) {
      out.keybinds = { ...out.keybinds, ...(v as Keybinds) }
    } else {
      ;(out as unknown as Record<string, unknown>)[k] = v
    }
  }
  return out
}

let cached: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    cached = isPlainObject(parsed) ? merge(DEFAULT_CONFIG, parsed) : { ...DEFAULT_CONFIG }
  } catch {
    cached = { ...DEFAULT_CONFIG }
  }
  return cached
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = merge(loadConfig(), patch as Record<string, unknown>)
  cached = next
  try {
    // Write-then-rename so a crash mid-write cannot leave a truncated config.
    const target = configPath()
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  } catch (e) {
    console.error('[config] save failed:', (e as Error).message)
  }
  return next
}

export function configFilePath(): string {
  return configPath()
}
