import { createStore } from '../settings/store.ts'
import { filePath } from '../paths.ts'
import { loadConfig, saveConfig } from '../../services/config.ts'
import { CommandRegistry, type KeybindFile } from './registry.ts'
import { t } from '../i18n/index.ts'
import { labelForAccel } from '@shared/input/accel'
import type { PresetName, Accel } from '@shared/feature-api'
import type { ResolvedKeybinds } from '@shared/types'

/**
 * core/input wiring: the keybind store and the command registry singleton.
 *
 * `keybinds.json` holds ONLY user overrides (P18). The preset itself is derived
 * from the commands, so a fresh install has an empty bindings object and still
 * has a complete keymap.
 *
 * The preset choice lives in `config.json`, where the settings window already
 * reads it; the overrides live in their own file so importing someone else's
 * keymap (P42) does not drag their volume and window position along with it.
 */

const KEYBINDS_SCHEMA = 1

const keybindStore = createStore<KeybindFile>({
  id: 'keybinds',
  file: filePath('keybinds.json'),
  version: KEYBINDS_SCHEMA,
  defaults: { preset: 'default', bindings: {} }
})

export const commandRegistry = new CommandRegistry({
  read(): KeybindFile {
    const file = keybindStore.read()
    return { ...file, preset: loadConfig().keybindPreset }
  },
  write(patch): void {
    if (patch.preset) saveConfig({ keybindPreset: patch.preset })
    const rest: Partial<KeybindFile> = { ...patch }
    delete rest.preset
    if (Object.keys(rest).length > 0) keybindStore.write(rest)
  }
})

export function flushKeybinds(): void {
  keybindStore.flush()
}

/**
 * accel → { commandId, label, accelLabel }, which is everything the overlay
 * needs to dispatch a key and to draw the cheat sheet.
 */
export function resolvedKeybinds(): ResolvedKeybinds {
  const out: ResolvedKeybinds = {}
  for (const [accel, commandId] of Object.entries(commandRegistry.resolve('player'))) {
    const cmd = commandRegistry.get(commandId)
    if (!cmd || cmd.internal) continue
    out[accel] = {
      commandId,
      label: t(cmd.labelKey),
      accelLabel: labelForAccel(accel)
    }
  }
  return out
}

export function setPreset(preset: PresetName): void {
  commandRegistry.setPreset(preset)
}

export function setBinding(commandId: string, accels: readonly Accel[]): void {
  commandRegistry.setBinding(commandId, accels)
}
