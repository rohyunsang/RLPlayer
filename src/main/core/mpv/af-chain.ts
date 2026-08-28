import { FilterChain, AF_ORDER, AF_REFUSERS } from './chain.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * core/af-chain — the sole owner of mpv's `af` property (§0.2 rule 5).
 * WAVE 0 — FROZEN.
 *
 * Note for anyone reading `af` back and finding a filter they did not add:
 * mpv auto-inserts `scaletempo2` at speed != 1 and it stays invisible in the
 * `af` list, so `af set` cannot delete it. That is correct behaviour, not a
 * chain bug.
 */
export const afChain = new FilterChain({
  kind: 'af',
  order: AF_ORDER,
  refusers: AF_REFUSERS,
  log: (m) => console.error(m)
})

// The chain is wired to mpv by core/registry, which is the only thing
// holding the bus. Nothing here reaches mpv on its own.

export function createAfService(ownerId: string): FilterChainService {
  return {
    set: (label, spec) => afChain.set(ownerId, label, spec),
    remove: (label) => afChain.remove(ownerId, label),
    toggle: (label, enabled) => afChain.toggle(ownerId, label, enabled),
    command: (label, option, value, filter) =>
      afChain.command(ownerId, label, option, value, filter),
    get hasCpuFilter(): boolean {
      return afChain.hasCpuFilter
    }
  }
}
