import { createChain, AF_ORDER, AF_REFUSERS, type ChainAdmin } from './chain.ts'
import { ContributionError } from '../errors.ts'

/**
 * core/af-chain — the sole owner of mpv's `af` property (§0.2 rule 5).
 * WAVE 0 — FROZEN.
 *
 * THERE IS NO `afChain` EXPORT ANY MORE, for the same reason there is no
 * `mpvBus` export. It used to be `export const afChain = new FilterChain(…)`,
 * and TypeScript's `private` erases to an ordinary enumerable property, so from
 * a feature module:
 *
 *     const { afChain } = await import('../../core/mpv/af-chain.ts')
 *     Object.keys(afChain)                        // … 'exec' is right there
 *     afChain.exec.command(['af', 'set', 'anull'])// raw chain write, LANDED
 *     afChain.claim('attacker-module', ['rlboost'])// stole a reserved label, LANDED
 *
 * `createAfChain()` builds it exactly once and returns an admin object with four
 * methods and no path back to the instance; a second call throws, so
 * `await import(…)` from a module now yields a factory that refuses.
 */

let created = false

export function createAfChain(): ChainAdmin {
  if (created) {
    throw new ContributionError(
      'core/af-chain is created once, at boot, by core/registry. A module never touches the ' +
        'filter chain directly: declare `usesAudioFilters` and use ctx.af, whose label ' +
        'ownership is checked on every call. See docs/parity/02-wave0-api.md.'
    )
  }
  created = true
  return createChain({
    kind: 'af',
    order: AF_ORDER,
    refusers: AF_REFUSERS,
    log: (m) => console.error(m)
  })
}

/**
 * Note for anyone reading `af` back and finding a filter they did not add: mpv
 * auto-inserts `scaletempo2` at speed != 1 and it stays invisible in the `af`
 * list, so `af set` cannot delete it. That is correct behaviour, not a chain bug.
 */
