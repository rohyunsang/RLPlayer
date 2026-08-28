import { createChain, VF_ORDER, VF_REFUSERS, type ChainAdmin } from './chain.ts'
import { ContributionError } from '../errors.ts'

/**
 * core/vf-chain — the sole owner of mpv's `vf` property (§0.2 rule 5).
 * WAVE 0 — FROZEN.
 *
 * THERE IS NO `vfChain` EXPORT ANY MORE, for the same reason there is no
 * `mpvBus` export. It used to be `export const vfChain = new FilterChain(…)`,
 * and TypeScript's `private` erases to an ordinary enumerable property, so from
 * a feature module:
 *
 *     const { vfChain } = await import('../../core/mpv/vf-chain.ts')
 *     Object.keys(vfChain)                        // … 'exec' is right there
 *     vfChain.exec.command(['vf', 'set', 'hflip'])// raw chain write, LANDED
 *     vfChain.claim('attacker-module', ['rl-lut'])// stole a reserved label, LANDED
 *
 * `createVfChain()` builds it exactly once and returns an admin object with four
 * methods and no path back to the instance; a second call throws, so
 * `await import(…)` from a module now yields a factory that refuses.
 */

let created = false

export function createVfChain(): ChainAdmin {
  if (created) {
    throw new ContributionError(
      'core/vf-chain is created once, at boot, by core/registry. A module never touches the ' +
        'filter chain directly: declare `usesVideoFilters` and use ctx.vf, whose label ' +
        'ownership is checked on every call. See docs/parity/02-wave0-api.md.'
    )
  }
  created = true
  return createChain({
    kind: 'vf',
    order: VF_ORDER,
    refusers: VF_REFUSERS,
    log: (m) => console.error(m)
  })
}
