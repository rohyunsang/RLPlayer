/**
 * M01 video-color — the pure half: value ranges, the colour tuple and the three
 * lavfi specs from §2's video table. No `ctx`, no mpv, no Electron, so every
 * line here is reachable from `node --test`.
 *
 * The five knobs (V01, V02) are NATIVE mpv properties, not filters: under
 * gpu-next they are VO-level, which is why they are free and hwdec-safe. The
 * three filters below (V05, V06, V07) are ordinary lavfi and therefore force an
 * hwdec copy-back — the two halves of this module cost completely different
 * amounts and the UI has to say so.
 */

// ---------------------------------------------------------------------------
// V01 / V02 — the five properties
// ---------------------------------------------------------------------------

export type ColourKnob = 'brightness' | 'contrast' | 'saturation' | 'hue' | 'gamma'

/**
 * Declaration order, which is also settings order and OSD order. NOT derived
 * from `mod.ownsProperties`: that array also carries `video-output-levels`,
 * which is an enum and not one of the five −100..100 sliders.
 */
export const COLOUR_KNOBS: readonly ColourKnob[] = [
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'gamma'
]

export type ColourTuple = Record<ColourKnob, number>

/** All five at mpv's own default. §2 V01/V02: every one of them defaults to 0. */
export const NEUTRAL: Readonly<ColourTuple> = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  gamma: 0
})

export const COLOUR_MIN = -100
export const COLOUR_MAX = 100

/** −100..100, integer. mpv rejects a float here, and NaN silently becomes 0. */
export function clampColour(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(COLOUR_MAX, Math.max(COLOUR_MIN, Math.round(n)))
}

/** A stored slice, a settings read or an IPC payload, narrowed to a real tuple. */
export function toTuple(partial: Readonly<Record<string, unknown>> | undefined): ColourTuple {
  const out: ColourTuple = { ...NEUTRAL }
  for (const k of COLOUR_KNOBS) {
    const v = partial?.[k]
    if (v !== undefined && v !== null) out[k] = clampColour(v)
  }
  return out
}

export const isNeutral = (t: Readonly<ColourTuple>): boolean =>
  COLOUR_KNOBS.every((k) => t[k] === 0)

/** The knobs on which `a` and `b` differ — the write set for one apply. */
export function changedKnobs(
  a: Readonly<ColourTuple>,
  b: Readonly<ColourTuple>
): readonly ColourKnob[] {
  return COLOUR_KNOBS.filter((k) => a[k] !== b[k])
}

/** `+12` / `-3` / `0`, for the OSD readout. */
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

/** 0..1 for the OSD's bar: −100 empty, 0 centred, +100 full. */
export const osdFraction = (n: number): number =>
  (clampColour(n) - COLOUR_MIN) / (COLOUR_MAX - COLOUR_MIN)

// ---------------------------------------------------------------------------
// V04 — video-output-levels
// ---------------------------------------------------------------------------

export type OutputLevels = 'auto' | 'limited' | 'full'
export const OUTPUT_LEVELS: readonly OutputLevels[] = ['auto', 'limited', 'full']

export const toOutputLevels = (v: unknown): OutputLevels =>
  v === 'limited' || v === 'full' ? v : 'auto'

// ---------------------------------------------------------------------------
// The three filter slots
// ---------------------------------------------------------------------------

/** One `<x>f-command` payload: the four verified arguments minus the label. */
export interface LiveOption {
  option: string
  value: string
  filter: string
}

/**
 * lavfi wants `0.0625`, not `0.06250000000000001` and not `6.25e-2`.
 *
 * `toFixed(4)` then strip: 0.0625 -> '0.0625', 0.9176 -> '0.9176', 0 -> '0',
 * 0.5 -> '0.5'. Four places is the precision §2's V05 literal uses.
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const fixed = n.toFixed(4)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

// --- V05: level control (black / white point) ------------------------------

export interface LevelsState {
  /** Input black point, 0.0–1.0. */
  black: number
  /** Input white point, 0.0–1.0. */
  white: number
}

/** §2 V05's literal: 16/255 and 234/255 — limited-range in, full-range out. */
export const LEVELS_DEFAULTS: Readonly<LevelsState> = Object.freeze({
  black: 0.0625,
  white: 0.9176
})

const clamp01 = (n: number): number => (!Number.isFinite(n) ? 0 : Math.min(1, Math.max(0, n)))

/**
 * `colorlevels` takes six NAMED parameters and this module drives them as two
 * controls, because a per-channel black point is a colour-grading tool while
 * this row is a "my TV crushes blacks" fix. Named parameters also put every
 * live update on `specReflects` tier 1, which is the only tier that is a real
 * check.
 */
export function levelsSpec(s: Readonly<LevelsState>): string {
  const lo = fmt(clamp01(s.black))
  const hi = fmt(clamp01(s.white))
  return (
    `lavfi=[colorlevels=rimin=${lo}:gimin=${lo}:bimin=${lo}` +
    `:rimax=${hi}:gimax=${hi}:bimax=${hi}]`
  )
}

export function levelsLiveOptions(
  s: Readonly<LevelsState>,
  knob: keyof LevelsState
): readonly LiveOption[] {
  const value = fmt(clamp01(knob === 'black' ? s.black : s.white))
  const names = knob === 'black' ? ['rimin', 'gimin', 'bimin'] : ['rimax', 'gimax', 'bimax']
  return names.map((option) => ({ option, value, filter: 'colorlevels' }))
}

// --- V06: auto level control -----------------------------------------------

/**
 * §2 V06: "`smoothing=50` is mandatory or the picture pumps on every cut."
 *
 * So it is a constant and not a setting. A user who lowers it gets a player
 * that flickers on every shot change with no way to know why, and there is no
 * good value below it: 50 frames is about two seconds of averaging at 24 fps.
 */
export const AUTOLEVEL_SMOOTHING = 50

export const autoLevelSpec = (): string =>
  `lavfi=[normalize=blackpt=black:whitept=white:smoothing=${AUTOLEVEL_SMOOTHING}]`

// --- V07: luma / chroma offset ---------------------------------------------

export interface ChromaShiftState {
  /** Horizontal chroma offset in pixels; drives both cb and cr. */
  horizontal: number
  /** Vertical chroma offset in pixels. */
  vertical: number
}

export const CHROMA_SHIFT_DEFAULTS: Readonly<ChromaShiftState> = Object.freeze({
  horizontal: 0,
  vertical: 0
})

export const CHROMA_SHIFT_LIMIT = 20

const clampShift = (n: number): number => {
  if (!Number.isFinite(n)) return 0
  return Math.min(CHROMA_SHIFT_LIMIT, Math.max(-CHROMA_SHIFT_LIMIT, Math.round(n)))
}

/**
 * §2 V07: "Chroma only. There is no luma-offset filter; ship chroma and say so
 * rather than faking it with crop+pad." So the label says chroma, the i18n
 * string says chroma, and there is no luma control here at all.
 */
export function chromaShiftSpec(s: Readonly<ChromaShiftState>): string {
  const h = clampShift(s.horizontal)
  const v = clampShift(s.vertical)
  return `lavfi=[chromashift=cbh=${h}:cbv=${v}:crh=${h}:crv=${v}]`
}

export function chromaShiftLiveOptions(
  s: Readonly<ChromaShiftState>,
  knob: keyof ChromaShiftState
): readonly LiveOption[] {
  const value = String(clampShift(knob === 'horizontal' ? s.horizontal : s.vertical))
  const names = knob === 'horizontal' ? ['cbh', 'crh'] : ['cbv', 'crv']
  return names.map((option) => ({ option, value, filter: 'chromashift' }))
}
