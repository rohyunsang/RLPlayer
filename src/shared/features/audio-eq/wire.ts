/**
 * M12 audio-eq — the payload types and the A01 band table, shared by both halves.
 *
 * THIS FILE IS THE ANSWER TO A COMMENT THIS MODULE SHIPPED WITH. `EqState.freqs`
 * carried this note:
 *
 *   "The renderer needs them to label and bound the sliders, and it CANNOT
 *    import them: `eq.ts` lives in this module's main directory, `tsconfig.web`
 *    is `composite`, and a composite project rejects a file outside its
 *    `include`. The two halves of a module have no file they both own."
 *
 * That was true and it is the defect, not a fact of life: `src/shared/**` is in
 * BOTH tsconfigs, so `src/shared/features/<module-id>/` is a file both halves
 * own -- and it is owned by the MODULE in `modules.json`, not by core. Without
 * it, `EqState` and `PresetWire` were declared twice, once per half, with nothing
 * comparing them; a field added on one side would have arrived as `undefined` on
 * the other.
 *
 * The band table lives here rather than in `eq.ts` for the same reason. It is
 * still sent on `EqState` (main stays authoritative about what is actually on
 * `@rleq` right now), but the numbers themselves no longer need to be a payload
 * to be reachable.
 *
 * Wire-only: no DOM, no `node:*`, no Electron, no behaviour.
 */

/** A01. Centres in Hz, low to high. PotPlayer's ten bands. */
export const BAND_FREQ: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/** A01. Filter widths in Hz, one per band. MEASURED, not computed from the
 *  frequencies -- the row carries its own table and it is not derivable. */
export const BAND_WIDTH: readonly number[] = [22, 44, 88, 175, 350, 700, 1400, 2800, 5600, 11000]

export const BAND_COUNT = 10

/** A01: `g` is in dB, matching PotPlayer's +/-12 dB range. */
export const GAIN_LIMIT = 12

export interface PresetWire {
  id: string
  builtIn: boolean
  gains: number[]
}

export interface EqState {
  enabled: boolean
  gains: number[]
  autoPreamp: boolean
  manualPreamp: number
  /** What is actually on `@rlpre` right now. */
  preamp: number
  presets: PresetWire[]
  /** The preset the current curve equals, or null for a hand-shaped curve. */
  presetId: string | null
  /**
   * The band centres and the dB limit AS MAIN CURRENTLY HAS THEM.
   *
   * Still on the wire even though the table above is now importable, because
   * these describe the live chain rather than the constants: a future row that
   * changes the band count would move `@rleq` and this payload together, and a
   * renderer reading only the constant would draw sliders for a graph mpv does
   * not have.
   */
  freqs: number[]
  limit: number
}
