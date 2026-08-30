import { BAND_COUNT, normaliseGains } from './eq.ts'

/**
 * A02 — the preset list. Pure: parsing, merging and lookup only. The file IO
 * is in `index.ts`, so everything here is testable without a disk.
 *
 * "Ship presets as data so users can share JSON" (A02). The on-disk shape is
 * the row's shape and nothing else:
 *
 *   [{ "name": "My headphones", "gains": [3,2,0,0,-1,0,1,2,3,4] }]
 *
 * The shipped list is deliberately short. A02: "Voice/Dialogue and Bass boost
 * are the two people actually use; genre presets are decorative." Five entries
 * that each do something audible beat twenty that do not.
 */

export interface EqPreset {
  /** Stable identity. For a built-in it is also the i18n suffix; for a user
   *  preset it is the name out of the JSON file. */
  readonly id: string
  readonly gains: readonly number[]
  readonly builtIn: boolean
}

/** dB per band at 31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz. */
const BUILT_IN_TABLE: ReadonlyArray<{ id: string; gains: number[] }> = [
  { id: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  // Dialogue: drop the rumble a room adds, lift the 1-4 kHz band where
  // consonants live. The one preset people keep switched on.
  { id: 'voice', gains: [-4, -3, -2, 0, 3, 4, 4, 2, 0, -2] },
  { id: 'bass', gains: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  // Equal-loudness compensation for quiet listening, not a "rock" preset.
  { id: 'loudness', gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] }
]

export const BUILT_IN_PRESETS: readonly EqPreset[] = BUILT_IN_TABLE.map((p) => ({
  id: p.id,
  gains: normaliseGains(p.gains),
  builtIn: true
}))

export const PRESET_FILE = 'audio-eq-presets.json'

/**
 * Parse the user's preset file. A hand-edited JSON file is expected to be
 * wrong sometimes, so every failure mode is a dropped entry rather than a
 * throw: one bad row must not cost the user the other nine.
 */
export function parsePresetFile(text: string): EqPreset[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: EqPreset[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as { name?: unknown; gains?: unknown }
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (!name || seen.has(name)) continue
    if (!Array.isArray(rec.gains) || rec.gains.length === 0) continue
    // A file with the wrong band count is a real possibility (an AutoEq export,
    // a hand-typed row); normaliseGains pads and truncates rather than dropping
    // it, because the first nine bands of a ten-band curve are still useful.
    seen.add(name)
    out.push({ id: name, gains: normaliseGains(rec.gains), builtIn: false })
  }
  return out
}

/** What the file should contain after the user saves the current curve. */
export function serialisePresetFile(presets: readonly EqPreset[]): string {
  const user = presets
    .filter((p) => !p.builtIn)
    .map((p) => ({ name: p.id, gains: normaliseGains(p.gains) }))
  return `${JSON.stringify(user, null, 2)}\n`
}

/**
 * Built-ins first, then the user's. A user preset whose name collides with a
 * built-in REPLACES it — the file is the user's, and silently ignoring the row
 * they just wrote is the worse surprise. It stays flagged as a user preset:
 * it came from the file, it goes back to the file, and it is shown under the
 * name they gave it rather than the built-in's translated label.
 */
export function mergePresets(
  builtIn: readonly EqPreset[],
  user: readonly EqPreset[]
): EqPreset[] {
  const out = builtIn.map((p) => user.find((u) => u.id === p.id) ?? p)
  for (const u of user) if (!out.some((p) => p.id === u.id)) out.push(u)
  return out
}

export function findPreset(presets: readonly EqPreset[], id: string): EqPreset | null {
  return presets.find((p) => p.id === id) ?? null
}

/** Which preset the current curve IS, or null for a curve the user shaped by
 *  hand. Nothing stores "the selected preset": the gains are the state, so the
 *  UI cannot drift out of sync with what is actually applied. */
export function findPresetByGains(
  presets: readonly EqPreset[],
  gains: readonly number[]
): EqPreset | null {
  const want = normaliseGains(gains)
  return (
    presets.find((p) => {
      const have = normaliseGains(p.gains)
      for (let i = 0; i < BAND_COUNT; i++) if (have[i] !== want[i]) return false
      return true
    }) ?? null
  )
}

/**
 * The next preset in the list, for the keybindable cycle. A curve that matches
 * nothing starts the cycle at the first entry; a flat curve is 'flat' and
 * advances from there.
 */
export function nextPreset(
  presets: readonly EqPreset[],
  gains: readonly number[]
): EqPreset | null {
  if (presets.length === 0) return null
  const current = findPresetByGains(presets, gains)
  if (!current) return presets[0] ?? null
  const i = presets.indexOf(current)
  return presets[(i + 1) % presets.length] ?? null
}
