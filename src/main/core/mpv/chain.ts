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
 *  - `command()` KEEPS THE SLOT IN AGREEMENT WITH mpv. The caller passes the
 *    spec the slot must hold AFTER the change and the chain CHECKS that it
 *    expresses that change (`specReflects`). Neither half is optional: a slot
 *    that lags mpv is reverted by the next whole-chain rebuild, and a rebuild
 *    that re-serialises a lagging slot is a live update that does nothing.
 *
 * A module passes the filter spec WITHOUT its label:
 *   ctx.vf.set('rl-sharpen', 'lavfi=[cas=strength=0.4]')
 * and the chain emits `@rl-sharpen:lavfi=[cas=strength=0.4]`.
 */

/**
 * Split on `sep` at the TOP level only: a separator inside `[]` or `()` belongs
 * to a nested lavfi graph, not to this level. Without this, `lavfi=[a=[x,y]]`
 * splits in the middle of its own argument.
 */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/**
 * The argument text of one libavfilter filter inside a slot spec, or undefined
 * when the spec does not mention that filter at all.
 *
 * Handles the `lavfi=[…]` wrapper every module uses (§5) and a bare mpv filter
 * name, and a comma-separated graph of several filters inside one slot.
 */
export function filterArgs(spec: string, filter: string): string | undefined {
  let body = spec.trim()
  const wrapped = /^lavfi\s*=\s*\[([\s\S]*)\]$/.exec(body)
  if (wrapped) body = wrapped[1] ?? ''
  for (const part of splitTop(body, ',')) {
    const seg = part.trim()
    const eq = seg.indexOf('=')
    const name = (eq === -1 ? seg : seg.slice(0, eq)).trim()
    if (name !== filter) continue
    return eq === -1 ? '' : seg.slice(eq + 1)
  }
  return undefined
}

/** The value a spec gives to a NAMED option of a filter, or undefined. */
export function specOption(spec: string, filter: string, option: string): string | undefined {
  const args = filterArgs(spec, filter)
  if (args === undefined) return undefined
  for (const token of splitTop(args, ':')) {
    const eq = token.indexOf('=')
    if (eq === -1) continue
    if (token.slice(0, eq).trim() === option) return token.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * `needle` appears in `haystack` as a whole token rather than as a prefix.
 *
 * `args.includes('g=9')` is true of `g=9.5` and of `f=500` inside `f=5000`, and a
 * check that cannot tell those apart is a check that passes the case it exists
 * for. The boundary is "not a digit or a dot on either side".
 */
function containsToken(haystack: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`)
  return new RegExp(`(^|[^0-9A-Za-z_.-])${esc}([^0-9.]|$)`).test(haystack)
}

export type SpecVerdict =
  | { ok: true; tier: 1 | 2 | 3 }
  | { ok: false; reason: string }

/**
 * Does `spec` express "`option` of `filter` is now `value`"?
 *
 * Exported so `chain.test.ts` can assert WHICH TIER each of the four production
 * call sites lands in, rather than trusting that the guard is strong everywhere.
 * See `#assertSpecReflects` for what each tier is worth.
 */
export function specReflects(
  spec: string,
  filter: string,
  option: string,
  value: string
): SpecVerdict {
  const args = filterArgs(spec, filter)
  if (args === undefined) {
    return {
      ok: false,
      reason:
        `the spec does not contain a '${filter}' filter at all, so it cannot be the spec for ` +
        `a ${filter} ${option} change.`
    }
  }
  const named = specOption(spec, filter, option)
  if (named !== undefined) {
    if (named === value) return { ok: true, tier: 1 }
    return {
      ok: false,
      reason:
        `tier 1: the spec names '${option}' and sets it to '${named}', not '${value}'. ` +
        `That is the stale-spec bug exactly.`
    }
  }
  const pairs = value
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
  if (pairs.length > 0) {
    const missing = pairs.filter((p) => !containsToken(args, p))
    if (missing.length === 0) return { ok: true, tier: 2 }
    return {
      ok: false,
      reason:
        `tier 2: '${option}' is not a named parameter of '${filter}', but the value is a list ` +
        `of k=v pairs and the spec is missing ${missing.map((m) => `'${m}'`).join(', ')}.`
    }
  }
  if (containsToken(args, value)) return { ok: true, tier: 3 }
  return {
    ok: false,
    reason:
      `tier 3: '${filter}' takes positional arguments, so all this can check is whether ` +
      `'${value}' appears in the spec as a whole token. It does not.`
  }
}

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

  /**
   * Whether this module's slot exists at all.
   *
   * Exposed to modules (through `FilterChainService`) because without it every
   * `ctx.vf` author has to keep a shadow copy of the chain's own state to know
   * whether the next change is a first `set()` or a live `command()`. That
   * shadow copy was 201 lines of `chain-sync.ts`, and a second model of one
   * piece of state is how the two disagree.
   *
   * Ownership-checked like every other label call: a module asking whether
   * ANOTHER module's slot is live is two modules depending on each other's
   * internals, which is the coupling §5 exists to prevent.
   */
  has(ownerId: string, label: string): boolean {
    this.#assertOwned(ownerId, label)
    return this.#slots.has(label)
  }

  /** Exists AND is not disabled-in-place. */
  isEnabled(ownerId: string, label: string): boolean {
    this.#assertOwned(ownerId, label)
    return this.#slots.get(label)?.enabled === true
  }

  /** What the slot currently holds, for the stats overlay and the tests. */
  specOf(ownerId: string, label: string): string | undefined {
    this.#assertOwned(ownerId, label)
    return this.#slots.get(label)?.spec
  }

  /**
   * Live parameter update. Returns which path it took so the caller can choose
   * between a live slider and commit-on-release without hardcoding the refuser
   * table itself — that table lives here, once, not in nine modules.
   *
   * `spec` IS REQUIRED, and that is the whole fix. See `#assertSpecReflects`.
   */
  async command(
    ownerId: string,
    label: string,
    option: string,
    value: string,
    lavfiFilterName: string,
    spec: string
  ): Promise<{ path: 'command' | 'rebuild' }> {
    this.#assertOwned(ownerId, label)
    const slot = this.#slots.get(label)
    if (!slot) {
      throw new ContributionError(
        `${this.#cfg.kind}.command() on '${label}', which has no slot. Call set() first.`
      )
    }
    /**
     * THE SLOT IS UPDATED BEFORE EITHER PATH RUNS, UNCONDITIONALLY.
     *
     * It used to be `if (spec !== undefined) slot.spec = spec` with `spec`
     * OPTIONAL, and the opt-in had zero production adopters, so the chain's
     * model of the filter diverged from mpv's on every live update in the
     * shipped app. Both halves of that were measured against this file:
     *
     *   command('rl-sharpen','strength','0.55','cas')  ->  serialise() still
     *   returned `@rl-sharpen:lavfi=[cas=strength=0.4]`, so the next foreign
     *   `set()` -- another module's slot, an mpv respawn, the next file --
     *   pushed 0.4 back to mpv and REVERTED the value the user just set.
     *
     *   command(...,'luma_amount','1.2','unsharp')     ->  V08, the row this
     *   chain's pilot module exists for. `unsharp` refuses `<x>f-command`, so
     *   the rebuild path runs, and the rebuild re-serialised the spec the slot
     *   ALREADY held: mpv received `unsharp=5:5:1.0`. The documented
     *   "transparently rebuilds for those" was a no-op.
     *
     *   af.command('rleq','change','0|f=500|w=100|g=9','anequalizer')  ->  the
     *   chain still held `g=0`.
     *
     * Making it required rather than optional is what closes it: the compiler
     * now refuses a call that cannot keep the slot honest, and there is no
     * spelling of `command()` left that silently desynchronises the chain. The
     * four production call sites pass it; `chain-sync.ts`, the 201-line
     * compensating file M03 had to write and M01/M09/M13/M14 would each have
     * copied, is gone.
     *
     * No `#schedule()` here: the rebuild path applies below, and the command
     * path does not need one. That is what keeps a per-pixel slider from
     * emitting a whole-chain `set` per event.
     */
    this.#assertSpecReflects(label, spec, lavfiFilterName, option, value)
    slot.spec = spec
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

  /**
   * `spec` must actually be the spec that reflects `option = value`.
   *
   * A required argument fixes "the caller forgot"; it does not fix "the caller
   * passed the spec it already had". That second shape is the same bug wearing a
   * five-argument call, and it is exactly what a module does when it computes
   * the spec from state it has not yet updated. So the chain checks, in three
   * tiers of decreasing strength, and the tier is part of the failure message so
   * an author knows how much the check actually proved:
   *
   *   TIER 1 — the spec names the option (`cas=strength=0.55`,
   *     `unsharp=…:luma_amount=1.2:…`, `volume=volume=-6dB:…`,
   *     `superequalizer=1b=9`). Exact string equality. This is a real check.
   *   TIER 2 — the option is not a named parameter but the VALUE is a
   *     pipe-separated list of `k=v` pairs, which is how `anequalizer`'s
   *     `change` works (`0|f=500|w=100|g=9`). Every pair must appear in the
   *     spec, which is enough to catch a `g=0` spec behind a `g=9` command.
   *   TIER 3 — neither, because the filter takes POSITIONAL arguments:
   *     `hqdn3d=4:3:6:4.5` against option `luma_spatial`. All that is left is
   *     that the value appears in the spec at all. Weak — `value: '4'` matches
   *     a stale `4:3:6:4.5` — and it still caught the shipped staleness for
   *     every hqdn3d slider position but the default. Stated plainly because a
   *     check whose limits are undocumented gets trusted past them.
   */
  #assertSpecReflects(
    label: string,
    spec: string,
    filter: string,
    option: string,
    value: string
  ): void {
    // The compiler refuses a four-argument call now, but `any` walks past it and
    // a silently-undefined spec IS the old behaviour. Fail loudly instead.
    if (typeof spec !== 'string' || spec.trim() === '') {
      throw new ContributionError(
        `${this.#cfg.kind}.command('${label}', '${option}', ...) was called without a spec ` +
          `(got ${typeof spec === 'string' ? 'an empty string' : typeof spec}). The spec ` +
          `argument is REQUIRED: it is the whole filter spec the slot must hold after this ` +
          `change, and without it the chain and mpv disagree from this call onwards.`
      )
    }
    const verdict = specReflects(spec, filter, option, value)
    if (verdict.ok) return
    throw new ContributionError(
      `${this.#cfg.kind}.command('${label}', '${option}', '${value}', '${filter}', spec) was ` +
        `given a spec that does not express that change.\n` +
        `  spec:  ${spec}\n` +
        `  ${verdict.reason}\n` +
        `The spec argument is the WHOLE filter spec the slot must hold AFTER this change, ` +
        `not the one it held before. Compute it from the state you have just updated. ` +
        `A spec that lags the command is the bug this argument exists to make impossible: ` +
        `mpv ends up holding one value and the chain another, and the next whole-chain ` +
        `rebuild silently reverts the user's change.`
    )
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
        has: (label) => chain.has(ownerId, label),
        isEnabled: (label) => chain.isEnabled(ownerId, label),
        specOf: (label) => chain.specOf(ownerId, label),
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
