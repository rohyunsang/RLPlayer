/**
 * The v0.1.1 `config.json` seam — and the reason it is a seam instead of an
 * ordinary import.
 *
 * Seven of the nine implemented main-side modules do this:
 *
 *     import { loadConfig, saveConfig } from '../../services/config.ts'
 *
 * It passes `check:forbidden` (that file is not on the core-path list) and it
 * is what M19's Wave-0 seed did. It also makes the module UNLOADABLE by any
 * test, which is not a style opinion but a measured fact:
 *
 *     $ node --import ./scripts/lib/ts-resolve-register.mjs --test \
 *         src/main/features/subs-style/zz-probe.test.ts    # body: import('./index.ts')
 *     src/main/mpv/manager.ts:5
 *     import { app } from 'electron'
 *              ^^^
 *     SyntaxError: The requested module 'electron' does not provide an export
 *                  named 'app'
 *
 * `services/config.ts` -> `core/paths.ts` -> `mpv/manager.ts` -> `electron`, so
 * one import for two legacy fields costs the module every wiring test it could
 * otherwise have — the exact class of defect §13 describes when it says a third
 * of `src/main` was untestable by construction. `FeatureContext` exposes no
 * legacy-config accessor, so this is the only sanctioned route to those fields.
 *
 * Keeping the import DYNAMIC and behind try/catch confines the Electron edge to
 * this file: `index.ts` stays importable, and a context that has no Electron
 * (a test) simply gets no legacy values, which is also what a fresh install
 * gets. Reported as an API gap rather than worked around silently.
 */

export interface LegacySubtitleStyle {
  subScale?: number
  subAssOverride?: boolean
}

interface ConfigModule {
  loadConfig(): Record<string, unknown>
  saveConfig(patch: Record<string, unknown>): void
}

let cached: ConfigModule | null = null
let tried = false

async function configModule(): Promise<ConfigModule | null> {
  if (tried) return cached
  tried = true
  try {
    const m = (await import('../../services/config.ts')) as unknown as ConfigModule
    cached = typeof m?.loadConfig === 'function' ? m : null
  } catch {
    cached = null
  }
  return cached
}

/** The two v0.1.1 fields this module owned, or `{}` where there is no store. */
export async function readLegacyStyle(): Promise<LegacySubtitleStyle> {
  const m = await configModule()
  if (!m) return {}
  try {
    const cfg = m.loadConfig()
    const out: LegacySubtitleStyle = {}
    if (typeof cfg['subScale'] === 'number') out.subScale = cfg['subScale']
    if (typeof cfg['subAssOverride'] === 'boolean') {
      out.subAssOverride = cfg['subAssOverride']
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Mirror back, so `applyConfigChanges()` in the legacy bridge does not see a
 * difference it then replays through our own commands. Best-effort by design:
 * the descriptor store is the real home of these values now.
 */
export async function mirrorLegacyStyle(patch: LegacySubtitleStyle): Promise<void> {
  const m = await configModule()
  if (!m) return
  try {
    m.saveConfig(patch as unknown as Record<string, unknown>)
  } catch {
    // A read-only profile (P09) is a supported state, not an error to shout about.
  }
}
