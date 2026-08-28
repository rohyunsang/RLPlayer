import type { RendererFeatureModule } from '../../../shared/renderer-api.ts'
import { SeekbarHost } from './seekbar-host.ts'
import {
  createContext,
  loadModules,
  setSeekbarHost,
  type DiscoveredRendererModule,
  type Surface
} from './feature-host.ts'

/**
 * The renderer-side core host (§5.8).
 *
 * Same discovery rule as the main process: a renderer half is a directory under
 * `src/renderer/src/features/<same-id>/`, found by a glob, and there is no list
 * to edit. A module with no UI simply has no renderer half.
 *
 * The registry, the context and the loader live in `feature-host.ts` so they can
 * be unit-tested without Vite; this file is the glob, the bridge and the
 * re-exports. The DOM consumers for the four contribution points are
 * `panel-host.ts`, `stats-host.ts` and `settings-form.ts`.
 */

const mods = import.meta.glob<{ default: RendererFeatureModule }>('../features/*/index.ts', {
  eager: true
})

export function attachSeekbar(host: SeekbarHost): SeekbarHost {
  setSeekbarHost(host)
  return host
}

/**
 * Set up every renderer half, once. Idempotent: see the note on `loadModules`.
 * `surface` tells a module which window it is in — the overlay and the settings
 * window run the same glob.
 */
export function loadRendererFeatures(surface: Surface = 'player'): RendererFeatureModule[] {
  const discovered: DiscoveredRendererModule[] = Object.entries(mods).map(([file, mod]) => ({
    file,
    module: mod?.default
  }))
  return loadModules(discovered, (id) => createContext(id, window.rl, surface))
}

export {
  fetchMessages,
  getSeekbarHost as getSeekbar,
  onContributionsChanged,
  panels,
  publishState,
  registerRendererMessages,
  setOsdSink,
  settingsComponents,
  settingsSections,
  statsSections,
  t,
  type PanelSpec,
  type SettingsComponentMount,
  type SettingsSectionSpec
} from './feature-host.ts'
export { initPanelHost } from './panel-host.ts'
export { initStatsHost, statsOnStateChange, statsVisible, toggleStats } from './stats-host.ts'
export { SeekbarHost }
