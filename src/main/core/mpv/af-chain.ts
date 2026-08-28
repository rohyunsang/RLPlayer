import { FilterChain, AF_ORDER, AF_REFUSERS } from './chain.ts'
import { mpvBus } from './bus.ts'
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
  exec: { command: (args) => mpvBus.chainExec(args) },
  log: (m) => console.error(m)
})

mpvBus.registerChain(afChain)

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
