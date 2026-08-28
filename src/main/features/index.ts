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
/**
 * NOT `{ eager: true }`, and the difference is a security boundary rather than a
 * startup-time micro-optimisation.
 *
 * With eager glob, every feature module's TOP-LEVEL code ran during the import
 * of this file — which happens while `src/main/index.ts` is still being
 * evaluated, before `main()` and therefore before core has finished wiring
 * itself. A module could run arbitrary code at that moment and race core for
 * anything that is claimed once. Lazily, each module body runs inside
 * `collectFeatureModules()`, which is awaited from `main()` after the bus has
 * been created and after `applySessionPolicy()` — so "core is fully wired
 * before any module code runs" is guaranteed by the loader, not by import
 * order in a file someone may reorder.
 */
const mods = import.meta.glob<{ default: FeatureModule }>('./*/index.ts', {
  eager: false
})

export interface Discovered {
  dir: string
  module: FeatureModule
}

export async function collectFeatureModules(): Promise<Discovered[]> {
  const out: Discovered[] = []
  // Sorted first, so a boot error message is reproducible AND so modules are
  // evaluated in a deterministic order.
  for (const file of Object.keys(mods).sort()) {
    const dir = file.split('/')[1] ?? ''
    let module: FeatureModule | undefined
    try {
      module = (await mods[file]?.())?.default
    } catch (e) {
      // One module that cannot even be imported must not stop the app: §3.5
      // rule 7's runtime-failure half starts here, not at setup().
      console.error(`[features] ${file} failed to load:`, (e as Error).message)
      continue
    }
    if (!module) {
      console.error(`[features] ${file} has no default export; skipping`)
      continue
    }
    out.push({ dir, module })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}
