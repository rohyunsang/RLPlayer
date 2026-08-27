/**
 * Physical-key accelerators. WAVE 0 — FROZEN.
 *
 * `e.code`, never `e.key` (P16). With the Korean IME composing, `e.key` is
 * `'Process'` and `e.keyCode` is 229 for every letter, so a `key`-based
 * accelerator silently stops working the moment someone switches to 한글 — the
 * single most common input bug in a Korean-market player. `e.code` describes
 * the physical key and is unaffected by IME state or keyboard layout.
 *
 * Modifier order is fixed at Ctrl+Alt+Shift so plain string comparison is safe.
 * Mouse and wheel share this namespace using mpv's own names (P22, P23) so a
 * config file stays readable and the strings stay valid if input is ever
 * delegated to mpv.
 */

export type Accel = string

export interface AccelSource {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** Only consulted when `code` is empty (some synthetic events). */
  key?: string
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight'
])

/** True for a key that only ever appears as a modifier — never an accelerator. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

export function accelFromEvent(e: AccelSource): Accel {
  const code = e.code || e.key || ''
  if (!code || isModifierCode(code)) return ''
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(code)
  return parts.join('+')
}

/** mpv's mouse button names, so bindings read the same in either world. */
export const MOUSE_NAMES = [
  'MBTN_LEFT',
  'MBTN_MID',
  'MBTN_RIGHT',
  'MBTN_BACK',
  'MBTN_FORWARD',
  'MBTN_LEFT_DBL',
  'MBTN_MID_DBL',
  'MBTN_RIGHT_DBL',
  'WHEEL_UP',
  'WHEEL_DOWN',
  'WHEEL_LEFT',
  'WHEEL_RIGHT'
] as const

export type MouseName = (typeof MOUSE_NAMES)[number]

const MOUSE_BUTTON_BY_INDEX: Record<number, string> = {
  0: 'MBTN_LEFT',
  1: 'MBTN_MID',
  2: 'MBTN_RIGHT',
  3: 'MBTN_BACK',
  4: 'MBTN_FORWARD'
}

export function accelFromMouse(e: {
  button: number
  detail?: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): Accel {
  const base = MOUSE_BUTTON_BY_INDEX[e.button]
  if (!base) return ''
  const name = (e.detail ?? 1) >= 2 ? `${base}_DBL` : base
  return withModifiers(name, e)
}

export function accelFromWheel(e: {
  deltaY: number
  deltaX: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): Accel {
  let name: string
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) name = e.deltaX < 0 ? 'WHEEL_LEFT' : 'WHEEL_RIGHT'
  else name = e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN'
  return withModifiers(name, e)
}

function withModifiers(
  name: string,
  e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
): Accel {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(name)
  return parts.join('+')
}

/**
 * Reorder and canonicalise a hand-written accelerator so `Shift+Ctrl+KeyS` and
 * `Ctrl+Shift+KeyS` are the same string. Unknown segments pass through so a
 * future mpv key name is not silently dropped.
 */
export function normalizeAccel(accel: string): Accel {
  const raw = accel.split('+').filter(Boolean)
  const base = raw.pop()
  if (!base) return ''
  const mods = new Set(raw.map((m) => m.toLowerCase()))
  const parts: string[] = []
  if (mods.has('ctrl') || mods.has('control')) parts.push('Ctrl')
  if (mods.has('alt')) parts.push('Alt')
  if (mods.has('shift')) parts.push('Shift')
  parts.push(base)
  return parts.join('+')
}

/**
 * code → what is printed on the key. Used for the cheat sheet and the keybind
 * editor; refined at runtime by `navigator.keyboard.getLayoutMap()` where the
 * browser offers it, which is what makes AZERTY and Dvorak read correctly.
 */
const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter (숫자패드)',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: '+ (숫자패드)',
  NumpadSubtract: '- (숫자패드)',
  NumpadMultiply: '* (숫자패드)',
  NumpadDivide: '/ (숫자패드)',
  NumpadDecimal: '. (숫자패드)',
  ScrollLock: 'Scroll Lock',
  MBTN_LEFT: '왼쪽 클릭',
  MBTN_MID: '가운데 클릭',
  MBTN_RIGHT: '오른쪽 클릭',
  MBTN_BACK: '뒤로 버튼',
  MBTN_FORWARD: '앞으로 버튼',
  MBTN_LEFT_DBL: '왼쪽 더블클릭',
  MBTN_MID_DBL: '가운데 더블클릭',
  MBTN_RIGHT_DBL: '오른쪽 더블클릭',
  WHEEL_UP: '휠 위로',
  WHEEL_DOWN: '휠 아래로',
  WHEEL_LEFT: '휠 왼쪽',
  WHEEL_RIGHT: '휠 오른쪽'
}

/** Human-readable form of one accelerator segment. */
export function labelForCode(code: string, layout?: Map<string, string>): string {
  const fromLayout = layout?.get(code)
  if (fromLayout) return fromLayout.toUpperCase()
  const known = CODE_LABELS[code]
  if (known) return known
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `${code.slice(6)} (숫자패드)`
  if (/^F\d{1,2}$/.test(code)) return code
  return code
}

/** Human-readable form of a whole accelerator, e.g. 'Ctrl+Shift+S'. */
export function labelForAccel(accel: string, layout?: Map<string, string>): string {
  const parts = accel.split('+')
  const base = parts.pop() ?? ''
  return [...parts, labelForCode(base, layout)].join('+')
}
