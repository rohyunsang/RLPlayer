import type { FilterChainService } from '@shared/feature-api'
import type { LiveOption } from './specs.ts'

/**
 * M03 video-enhance — the slot policy that sits between the settings and
 * `ctx.vf`.
 *
 * It exists for one measured reason. §5 says `command()` "transparently
 * rebuilds for the refusers and reports `{path: 'rebuild'}`, so you can choose
 * commit-on-release instead of a live slider without hardcoding the table" —
 * but the rebuild it performs is `vf set <serialise()>`, and `serialise()`
 * emits the spec the SLOT still holds, which is the one from before this
 * change. So for `unsharp` (V08, the only vf refuser) a caller that follows
 * that sentence literally re-applies the OLD value and the slider does nothing.
 * The same gap bites the fast path from the other side: after a successful
 * `vf-command` the slot's spec is stale, so the next whole-chain rebuild —
 * another module touching its own slot, a respawn, the next file — silently
 * reverts the value the user just set live.
 *
 * So each labelled slot keeps two strings:
 *
 *   desired  what the settings say the filter should be
 *   applied  what the chain's slot actually holds
 *
 * and the rules are: a refusal (`path: 'rebuild'`) is followed immediately by
 * `set(desired)`, and a successful live `command()` schedules one debounced
 * `set(desired)` so the chain becomes authoritative again once the drag stops.
 * The refuser table itself is still not duplicated here — `refusers` is LEARNED
 * from the path `command()` reports, so a filter that changes its mind in a
 * future mpv changes this module's behaviour without an edit.
 *
 * Disable is `toggle(label, false)`, never `remove()`: §5's disable-in-place is
 * what lets a toggle survive with its settings, and tearing the slot down would
 * also cost a full chain rebuild on the way back in.
 */

export type UpdatePath = 'noop' | 'set' | 'command' | 'rebuild'

export interface SlotSyncDeps {
  /** The three chain calls this module is allowed to make. */
  readonly vf: Pick<FilterChainService, 'set' | 'toggle' | 'command'>
  /** How long after the last live command the authoritative `set()` lands. */
  readonly syncDelayMs?: number
  /** Injectable so the tests do not sleep. */
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
  readonly log?: (msg: string) => void
}

export interface SlotSync {
  /** Ensure the slot exists, is enabled, and carries `spec`. */
  update(label: string, spec: string, live?: readonly LiveOption[]): Promise<UpdatePath>
  /** Disable in place. Keeps the spec so re-enabling is one `toggle`. */
  disable(label: string): void
  /** Apply any pending authoritative `set()` now. */
  flush(): void
  dispose(): void
  /** Introspection for the tests and the stats row: what the CHAIN holds. */
  appliedSpec(label: string): string | undefined
  pendingLabels(): readonly string[]
  /** Whether a filter was observed to refuse `vf-command`. */
  refuses(filter: string): boolean | undefined
}

interface SlotState {
  desired: string
  /** null until the slot has been handed to the chain even once. */
  applied: string | null
  enabled: boolean
  timer: unknown | null
}

const DEFAULT_SYNC_DELAY_MS = 400

export function createSlotSync(deps: SlotSyncDeps): SlotSync {
  const slots = new Map<string, SlotState>()
  const refusers = new Map<string, boolean>()
  const delay = deps.syncDelayMs ?? DEFAULT_SYNC_DELAY_MS
  const schedule =
    deps.schedule ??
    ((fn, ms): unknown => {
      const handle = setTimeout(fn, ms)
      // A 400 ms sync timer must never be the reason the process lingers.
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
  const cancel = deps.cancel ?? ((handle: unknown): void => clearTimeout(handle as never))

  const stateOf = (label: string): SlotState => {
    let s = slots.get(label)
    if (!s) {
      s = { desired: '', applied: null, enabled: false, timer: null }
      slots.set(label, s)
    }
    return s
  }

  const cancelPending = (s: SlotState): void => {
    if (s.timer === null) return
    cancel(s.timer)
    s.timer = null
  }

  /** Hand the chain the current desired spec. This is the only `vf.set()`. */
  const commit = (label: string, s: SlotState): void => {
    cancelPending(s)
    if (s.applied === s.desired) return
    deps.vf.set(label, s.desired)
    s.applied = s.desired
  }

  return {
    async update(label, spec, live): Promise<UpdatePath> {
      const s = stateOf(label)
      s.desired = spec

      // First appearance, or coming back from a disable: the slot has to hold
      // the current spec before it is switched on, or the frame between the
      // two shows the previous settings.
      if (s.applied === null || !s.enabled) {
        commit(label, s)
        if (!s.enabled) {
          deps.vf.toggle(label, true)
          s.enabled = true
        }
        return 'set'
      }

      if (s.applied === spec && s.timer === null) return 'noop'

      const known = live?.length ? live.every((o) => refusers.get(o.filter) !== true) : false
      if (!known) {
        commit(label, s)
        return 'set'
      }

      for (const o of live ?? []) {
        const { path } = await deps.vf.command(label, o.option, o.value, o.filter)
        if (path === 'rebuild') {
          // The chain has just re-applied its own stored spec, which is the one
          // from BEFORE this change. Nothing about that rebuild carried the new
          // value, so the slot has to be re-set with it, and this filter is
          // taken off the live path for the rest of the session.
          refusers.set(o.filter, true)
          deps.log?.(
            `[video-enhance] ${o.filter} refuses vf-command; ` +
              `rebuilding @${label} with the new spec (V08)`
          )
          s.applied = null // force the set(): the chain's rebuild used the old spec
          commit(label, s)
          return 'rebuild'
        }
        refusers.set(o.filter, false)
      }

      // The value is live in mpv but the chain's slot still holds the previous
      // spec. One debounced set() makes the chain authoritative again, which is
      // exactly one rebuild per drag instead of one per tick.
      cancelPending(s)
      s.timer = schedule(() => {
        s.timer = null
        if (s.applied !== s.desired) {
          deps.vf.set(label, s.desired)
          s.applied = s.desired
        }
      }, delay)
      return 'command'
    },

    disable(label): void {
      const s = slots.get(label)
      if (!s || s.applied === null || !s.enabled) return
      cancelPending(s)
      // Disable IN PLACE (@label:!spec). remove() would drop the settings and
      // make the way back in a full rebuild.
      deps.vf.toggle(label, false)
      s.enabled = false
    },

    flush(): void {
      for (const [label, s] of slots) if (s.timer !== null) commit(label, s)
    },

    dispose(): void {
      for (const s of slots.values()) cancelPending(s)
      slots.clear()
    },

    appliedSpec(label): string | undefined {
      return slots.get(label)?.applied ?? undefined
    },

    pendingLabels(): readonly string[] {
      return [...slots].filter(([, s]) => s.timer !== null).map(([label]) => label)
    },

    refuses(filter): boolean | undefined {
      return refusers.get(filter)
    }
  }
}
