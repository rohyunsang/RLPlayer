import { ContributionError } from '../errors.ts'

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
  exec: ChainExec
  log?: (msg: string) => void
}

interface Slot {
  label: string
  owner: string
  spec: string
  enabled: boolean
}

export class FilterChain {
  private readonly slots = new Map<string, Slot>()
  private readonly claims = new Map<string, string>()
  private ready = false
  private pending = false
  private applying: Promise<void> | null = null

  private readonly cfg: ChainConfig

  constructor(cfg: ChainConfig) {
    this.cfg = cfg
  }

  /** Boot-time label claim. Two modules claiming one label is a boot error. */
  claim(ownerId: string, labels: readonly string[]): void {
    for (const label of labels) {
      if (!this.cfg.order.includes(label)) {
        throw new ContributionError(
          `module '${ownerId}' claims ${this.cfg.kind} label '${label}', which is not in the ` +
            `reserved label table (§5.5). Reserved ${this.cfg.kind} labels: ${this.cfg.order.join(', ')}.`
        )
      }
      const existing = this.claims.get(label)
      if (existing && existing !== ownerId) {
        throw new ContributionError(
          `${this.cfg.kind} label collision on '${label}': claimed by both '${existing}' and '${ownerId}'.`
        )
      }
      this.claims.set(label, ownerId)
    }
  }

  private assertOwned(ownerId: string, label: string): void {
    const owner = this.claims.get(label)
    if (owner !== ownerId) {
      throw new ContributionError(
        owner
          ? `module '${ownerId}' may not touch ${this.cfg.kind} label '${label}' (owned by '${owner}').`
          : `${this.cfg.kind} label '${label}' is not declared by any module. Add it to ` +
              `ownsFilterLabels and to the §5.5 table.`
      )
    }
  }

  set(ownerId: string, label: string, spec: string): void {
    this.assertOwned(ownerId, label)
    const prev = this.slots.get(label)
    this.slots.set(label, { label, owner: ownerId, spec, enabled: prev?.enabled ?? true })
    this.schedule()
  }

  remove(ownerId: string, label: string): void {
    this.assertOwned(ownerId, label)
    if (this.slots.delete(label)) this.schedule()
  }

  /** Disable in place, so the module's settings survive a toggle (A25). */
  toggle(ownerId: string, label: string, enabled: boolean): void {
    this.assertOwned(ownerId, label)
    const slot = this.slots.get(label)
    if (!slot || slot.enabled === enabled) return
    slot.enabled = enabled
    this.schedule()
  }

  has(label: string): boolean {
    return this.slots.has(label)
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
    lavfiFilterName: string
  ): Promise<{ path: 'command' | 'rebuild' }> {
    this.assertOwned(ownerId, label)
    if (!this.slots.has(label)) {
      throw new ContributionError(
        `${this.cfg.kind}.command() on '${label}', which has no slot. Call set() first.`
      )
    }
    if (this.cfg.refusers.includes(lavfiFilterName)) {
      await this.apply()
      return { path: 'rebuild' }
    }
    try {
      await this.cfg.exec.command([
        `${this.cfg.kind}-command`,
        label,
        option,
        value,
        lavfiFilterName
      ])
      return { path: 'command' }
    } catch (e) {
      // A filter that turns out not to implement process_command must not take
      // the slider down with it; fall back to the rebuild that always works.
      this.cfg.log?.(
        `[${this.cfg.kind}-chain] ${lavfiFilterName} refused ${this.cfg.kind}-command ` +
          `(${(e as Error).message}); rebuilding the chain instead`
      )
      await this.apply()
      return { path: 'rebuild' }
    }
  }

  /** Every lavfi filter forces hwdec frames back to system memory. */
  get hasCpuFilter(): boolean {
    for (const s of this.slots.values()) {
      if (s.enabled && s.spec.includes('lavfi=')) return true
    }
    return false
  }

  /** The exact string handed to mpv, in policy order. */
  serialise(): string {
    const out: string[] = []
    for (const label of this.cfg.order) {
      const slot = this.slots.get(label)
      if (!slot) continue
      out.push(`@${label}:${slot.enabled ? '' : '!'}${slot.spec}`)
    }
    return out.join(',')
  }

  /** Called by the bus on `file-loaded`. Flushes anything queued. */
  onFileLoaded(): void {
    this.ready = true
    if (this.pending) void this.apply()
  }

  /** Called by the bus when the file goes away or mpv respawns. */
  onUnload(): void {
    this.ready = false
  }

  private schedule(): void {
    if (!this.ready) {
      this.pending = true
      return
    }
    void this.apply()
  }

  /** One `<x>f set` with the whole chain: deterministic, order-correct, and
   *  it cannot leave a half-applied graph the way add/remove pairs can. */
  private apply(): Promise<void> {
    this.pending = false
    const run = async (): Promise<void> => {
      const chain = this.serialise()
      try {
        await this.cfg.exec.command([this.cfg.kind, 'set', chain])
      } catch (e) {
        this.cfg.log?.(
          `[${this.cfg.kind}-chain] failed to apply "${chain}": ${(e as Error).message}`
        )
      }
    }
    // Serialise applies: two overlapping `set`s can land out of order.
    this.applying = (this.applying ?? Promise.resolve()).then(run, run)
    return this.applying
  }
}

// --- §5.5 reserved labels and ordering policies ----------------------------

/** vf: deint → dv → 3d/360 → denoise/deblock → sharpen/soften → mblur → vsr
 *  → lut → rotate → hflip/vflip. Colour ops sit with denoise, before sharpen. */
export const VF_ORDER: readonly string[] = [
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
