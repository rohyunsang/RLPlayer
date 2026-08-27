import { ContributionError } from './errors.ts'

/**
 * The pure half of core/registry: id validation and dependency ordering.
 * Split out from registry.ts so `test:registry` can exercise every boot-time
 * failure without an Electron app object anywhere near it.
 */

export interface DiscoveredModule {
  /** Directory name the module was found in. */
  dir: string
  id: string
  dependsOn?: readonly string[]
}

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function validateIds(mods: readonly DiscoveredModule[]): void {
  const seen = new Map<string, string>()
  for (const m of mods) {
    if (!ID_RE.test(m.id)) {
      throw new ContributionError(
        `module in 'features/${m.dir}/' has id '${m.id}', which is not kebab-case.`
      )
    }
    if (m.id !== m.dir) {
      // Both names, always: "id must equal the directory" is not actionable
      // without knowing which two strings disagree.
      throw new ContributionError(
        `module id '${m.id}' does not match its directory 'features/${m.dir}/'. ` +
          `Rename one so they agree — the registry, modules.json and every namespace ` +
          `check key off this id.`
      )
    }
    const dup = seen.get(m.id)
    if (dup) {
      throw new ContributionError(`duplicate module id '${m.id}' in '${dup}' and '${m.dir}'.`)
    }
    seen.set(m.id, m.dir)
  }
}

/** Topological order. A cycle throws and NAMES the cycle. */
export function topoSort<T extends DiscoveredModule>(mods: readonly T[]): T[] {
  const byId = new Map(mods.map((m) => [m.id, m]))
  const state = new Map<string, 'visiting' | 'done'>()
  const out: T[] = []

  const visit = (m: T, trail: string[]): void => {
    const s = state.get(m.id)
    if (s === 'done') return
    if (s === 'visiting') {
      const at = trail.indexOf(m.id)
      const cycle = [...trail.slice(at === -1 ? 0 : at), m.id].join(' → ')
      throw new ContributionError(`dependency cycle between feature modules: ${cycle}`)
    }
    state.set(m.id, 'visiting')
    for (const dep of m.dependsOn ?? []) {
      const target = byId.get(dep)
      if (!target) {
        throw new ContributionError(
          `module '${m.id}' dependsOn '${dep}', which is not a loaded feature module.`
        )
      }
      visit(target, [...trail, m.id])
    }
    state.set(m.id, 'done')
    out.push(m)
  }

  for (const m of mods) visit(m, [])
  return out
}
