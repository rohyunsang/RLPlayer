import type { FeatureModule } from '@shared/feature-api'

/**
 * Module discovery. WAVE 0 — written once, never edited again.
 *
 * Adding `src/main/features/<name>/index.ts` is the ONLY step needed to ship a
 * module. There is no central list to append to, which is the entire point:
 * a list would be the fortieth merge conflict.
 *
 * electron-vite compiles the main bundle with Vite, so `import.meta.glob` is
 * available here. If it ever stops being, the fallback is
 * `scripts/gen-feature-manifest.mjs` in `prebuild`, emitting a gitignored file
 * of the same shape — either way, no implementer edits a shared list.
 */
const mods = import.meta.glob<{ default: FeatureModule }>('./*/index.ts', { eager: true })

export interface Discovered {
  dir: string
  module: FeatureModule
}

export function collectFeatureModules(): Discovered[] {
  const out: Discovered[] = []
  for (const [file, mod] of Object.entries(mods)) {
    const dir = file.split('/')[1] ?? ''
    const module = mod?.default
    if (!module) {
      console.error(`[features] ${file} has no default export; skipping`)
      continue
    }
    out.push({ dir, module })
  }
  // Stable order so a boot error message is reproducible.
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}
