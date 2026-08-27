import { createStore, type Store } from '../core/settings/store.ts'
import { dataDir, filePath, isPortable, portableFallback } from '../core/paths.ts'
import type { AppConfig } from '@shared/types'

/**
 * The core `config.json` surface.
 *
 * WAVE 0: this is now a thin shell over `core/settings/store`, which is where
 * the atomic+fsync write (P11), unknown-key preservation (P10), the
 * downgrade guard (P09) and corrupt-file quarantine (P12) actually live. The
 * v0.1 `loadConfig`/`saveConfig` signatures are unchanged, because the settings
 * window and `windows.ts` are built on them.
 *
 * `settings` is the descriptor registry's value bag: one
 * `Record<SettingId, unknown>` holding only values that DIFFER from a
 * descriptor's default (P51), which is what makes changing a default later
 * still reach users who never touched it.
 */

export const CONFIG_SCHEMA = 1

export const DEFAULT_CONFIG: AppConfig = {
  volume: 100,
  muted: false,
  speed: 1,
  alwaysOnTop: false,
  alwaysOnTopMode: 'never',
  resumePlayback: true,
  autoLoadSubs: true,
  playlistPanelOpen: false,
  repeat: 'off',
  shuffle: false,
  subScale: 1,
  subAssOverride: false,
  volumeBoostLimiter: true,
  screenshotDir: '',
  audioDevice: 'auto',
  hwdec: 'auto-safe',
  vo: 'gpu-next',
  layoutMode: 'overlay',
  window: { width: 1100, height: 660, maximized: false },
  fullscreenDisplay: null,
  keybindPreset: 'default',
  // Empty by default: the preset supplies the bindings, and anything the user
  // puts here layers on top of it.
  keybinds: {},
  osd: {},
  settings: {}
}

let store: Store<AppConfig> | null = null
let notify: ((kind: 'corrupt' | 'write' | 'readonly', detail: string) => void) | null = null

/** index.ts installs this once the UI exists, so P12's toast has somewhere to go. */
export function onConfigProblem(
  cb: (kind: 'corrupt' | 'write' | 'readonly', detail: string) => void
): void {
  notify = cb
}

function get(): Store<AppConfig> {
  if (store) return store
  store = createStore<AppConfig>({
    id: 'config',
    file: filePath('config.json'),
    version: CONFIG_SCHEMA,
    defaults: DEFAULT_CONFIG,
    onError: (kind, detail) => notify?.(kind, detail)
  })
  return store
}

export function loadConfig(): AppConfig {
  return get().read()
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  get().write(patch)
  return get().read()
}

export function flushConfig(): void {
  get().flush()
}

export function configReadOnly(): boolean {
  return get().readOnly
}

export function configRecovered(): boolean {
  return get().recovered
}

export function configFilePath(): string {
  return filePath('config.json')
}

/** The value backing the settings descriptor registry writes through. */
export const settingsBacking = {
  read(): Record<string, unknown> {
    return loadConfig().settings ?? {}
  },
  write(values: Record<string, unknown>): void {
    get().write({ settings: values } as Partial<AppConfig>)
  }
}

export { dataDir, isPortable, portableFallback }
