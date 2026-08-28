import { ContributionError } from '../errors.ts'
import type { FilterChainService } from '@shared/feature-api'

/**
 * core/mpv/chain — the shared implementation behind vf-chain and af-chain
 * (§5.5). WAVE 0 — FROZEN.
 *
 * These are the highest-risk shared components after the bus: a bug here
 * silently corrupts nine modules' work. Four invariants:
 *
 *  - ONE OWNER PER PROPERTY. Only this file writes mpv's `vf` / `af`. No
 *    feature module ever issues a raw `vf`/`af` command; the ownership map
 *    refuses it (§0.2 rule 5).
 *  - ORDERING IS ENFORCED, NOT ADVISORY. Slots are emitted in the documented
 *    policy order regardless of the order modules happened to register them.
 *  - CHANGES BEFORE `file-loaded` ARE QUEUED. mpv cannot validate a filter
 *    before the first frame is decoded and may leave a broken chain.
 *  - `command()` EMITS THE FOUR-ARGUMENT FORM. `[<x>f-command, label, option,
 *    value, lavfiFilterName]` — the last argument is the libavfilter FILTER
 *    NAME, not the label and not 'all'. The three-argument form fails with
 *    "error running command" on BOTH sides; that was measured, twice.
 *
 * A module passes the filter spec WITHOUT its label:
 *   ctx.vf.set('rl-sharpen', 'lavfi=[cas=strength=0.4]')
 * and the chain emits `@rl-sharpen:lavfi=[cas=strength=0.4]`.
 */

export interface ChainExec {
  command(args: unknown[]): Promise<unknown>
}

export interface ChainConfig {
  kind: 'vf' | 'af'
  /** Reserved labels in policy order. Unregistered labels throw. */
  order: readonly string[]
  /** lavfi filters measured to REFUSE `<x>f-command`; they rebuild instead. */
  refusers: readonly string[]
  log?: (msg: string) => void
}

interface Slot {
  label: string
  owner: string
  spec: string
  enabled: boolean
}

/**
 * EVERY FIELD IS `#`-PRIVATE, and the class is not exported.
 *
 * `private` in TypeScript is a compile-time fiction: it erases to an ordinary
 * enumerable own property. `vf-chain.ts` exported the `vfChain` SINGLETON, so
 * from any feature module
 *
 *     Object.keys(vfChain)                      // ['slots','claims','ready',…,'exec']
 *     vfChain.exec.command(['vf','set','hflip'])// a raw filter-chain write
 *     vfChain.claim('attacker-module', ['rl-lut'])
 *
 * both landed — the second bypassing §0.2 rule 5 entirely, the third stealing a
 * Wave-1 reserved label before its owner exists. `capability.test.ts` asserted
 * `!/chainExec/` on the source, which was cosmetic twice over: the field is
 * called `exec`, and grepping a name proves nothing about the runtime object.
 *
 * So: `#` fields (unreachable at runtime, not merely untyped), no exported
 * instance, and `createChain()` hands back an admin object that closes over the
 * chain and exposes four methods. There is nothing to reach into.
 */
class FilterChain {
  readonly #slots = new Map<string, Slot>()
  readonly #claims = new Map<string, string>()
  #ready = false
  #pending = false
  #applying: Promise<void> | null = null

  /**
   * The raw `vf`/`af` exec, handed over by `core/mpv/bus` at boot.
   *
   * It is NOT a constructor argument any more, and that is the point: the exec
   * used to be `(args) => mpvBus.chainExec(args)` written at module scope,
   * which required `chainExec` to be a public method on an exported singleton —
   * and a public `chainExec` is a public filter-chain write. Now the bus hands
   * each chain a closure, and nothing else can reach one.
   */
  #exec: ChainExec | null = null

  readonly #cfg: ChainConfig

  constructor(cfg: ChainConfig) {
    this.#cfg = cfg
  }

  attachExec(exec: ChainExec): void {
    this.#exec = exec
  }

  #command(args: unknown[]): Promise<unknown> {
    if (!this.#exec) {
      throw new ContributionError(
        `${this.#cfg.kind}-chain was used before core/registry attached its mpv exec.`
      )
    }
    return this.#exec.command(args)
  }

  /** Boot-time label claim. Two modules claiming one label is a boot error. */
  claim(ownerId: string, labels: readonly string[]): void {
    for (const label of labels) {
      if (!this.#cfg.order.includes(label)) {
        throw new ContributionError(
          `module '${ownerId}' claims ${this.#cfg.kind} label '${label}', which is not in the ` +
            `reserved label table (§5.5). Reserved ${this.#cfg.kind} labels: ${this.#cfg.order.join(', ')}.`
        )
      }
      const existing = this.#claims.get(label)
      if (existing && existing !== ownerId) {
        throw new ContributionError(
          `${this.#cfg.kind} label collision on '${label}': claimed by both '${existing}' and '${ownerId}'.`
        )
      }
      this.#claims.set(label, ownerId)
    }
  }

  #assertOwned(ownerId: string, label: string): void {
    const owner = this.#claims.get(label)
    if (owner !== ownerId) {
      throw new ContributionError(
        owner
          ? `module '${ownerId}' may not touch ${this.#cfg.kind} label '${label}' (owned by '${owner}').`
          : `${this.#cfg.kind} label '${label}' is not declared by any module. Add it to ` +
              `ownsFilterLabels and to the §5.5 table.`
      )
    }
  }

  set(ownerId: string, label: string, spec: string): void {
    this.#assertOwned(ownerId, label)
    const prev = this.#slots.get(label)
    this.#slots.set(label, { label, owner: ownerId, spec, enabled: prev?.enabled ?? true })
    this.#schedule()
  }

  remove(ownerId: string, label: string): void {
    this.#assertOwned(ownerId, label)
    if (this.#slots.delete(label)) this.#schedule()
  }

  /** Disable in place, so the module's settings survive a toggle (A25). */
  toggle(ownerId: string, label: string, enabled: boolean): void {
    this.#assertOwned(ownerId, label)
    const slot = this.#slots.get(label)
    if (!slot || slot.enabled === enabled) return
    slot.enabled = enabled
    this.#schedule()
  }

  has(label: string): boolean {
    return this.#slots.has(label)
  }

  /**
   * Live parameter update. Returns which path it took so the caller can choose
   * between a live slider and commit-on-release without hardcoding the refuser
   * table itself — that table lives here, once, not in nine modules.
   */
  async command(
    ownerId: string,
    label: string,
    option: string,
    value: string,
    lavfiFilterName: string,
    spec?: string
  ): Promise<{ path: 'command' | 'rebuild' }> {
    this.#assertOwned(ownerId, label)
    const slot = this.#slots.get(label)
    if (!slot) {
      throw new ContributionError(
        `${this.#cfg.kind}.command() on '${label}', which has no slot. Call set() first.`
      )
    }
    /**
     * THE SLOT IS UPDATED BEFORE EITHER PATH RUNS, and both halves of that
     * mattered in practice.
     *
     * Without it the rebuild path re-serialised `slot.spec` -- the value from
     * BEFORE this call -- so for the four measured refusers (`unsharp`, and af's
     * `pan`/`loudnorm`/`superequalizer`) `command()` was documented as
     * "transparently rebuilds for those" and was in fact a no-op. `unsharp` is
     * V08, the one row the vf-chain pilot exists for.
     *
     * And on the success path mpv held the new value while the slot held the
     * old one, so the next whole-chain `#apply()` -- triggered by any other
     * module's `set()`/`toggle()`, an mpv respawn, or the next file -- reverted
     * it. Two mirror-image bugs, one missing line.
     *
     * No `#schedule()` here: the rebuild path applies below, and the command
     * path does not need one. That is what keeps a per-pixel slider from
     * emitting a whole-chain `set` per event.
     */
    if (spec !== undefined) slot.spec = spec
    if (this.#cfg.refusers.includes(lavfiFilterName)) {
      await this.#apply()
      return { path: 'rebuild' }
    }
    try {
      await this.#command([
        `${this.#cfg.kind}-command`,
        label,
        option,
        value,
        lavfiFilterName
      ])
      return { path: 'command' }
    } catch (e) {
      // A filter that turns out not to implement process_command must not take
      // the slider down with it; fall back to the rebuild that always works.
      this.#cfg.log?.(
        `[${this.#cfg.kind}-chain] ${lavfiFilterName} refused ${this.#cfg.kind}-command ` +
          `(${(e as Error).message}); rebuilding the chain instead`
      )
      await this.#apply()
      return { path: 'rebuild' }
    }
  }

  /** Every lavfi filter forces hwdec frames back to system memory. */
  get hasCpuFilter(): boolean {
    for (const s of this.#slots.values()) {
      if (s.enabled && s.spec.includes('lavfi=')) return true
    }
    return false
  }

  /** The exact string handed to mpv, in policy order. */
  serialise(): string {
    const out: string[] = []
    for (const label of this.#cfg.order) {
      const slot = this.#slots.get(label)
      if (!slot) continue
      out.push(`@${label}:${slot.enabled ? '' : '!'}${slot.spec}`)
    }
    return out.join(',')
  }

  /** Called by the bus on `file-loaded`. Flushes anything queued. */
  onFileLoaded(): void {
    this.#ready = true
    if (this.#pending) void this.#apply()
  }

  /** Called by the bus when the file goes away or mpv respawns. */
  onUnload(): void {
    this.#ready = false
  }

  #schedule(): void {
    if (!this.#ready) {
      this.#pending = true
      return
    }
    void this.#apply()
  }

  /** One `<x>f set` with the whole chain: deterministic, order-correct, and
   *  it cannot leave a half-applied graph the way add/remove pairs can. */
  #apply(): Promise<void> {
    this.#pending = false
    const run = async (): Promise<void> => {
      const chain = this.serialise()
      try {
        await this.#command([this.#cfg.kind, 'set', chain])
      } catch (e) {
        this.#cfg.log?.(
          `[${this.#cfg.kind}-chain] failed to apply "${chain}": ${(e as Error).message}`
        )
      }
    }
    // Serialise applies: two overlapping `set`s can land out of order.
    this.#applying = (this.#applying ?? Promise.resolve()).then(run, run)
    return this.#applying
  }
}

/**
 * The ONLY surface anything outside this file ever holds.
 *
 * `createChain()` builds the FilterChain and returns this: four methods, closed
 * over an instance that is never handed out. `core/registry` holds one per kind
 * and calls `claim()` at boot and `serviceFor()` per module; `core/mpv/bus`
 * calls `attachExec()` and the two lifecycle hooks. Nothing else can obtain one,
 * because `vf-chain.ts` and `af-chain.ts` create theirs exactly once.
 */
export interface ChainAdmin {
  /** Boot-time reserved-label claim (§5.5). Two owners for one label throws. */
  claim(ownerId: string, labels: readonly string[]): void
  /** The per-module facade handed to `ctx.vf` / `ctx.af`. */
  serviceFor(ownerId: string): FilterChainService
  /** Wired once by the bus, which owns the raw `vf`/`af` exec. */
  attachExec(exec: ChainExec): void
  onFileLoaded(): void
  onUnload(): void
  /** READS. The exact string handed to mpv, and whether any lavfi pass is live
   *  (→ hwdec frames come back to system memory). Reads are never owned. */
  serialise(): string
  readonly hasCpuFilter: boolean
}

/**
 * Build a chain and return only its admin surface.
 *
 * The instance is a local. There is no property on the returned object that
 * reaches it, no `exec`, no `slots`, no `claims` — which is the difference
 * between this and the exported singleton it replaces, where `Object.keys()`
 * listed all three.
 */
export function createChain(cfg: ChainConfig): ChainAdmin {
  const chain = new FilterChain(cfg)
  return {
    claim: (ownerId, labels) => chain.claim(ownerId, labels),
    attachExec: (exec) => chain.attachExec(exec),
    onFileLoaded: () => chain.onFileLoaded(),
    onUnload: () => chain.onUnload(),
    serialise: () => chain.serialise(),
    get hasCpuFilter(): boolean {
      return chain.hasCpuFilter
    },
    serviceFor(ownerId: string): FilterChainService {
      return {
        set: (label, spec) => chain.set(ownerId, label, spec),
        remove: (label) => chain.remove(ownerId, label),
        toggle: (label, enabled) => chain.toggle(ownerId, label, enabled),
        command: (label, option, value, filter, spec) =>
          chain.command(ownerId, label, option, value, filter, spec),
        get hasCpuFilter(): boolean {
          return chain.hasCpuFilter
        }
      }
    }
  }
}

// --- §5.5 reserved labels and ordering policies ----------------------------

/** vf: deint → dv → 3d/360 → denoise/deblock → sharpen/soften → mblur → vsr
 *  → lut → rotate → hflip/vflip. Colour ops sit with denoise, before sharpen. */
export const VF_ORDER: readonly string[] = [
  /**
   * `rl-idet` FIRST, ahead of the deinterlacer it informs.
   *
   * It was missing entirely, and `claim()` throws on a label that is not in
   * this table -- so M04, which spec §2 V21 requires to install `@rl-idet:
   * lavfi=[idet]` for interlace detection, would have failed to BOOT on the
   * first line of its own feature, with an error naming the reserved table it
   * was correctly following. Nothing caught it because nothing compared the
   * manifest's reserved labels against this list; ownership.test.ts does now.
   */
  'rl-idet',
  'rl-deint',
  'rl-dv',
  'rl-3d',
  'rl-360',
  'rl-cropdetect',
  'rl-denoise',
  'rl-tdenoise',
  'rl-gdenoise',
  'rl-deblock',
  'rl-levels',
  'rl-autolevel',
  'rl-cshift',
  'rl-sharpen',
  'rl-soften',
  'rl-mblur',
  'rl-mi',
  'rl-vsr',
  'rl-truehdr',
  'rl-lut',
  'rl-rotate',
  'rl-hflip',
  'rl-vflip'
]

/** af: rlch → rleq/rlpre/rltone/rlfeq → rlfx/rlcry/rlnr → rldlg →
 *  rlnorm/rlnight → rltempo → rlac3 → rlboost. Boost and limiter LAST, always
 *  (A06/A26) — a limiter anywhere but the end is not a limiter. */
export const AF_ORDER: readonly string[] = [
  'rlch',
  'rleq',
  'rlpre',
  'rltone',
  'rlfeq',
  'rlfx',
  'rlcry',
  'rlnr',
  'rldlg',
  'rlnorm',
  'rlnight',
  'rltempo',
  'rlac3',
  'rlboost'
]

/** Measured against the pinned build. `unsharp` is the only vf refuser. */
export const VF_REFUSERS: readonly string[] = ['unsharp']
export const AF_REFUSERS: readonly string[] = ['superequalizer', 'pan', 'loudnorm']
