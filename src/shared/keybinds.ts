import type { PresetName } from './feature-api'

/**
 * WAVE 0: the three hand-written preset tables that used to live here are gone.
 *
 * Presets are DERIVED by folding every registered command's own
 * `defaults: { default, potplayer, mpv }` (§5.4), so a module that adds a
 * command adds its bindings to all three presets without anyone editing a
 * shared file. `src/main/core/input/registry.ts` does the folding.
 *
 * `eventToAccel` is gone too: it keyed off `e.key`, which is `'Process'` for
 * every letter while the Korean IME is composing (P16). Use `accelFromEvent`
 * from `@shared/input/accel`, which keys off `e.code`.
 */
export type KeybindPreset = PresetName

export const PRESET_LABELS: Record<KeybindPreset, string> = {
  default: 'RLPlayer 기본',
  potplayer: 'PotPlayer 호환',
  mpv: 'mpv 호환'
}

export { accelFromEvent, labelForAccel, normalizeAccel } from './input/accel'
