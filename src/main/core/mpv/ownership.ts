import { ContributionError, OwnershipError } from '../errors.ts'

/**
 * core/mpv/ownership — the §3.7 property owner map. WAVE 0 — FROZEN.
 *
 * This file is the whole of "mechanical property ownership". The §3.6
 * "Must NOT touch" column is documentation; this is the code that throws.
 *
 * Two enforcement points, both real:
 *   1. BOOT. `buildOwnerMap()` folds every module's `ownsProperties` into one
 *      Map<property, FeatureId> and throws, naming BOTH modules and the
 *      property, on a duplicate or an overlapping glob. The app does not start.
 *   2. EVERY CALL. `assertWrite()` backs `MpvService.set()` and the
 *      property-writing commands (`set_property`, `cycle`, `add`, `multiply`,
 *      `cycle-values`, `change-list`), so an unowned write is refused with the
 *      owner named and the mediated alternative spelled out.
 *
 * Free of Electron and of the bus, so `test:property-ownership` can build a
 * map from fixtures and assert both behaviours without launching anything.
 */

export interface OwnershipDeclaration {
  id: string
  ownsProperties?: readonly string[]
  requestsProperties?: readonly string[]
}

interface Claim {
  owner: string
  /** Exact name, or the prefix of a trailing-'*' glob. */
  pattern: string
  glob: boolean
}

/** Commands whose first argument names a property being written. */
export const PROPERTY_WRITING_COMMANDS = new Set([
  'set_property',
  'set',
  'cycle',
  'add',
  'multiply',
  'cycle-values',
  'change-list'
])

/** §0.2 rule 5: no feature module ever issues a raw filter command. */
export const CHAIN_COMMANDS = new Set(['vf', 'af', 'vf-command', 'af-command'])

/**
 * The core pieces are owners too (§3.7's first four rows). Seeding them means
 * `ownerOf('pause')` answers 'core/mpv/bus' rather than 'nobody', so a module
 * that tries to write the transport gets the same named-owner error it would
 * get for another module's property — and the CI cross-check against
 * modules.json compares like with like.
 */
export const CORE_OWNERSHIP: readonly OwnershipDeclaration[] = [
  {
    id: 'core/mpv/bus',
    ownsProperties: ['pause', 'keep-open', 'idle', 'force-window', 'msg-level', 'input-*']
  },
  { id: 'core/vf-chain', ownsProperties: ['vf'] },
  { id: 'core/af-chain', ownsProperties: ['af'] }
]

export class OwnerMap {
  private readonly exact = new Map<string, string>()
  private readonly globs: Claim[] = []
  private readonly requests = new Map<string, Set<string>>()
  /** Production drops rather than throws; the count is surfaced in stats. */
  private readonly refusals = new Map<string, number>()

  constructor(decls: readonly OwnershipDeclaration[]) {
    const claims: Claim[] = []
    for (const d of decls) {
      for (const raw of d.ownsProperties ?? []) {
        const glob = raw.endsWith('*')
        const pattern = glob ? raw.slice(0, -1) : raw
        if (!pattern) {
          throw new ContributionError(
            `module '${d.id}' declares the bare glob '*' in ownsProperties, which would ` +
              `claim every mpv property. Name the properties, or use a prefix like 'screenshot-*'.`
          )
        }
        if (raw.indexOf('*') !== raw.length - 1 && raw.includes('*')) {
          throw new ContributionError(
            `module '${d.id}' declares '${raw}' in ownsProperties: only a single TRAILING '*' is allowed.`
          )
        }
        claims.push({ owner: d.id, pattern, glob })
      }
      if (d.requestsProperties?.length) {
        this.requests.set(d.id, new Set(d.requestsProperties))
      }
    }

    for (const claim of claims) {
      for (const other of claims) {
        if (other === claim) continue
        if (!overlaps(claim, other)) continue
        if (claim.owner === other.owner) continue
        const a = claim.glob ? `${claim.pattern}*` : claim.pattern
        const b = other.glob ? `${other.pattern}*` : other.pattern
        // Both names, always. "Two modules claim a property" is useless; "M11
        // and M15 both claim 'aid'" is a fix.
        throw new ContributionError(
          `mpv property ownership collision: '${a}' (${claim.owner}) overlaps '${b}' (${other.owner}). ` +
            `Exactly one module may write a property (§3.7). Pick an owner and give the other a ` +
            `mediator command, then update docs/parity/modules.json.`
        )
      }
      if (claim.glob) this.globs.push(claim)
      else this.exact.set(claim.pattern, claim.owner)
    }
    // Longest prefix wins when two non-overlapping globs could both match.
    this.globs.sort((a, b) => b.pattern.length - a.pattern.length)
  }

  ownerOf(property: string): string | null {
    const direct = this.exact.get(property)
    if (direct) return direct
    for (const g of this.globs) if (property.startsWith(g.pattern)) return g.owner
    return null
  }

  owns(moduleId: string, property: string): boolean {
    return this.ownerOf(property) === moduleId
  }

  mayRequest(moduleId: string, property: string): boolean {
    return this.requests.get(moduleId)?.has(property) === true
  }

  /** Every property claimed, for the CI cross-check against modules.json. */
  entries(): Array<{ property: string; owner: string }> {
    const out = [...this.exact].map(([property, owner]) => ({ property, owner }))
    for (const g of this.globs) out.push({ property: `${g.pattern}*`, owner: g.owner })
    return out.sort((a, b) => a.property.localeCompare(b.property))
  }

  refusalCount(moduleId: string): number {
    return this.refusals.get(moduleId) ?? 0
  }

  /**
   * The check `MpvService.set()` runs on every call.
   * `strict` is true in dev (throw) and false in a packaged build (log, drop,
   * count) — §3.5 rule 5: one misbehaving module must not black-screen the
   * player, but it must not corrupt another module's state either.
   */
  assertWrite(
    moduleId: string,
    property: string,
    strict: boolean,
    log: (msg: string) => void
  ): boolean {
    if (this.owns(moduleId, property)) return true
    const owner = this.ownerOf(property)
    const hint = owner
      ? `Use ctx.mpv.requestSet('${property}', value, reason) or the owner's mediator command.`
      : `Reads are unrestricted; only writes are owned.`
    const err = new OwnershipError(moduleId, property, owner, hint)
    if (strict) throw err
    this.refusals.set(moduleId, (this.refusals.get(moduleId) ?? 0) + 1)
    log(`[ownership] ${err.message}`)
    return false
  }
}

function overlaps(a: Claim, b: Claim): boolean {
  if (!a.glob && !b.glob) return a.pattern === b.pattern
  if (a.glob && b.glob) return a.pattern.startsWith(b.pattern) || b.pattern.startsWith(a.pattern)
  const glob = a.glob ? a : b
  const exact = a.glob ? b : a
  return exact.pattern.startsWith(glob.pattern)
}

/**
 * Extract the property a command writes, or null if it writes none.
 * `['set_property','aid',2]` → 'aid'; `['seek',5,'exact']` → null.
 */
export function propertyWrittenBy(args: readonly unknown[]): string | null {
  const head = args[0]
  if (typeof head !== 'string') return null
  const verb = head.replace(/^(async\s+|no-osd\s+)+/, '')
  if (!PROPERTY_WRITING_COMMANDS.has(verb)) return null
  const name = args[1]
  return typeof name === 'string' ? name : null
}

/** True for a raw `vf`/`af` command, which only the chain owners may issue. */
export function isChainCommand(args: readonly unknown[]): boolean {
  const head = args[0]
  if (typeof head !== 'string') return false
  return CHAIN_COMMANDS.has(head.replace(/^(async\s+|no-osd\s+)+/, ''))
}
