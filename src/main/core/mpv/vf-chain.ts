import { FilterChain, VF_ORDER, VF_REFUSERS } from './chain.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * core/vf-chain — the sole owner of mpv's `vf` property (§0.2 rule 5).
 * WAVE 0 — FROZEN.
 */
export const vfChain = new FilterChain({
  kind: 'vf',
  order: VF_ORDER,
  refusers: VF_REFUSERS,
  log: (m) => console.error(m)
})

// The chain is wired to mpv by core/registry, which is the only thing
// holding the bus. Nothing here reaches mpv on its own.

export function createVfService(ownerId: string): FilterChainService {
  return {
    set: (label, spec) => vfChain.set(ownerId, label, spec),
    remove: (label) => vfChain.remove(ownerId, label),
    toggle: (label, enabled) => vfChain.toggle(ownerId, label, enabled),
    command: (label, option, value, filter) =>
      vfChain.command(ownerId, label, option, value, filter),
    get hasCpuFilter(): boolean {
      return vfChain.hasCpuFilter
    }
  }
}
