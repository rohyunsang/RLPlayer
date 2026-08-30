/**
 * M03 video-enhance — the filter SPEC strings, kept pure.
 *
 * Everything here is a value in, a string out, with no `ctx` in sight, because
 * the §2.1 mappings were measured against the pinned binary and the only way to
 * keep them that way is to assert them character for character (`specs.test.ts`).
 * A spec string that drifts by one character is a filter that silently does not
 * load; mpv's answer to a bad `vf set` is a log line, not an exception.
 *
 * The label is NEVER part of a spec here: `ctx.vf.set('rl-sharpen', spec)`
 * emits `@rl-sharpen:<spec>` itself (§5).
 */

export type SharpenMode = 'cas' | 'unsharp'

/**
 * The libavfilter FILTER NAME behind each mode. This is the fourth argument of
 * `vf-command` — not the label, not 'all' (V09). The three-argument form
 * returns `error running command` for every filter.
 */
export const SHARPEN_FILTER: Record<SharpenMode, string> = {
  cas: 'cas',
  unsharp: 'unsharp'
}

export const DENOISE_FILTER = 'hqdn3d'

export interface SharpenState {
  readonly mode: SharpenMode
  /** CAS strength, 0.0–1.0 (V09). */
  readonly strength: number
  /** unsharp `luma_amount`, −2.0–5.0; the spec's literal default is 1.0 (V08). */
  readonly lumaAmount: number
  /** unsharp `chroma_amount`; the spec's literal default is 0.0 (V08). */
  readonly chromaAmount: number
}

export interface DenoiseState {
  /** hqdn3d `luma_spatial` — PotPlayer's "Luma" (V11). */
  readonly luma: number
  /** hqdn3d `chroma_spatial` — PotPlayer's "Chroma". */
  readonly chroma: number
  /** hqdn3d `luma_tmp` — PotPlayer's "Time". */
  readonly time: number
}

/** The literal defaults of the V08/V09 rows. */
export const SHARPEN_DEFAULTS: SharpenState = {
  mode: 'cas',
  strength: 0.4,
  lumaAmount: 1.0,
  chromaAmount: 0.0
}

/** The literal defaults of the V11 row: `hqdn3d=4:3:6:4.5`. */
export const DENOISE_DEFAULTS: DenoiseState = { luma: 4, chroma: 3, time: 6 }

/** V11: `chroma_tmp` is not a slider — it tracks `luma_tmp` at three quarters. */
export const CHROMA_TMP_RATIO = 0.75

/** unsharp's matrix size. Fixed at the spec's 5; it is not a user knob. */
const UNSHARP_MSIZE = 5

export function clamp(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(hi, Math.max(lo, value))
}

/** Shortest exact form: 4 -> '4', 4.5 -> '4.5'. hqdn3d's spec literal has no
 *  trailing '.0', and a spec string that differs from the measured one is a
 *  spec string nobody measured. */
export function level(value: number): string {
  const s = value.toFixed(2)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** Same, but never bare: 1 -> '1.0', 0 -> '0.0', 0.55 -> '0.55'. unsharp's and
 *  CAS's literals are written with a decimal place. */
export function amount(value: number): string {
  const s = level(value)
  return s.includes('.') ? s : `${s}.0`
}

/**
 * V08 / V09. CAS is the default sharpener and `unsharp` is "classic", and that
 * choice is load-bearing rather than cosmetic: `unsharp` is the one filter in
 * this spec that refuses `vf-command`, so every parameter change on it is a
 * whole-chain rebuild and an hwdec copy-back.
 */
export function sharpenSpec(s: SharpenState): string {
  if (s.mode === 'unsharp') {
    const m = UNSHARP_MSIZE
    return (
      `lavfi=[unsharp=luma_msize_x=${m}:luma_msize_y=${m}:` +
      `luma_amount=${amount(clamp(s.lumaAmount, -2, 5, SHARPEN_DEFAULTS.lumaAmount))}:` +
      `chroma_msize_x=${m}:chroma_msize_y=${m}:` +
      `chroma_amount=${amount(clamp(s.chromaAmount, -2, 5, SHARPEN_DEFAULTS.chromaAmount))}]`
    )
  }
  return `lavfi=[cas=strength=${amount(clamp(s.strength, 0, 1, SHARPEN_DEFAULTS.strength))}]`
}

/**
 * V11. Argument order is `luma_spatial:chroma_spatial:luma_tmp:chroma_tmp`, and
 * hqdn3d IS MPlayer's denoise3d, so the slider meanings port 1:1 from PotPlayer.
 */
export function denoiseSpec(d: DenoiseState): string {
  const luma = clamp(d.luma, 0, 10, DENOISE_DEFAULTS.luma)
  const chroma = clamp(d.chroma, 0, 10, DENOISE_DEFAULTS.chroma)
  const time = clamp(d.time, 0, 15, DENOISE_DEFAULTS.time)
  const chromaTime = Math.round(time * CHROMA_TMP_RATIO * 100) / 100
  return `lavfi=[hqdn3d=${level(luma)}:${level(chroma)}:${level(time)}:${level(chromaTime)}]`
}

/** One live `vf-command` payload: the option, its value, and the FILTER name. */
export interface LiveOption {
  readonly option: string
  readonly value: string
  readonly filter: string
}

export type SharpenKnob = 'strength' | 'lumaAmount' | 'chromaAmount'
export type DenoiseKnob = 'luma' | 'chroma' | 'time'

/**
 * The `vf-command` payload for one sharpen knob, or `undefined` when the knob
 * belongs to the mode that is NOT selected (nothing to send; the spec that
 * matters is the other mode's).
 *
 * `unsharp` is returned too, even though it is known to refuse: the refuser
 * table lives in `core/vf-chain`, not here (§5), and `chain-sync` learns the
 * answer from the path `command()` reports rather than duplicating the table.
 */
export function sharpenLiveOption(s: SharpenState, knob: SharpenKnob): LiveOption | undefined {
  if (s.mode === 'cas') {
    if (knob !== 'strength') return undefined
    return {
      option: 'strength',
      value: amount(clamp(s.strength, 0, 1, SHARPEN_DEFAULTS.strength)),
      filter: SHARPEN_FILTER.cas
    }
  }
  if (knob === 'lumaAmount') {
    return {
      option: 'luma_amount',
      value: amount(clamp(s.lumaAmount, -2, 5, SHARPEN_DEFAULTS.lumaAmount)),
      filter: SHARPEN_FILTER.unsharp
    }
  }
  if (knob === 'chromaAmount') {
    return {
      option: 'chroma_amount',
      value: amount(clamp(s.chromaAmount, -2, 5, SHARPEN_DEFAULTS.chromaAmount)),
      filter: SHARPEN_FILTER.unsharp
    }
  }
  return undefined
}

/**
 * The `vf-command` payloads for one denoise knob. "Time" is TWO options,
 * because `chroma_tmp` tracks `luma_tmp` — a single-option live update would
 * leave the chroma half at the previous value until the next rebuild.
 */
export function denoiseLiveOptions(d: DenoiseState, knob: DenoiseKnob): readonly LiveOption[] {
  const f = DENOISE_FILTER
  const time = clamp(d.time, 0, 15, DENOISE_DEFAULTS.time)
  switch (knob) {
    case 'luma':
      return [
        { option: 'luma_spatial', value: level(clamp(d.luma, 0, 10, DENOISE_DEFAULTS.luma)), filter: f }
      ]
    case 'chroma':
      return [
        {
          option: 'chroma_spatial',
          value: level(clamp(d.chroma, 0, 10, DENOISE_DEFAULTS.chroma)),
          filter: f
        }
      ]
    case 'time':
      return [
        { option: 'luma_tmp', value: level(time), filter: f },
        {
          option: 'chroma_tmp',
          value: level(Math.round(time * CHROMA_TMP_RATIO * 100) / 100),
          filter: f
        }
      ]
  }
}
