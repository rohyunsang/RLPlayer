import type { Keybinds } from './types'

/**
 * Keybinds ship as DATA, not code, so users can rebind anything from
 * config.json without a rebuild.
 *
 * PotPlayer and mpv genuinely disagree on F, Q, PgUp/PgDn and [ / ], so rather
 * than inventing a fourth convention we ship all three and let people pick.
 */
export type KeybindPreset = 'default' | 'potplayer' | 'mpv'

export const PRESET_LABELS: Record<KeybindPreset, string> = {
  default: 'RLPlayer 기본',
  potplayer: 'PotPlayer 호환',
  mpv: 'mpv 호환'
}

/**
 * RLPlayer's own preset. Two deliberate rules:
 *   1. No bare-key quit. Nothing closes the app without a modifier -- losing
 *      your place because you brushed Q is the kind of thing that makes people
 *      distrust a player.
 *   2. Bare keys navigate WITHIN the file (seek, chapters, frame step);
 *      modifier keys navigate ACROSS files (next/previous in the playlist).
 *      Muscle memory then never jumps you out of what you are watching.
 */
const DEFAULT_PRESET: Keybinds = {
  Space: 'playPause',
  K: 'playPause',

  // within-file navigation: bare keys
  ArrowRight: 'seek:5',
  ArrowLeft: 'seek:-5',
  'Shift+ArrowRight': 'seek:60',
  'Shift+ArrowLeft': 'seek:-60',
  PageDown: 'chapterNext',
  PageUp: 'chapterPrev',
  Home: 'seekStart',
  End: 'seekEnd',
  ',': 'frameBack',
  '.': 'frameForward',

  // across-file navigation: modifier keys
  'Ctrl+ArrowRight': 'next',
  'Ctrl+ArrowLeft': 'previous',
  'Ctrl+PageDown': 'next',
  'Ctrl+PageUp': 'previous',

  ArrowUp: 'volume:5',
  ArrowDown: 'volume:-5',
  M: 'mute',

  F: 'fullscreen',
  Enter: 'fullscreen',
  Escape: 'exitFullscreen',

  '[': 'speed:-0.25',
  ']': 'speed:0.25',
  Backspace: 'speedReset',

  S: 'screenshot',
  'Ctrl+S': 'screenshotClipboard',

  L: 'togglePlaylist',
  T: 'alwaysOnTop',
  V: 'toggleSubs',
  J: 'cycleSub',
  A: 'cycleAudio',

  'Shift+G': 'subDelay:0.1',
  'Shift+F': 'subDelay:-0.1',
  'Shift+A': 'audioDelay:0.1',
  'Shift+Z': 'audioDelay:-0.1',

  'Ctrl+O': 'open',
  'Ctrl+,': 'settings',
  'Ctrl+Q': 'quit'
}

/** PotPlayer conventions: Enter for fullscreen, PgUp/PgDn across files, C/X/Z speed. */
const POTPLAYER_PRESET: Keybinds = {
  Space: 'playPause',
  ArrowRight: 'seek:5',
  ArrowLeft: 'seek:-5',
  'Shift+ArrowRight': 'seek:30',
  'Shift+ArrowLeft': 'seek:-30',
  'Ctrl+ArrowRight': 'seek:60',
  'Ctrl+ArrowLeft': 'seek:-60',
  ArrowUp: 'volume:5',
  ArrowDown: 'volume:-5',
  PageDown: 'next',
  PageUp: 'previous',
  Enter: 'fullscreen',
  'Alt+Enter': 'fullscreen',
  F: 'fullscreen',
  Escape: 'exitFullscreen',
  M: 'mute',
  C: 'speed:0.25',
  X: 'speed:-0.25',
  Z: 'speedReset',
  D: 'frameForward',
  ',': 'frameBack',
  '.': 'frameForward',
  S: 'screenshot',
  'Ctrl+C': 'screenshotClipboard',
  L: 'togglePlaylist',
  T: 'alwaysOnTop',
  Home: 'seekStart',
  End: 'seekEnd',
  'Ctrl+O': 'open',
  'Ctrl+Q': 'quit'
}

/** mpv conventions: Up/Down seek a minute, 9/0 are volume, q quits. */
const MPV_PRESET: Keybinds = {
  Space: 'playPause',
  P: 'playPause',
  ArrowRight: 'seek:5',
  ArrowLeft: 'seek:-5',
  ArrowUp: 'seek:60',
  ArrowDown: 'seek:-60',
  '9': 'volume:-2',
  '0': 'volume:2',
  M: 'mute',
  F: 'fullscreen',
  Escape: 'exitFullscreen',
  '[': 'speed:-0.25',
  ']': 'speed:0.25',
  Backspace: 'speedReset',
  '<': 'previous',
  '>': 'next',
  ',': 'frameBack',
  '.': 'frameForward',
  S: 'screenshot',
  'Ctrl+S': 'screenshotClipboard',
  J: 'cycleSub',
  V: 'toggleSubs',
  '#': 'cycleAudio',
  PageUp: 'chapterPrev',
  PageDown: 'chapterNext',
  L: 'togglePlaylist',
  T: 'alwaysOnTop',
  // mpv users expect a bare q to quit; this preset is opt-in, so honour it.
  Q: 'quit',
  'Ctrl+O': 'open'
}

export const PRESETS: Record<KeybindPreset, Keybinds> = {
  default: DEFAULT_PRESET,
  potplayer: POTPLAYER_PRESET,
  mpv: MPV_PRESET
}

/** Preset first, then the user's own overrides from config.json on top. */
export function resolveKeybinds(preset: KeybindPreset, overrides: Keybinds): Keybinds {
  return { ...(PRESETS[preset] ?? DEFAULT_PRESET), ...overrides }
}

/**
 * Turn a KeyboardEvent into the accelerator string used as a keybind map key.
 * Letters normalise to uppercase so Shift+s and S do not diverge; modifiers
 * always appear in Ctrl+Alt+Shift order.
 */
export function eventToAccel(e: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string {
  let key = e.key
  if (key.length === 1) {
    const upper = key.toUpperCase()
    // Shift is implied by the character itself for punctuation like '<' or '#',
    // so only record it as a modifier for letters.
    if (upper !== key.toLowerCase()) key = upper
  }
  if (key === ' ') key = 'Space'

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey && /^[A-Z]$/.test(key)) parts.push('Shift')
  else if (e.shiftKey && key.length > 1) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
