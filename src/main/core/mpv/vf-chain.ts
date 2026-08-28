import { FilterChain, VF_ORDER, VF_REFUSERS } from './chain.ts'
import { mpvBus } from './bus.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * core/vf-chain — the sole owner of mpv's `vf` property (§0.2 rule 5).
 * WAVE 0 — FROZEN.
 */
export const vfChain = new FilterChain({
  kind: 'vf',
  order: VF_ORDER,
  refusers: VF_REFUSERS,
  exec: { command: (args) => mpvBus.chainExec(args) },
  log: (m) => console.error(m)
})

mpvBus.registerChain(vfChain)

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
