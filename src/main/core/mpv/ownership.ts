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
 *      property-writing commands, so an unowned write is refused with the
 *      owner named and the mediated alternative spelled out.
 *
 * Free of Electron and of the bus, so `test:property-ownership` can build a
 * map from fixtures and assert both behaviours without launching anything.
 */

export interface OwnershipDeclaration {
  id: string
  ownsProperties?: readonly string[]
  ownsCommands?: readonly string[]
  requestsProperties?: readonly string[]
}

interface Claim {
  owner: string
  /** Exact name, or the prefix of a trailing-'*' glob. */
  pattern: string
  glob: boolean
}

/**
 * mpv's command PREFIXES, verified against the pinned binary
 * (v0.41.0-923-g7b8915bc1) over JSON IPC rather than copied from memory.
 *
 * Every name below was sent as `[prefix, 'set', 'speed', '1.5']`, returned
 * `success` and wrote the property. `allow-vo-dragging`, `osd`, `quiet` and a
 * control string were sent the same way and all returned `invalid parameter`,
 * so this list is the measured boundary, not a guess.
 *
 * The bug this replaces: the guard was a regex,
 * `head.replace(/^(async\s+|no-osd\s+)+/, '')`, which handled two names and
 * only in the SPACE-JOINED form. mpv accepts a prefix as its own array element,
 * so `['osd-msg','set','speed','1.75']`, `['raw','set',...]`,
 * `['osd-bar','add',...]`, `['repeatable','multiply',...]` and
 * `['async','set',...]` all wrote the property and returned null from
 * `propertiesWrittenBy` — completely unguarded. `['no-osd','vf','set',...]`
 * walked past the chain guard the same way.
 *
 * Measured detail worth keeping: mpv accepts exactly ONE prefix over JSON IPC.
 * `['async','no-osd','set',...]` is `invalid parameter`. We strip a RUN of them
 * anyway — over-stripping can only make the guard stricter, and a command mpv
 * would reject is not worth a hole.
 */
export const MPV_COMMAND_PREFIXES: readonly string[] = [
  'osd-auto',
  'no-osd',
  'osd-bar',
  'osd-msg',
  'osd-msg-bar',
  'raw',
  'expand-properties',
  'repeatable',
  'nonrepeatable',
  'async',
  'sync'
]

const PREFIX_SET = new Set(MPV_COMMAND_PREFIXES)

/**
 * Commands whose second element names a property being WRITTEN, in canonical
 * (hyphenated) spelling.
 *
 * The audit found `set_property_string` and the underscore aliases missing:
 * `['set_property_string','aid','1']` and `['cycle_values','speed',...]` both
 * wrote successfully and unguarded. mpv accepts `_` for `-` in these names —
 * measured: `set_property`, `set_property_string`, `cycle_values` and
 * `change_list` all return `success` — so lookup canonicalises `_` to `-`
 * before it consults this set.
 */
export const PROPERTY_WRITING_COMMANDS = new Set([
  'set-property',
  'set-property-string',
  'set',
  'del',
  'cycle',
  'add',
  'multiply',
  'cycle-values',
  'change-list'
])

/** §0.2 rule 5: no feature module ever issues a raw filter command. */
export const CHAIN_COMMANDS = new Set(['vf', 'af', 'vf-command', 'af-command'])

/**
 * Commands nobody may issue, whoever they are.
 *
 * `screenshot-raw` KILLS mpv over JSON IPC (§7.7 trap 5) — the reply is a
 * megabyte of base64 the pipe reader does not survive. It has no owner because
 * there is no correct use of it here.
 */
export const BANNED_COMMANDS = new Set(['screenshot-raw'])

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
    ownsProperties: ['pause', 'keep-open', 'idle', 'force-window', 'msg-level', 'input-*'],
    // The process, the input layer and mpv's own config are the transport's.
    // A module that quits mpv behind the registry's back leaves the windows up
    // and the app in a state nothing can recover from.
    ownsCommands: [
      'quit',
      'quit-watch-later',
      'load-config-file',
      'load-input-conf',
      'load-script',
      'define-section',
      'enable-section',
      'disable-section',
      'keybind',
      'keypress',
      'keydown',
      'keyup',
      'run',
      'subprocess'
    ]
  },
  { id: 'core/vf-chain', ownsProperties: ['vf'] },
  { id: 'core/af-chain', ownsProperties: ['af'] }
]

export class OwnerMap {
  private readonly exact = new Map<string, string>()
  private readonly globs: Claim[] = []
  private readonly commands = new Map<string, string>()
  private readonly commandGlobs: Claim[] = []
  private readonly requests = new Map<string, Set<string>>()
  /** Production drops rather than throws; `refusals()` surfaces the count. */
  private readonly refusals = new Map<string, number>()

  constructor(decls: readonly OwnershipDeclaration[]) {
    this.fold(
      decls,
      (d) => d.ownsProperties ?? [],
      'ownsProperties',
      'mpv property',
      this.exact,
      this.globs
    )
    this.fold(
      decls,
      (d) => d.ownsCommands ?? [],
      'ownsCommands',
      'mpv command',
      this.commands,
      this.commandGlobs
    )
    for (const d of decls) {
      if (d.requestsProperties?.length) this.requests.set(d.id, new Set(d.requestsProperties))
    }
  }

  private fold(
    decls: readonly OwnershipDeclaration[],
    pick: (d: OwnershipDeclaration) => readonly string[],
    field: string,
    noun: string,
    exact: Map<string, string>,
    globs: Claim[]
  ): void {
    const claims: Claim[] = []
    for (const d of decls) {
      for (const raw of pick(d)) {
        const glob = raw.endsWith('*')
        const pattern = glob ? raw.slice(0, -1) : raw
        if (!pattern) {
          throw new ContributionError(
            `module '${d.id}' declares the bare glob '*' in ${field}, which would ` +
              `claim every ${noun}. Name them, or use a prefix like 'screenshot-*'.`
          )
        }
        if (raw.indexOf('*') !== raw.length - 1 && raw.includes('*')) {
          throw new ContributionError(
            `module '${d.id}' declares '${raw}' in ${field}: only a single TRAILING '*' is allowed.`
          )
        }
        claims.push({ owner: d.id, pattern, glob })
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
          `${noun} ownership collision: '${a}' (${claim.owner}) overlaps '${b}' (${other.owner}). ` +
            `Exactly one module may own it (§3.7). Pick an owner and give the other a ` +
            `mediator command, then update docs/parity/modules.json.`
        )
      }
      if (claim.glob) globs.push(claim)
      else exact.set(claim.pattern, claim.owner)
    }
    // Longest prefix wins when two non-overlapping globs could both match.
    globs.sort((a, b) => b.pattern.length - a.pattern.length)
  }

  ownerOf(property: string): string | null {
    const direct = this.exact.get(property)
    if (direct) return direct
    for (const g of this.globs) if (property.startsWith(g.pattern)) return g.owner
    return null
  }

  commandOwnerOf(command: string): string | null {
    const name = canonicalCommand(command)
    const direct = this.commands.get(name)
    if (direct) return direct
    for (const g of this.commandGlobs) if (name.startsWith(g.pattern)) return g.owner
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

  commandEntries(): Array<{ command: string; owner: string }> {
    const out = [...this.commands].map(([command, owner]) => ({ command, owner }))
    for (const g of this.commandGlobs) out.push({ command: `${g.pattern}*`, owner: g.owner })
    return out.sort((a, b) => a.command.localeCompare(b.command))
  }

  refusalCount(moduleId: string): number {
    return this.refusals.get(moduleId) ?? 0
  }

  /**
   * Every refusal so far, most recent count first.
   *
   * This is read for real now. The old comment claimed the count was "surfaced
   * in stats" while nothing in `src/` read `refusalCount` at all, so a shipped
   * build dropped a foreign write in complete silence — the worst of both
   * worlds. `core/mpv/bus` reports these to the stats overlay and toasts the
   * first one, so a refusal reaches a bug report instead of a void.
   */
  refusalEntries(): Array<{ moduleId: string; count: number }> {
    return [...this.refusals]
      .map(([moduleId, count]) => ({ moduleId, count }))
      .sort((a, b) => b.count - a.count)
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
    const err = new OwnershipError(moduleId, property, owner, writeHint(this, moduleId, property))
    if (strict) throw err
    this.refusals.set(moduleId, (this.refusals.get(moduleId) ?? 0) + 1)
    log(`[ownership] ${err.message}`)
    return false
  }

  /** The same check for a command that has an owner (`ownsCommands`). */
  assertCommand(
    moduleId: string,
    command: string,
    strict: boolean,
    log: (msg: string) => void
  ): boolean {
    const owner = this.commandOwnerOf(command)
    if (owner === null || owner === moduleId) return true
    const err = new OwnershipError(
      moduleId,
      command,
      owner,
      `'${command}' is a COMMAND, not a property, and it is owned. Call ${owner}'s ` +
        `mediator through ctx.commands.invoke() rather than issuing it yourself.`
    )
    if (strict) throw err
    this.refusals.set(moduleId, (this.refusals.get(moduleId) ?? 0) + 1)
    log(`[ownership] ${err.message}`)
    return false
  }
}

/**
 * The hint in an OwnershipError, and it must never point somewhere dead.
 *
 * `requestSet` refuses with `'no-arbiter'` unless the owner registered one, so
 * telling every developer to "use ctx.mpv.requestSet(...)" cost an hour to
 * anyone whose property had no arbiter. The hint now depends on whether the
 * caller actually declared the property in `requestsProperties`: if it did not,
 * the honest instruction is to declare it and talk to the owner, because that
 * is the review conversation the field exists to force.
 */
function writeHint(map: OwnerMap, moduleId: string, property: string): string {
  const owner = map.ownerOf(property)
  if (!owner) return 'Reads are unrestricted; only writes are owned.'
  if (map.mayRequest(moduleId, property)) {
    return (
      `Use ctx.mpv.requestSet('${property}', value, reason) — you declared it in ` +
      `requestsProperties, so ${owner}'s arbiter will answer (a refusal is a normal outcome).`
    )
  }
  return (
    `Add '${property}' to your requestsProperties and use ` +
    `ctx.mpv.requestSet('${property}', value, reason), or call ${owner}'s mediator command. ` +
    `If ${owner} has no arbiter for it yet, adding one is a one-line PR against ${owner}.`
  )
}

function overlaps(a: Claim, b: Claim): boolean {
  if (!a.glob && !b.glob) return a.pattern === b.pattern
  if (a.glob && b.glob) return a.pattern.startsWith(b.pattern) || b.pattern.startsWith(a.pattern)
  const glob = a.glob ? a : b
  const exact = a.glob ? b : a
  return exact.pattern.startsWith(glob.pattern)
}

/** mpv accepts `_` for `-` in a command name; the owner map speaks hyphens. */
export function canonicalCommand(name: string): string {
  return name.replace(/_/g, '-')
}

/**
 * Strip mpv's command prefixes and return the verb, or null if `args` does not
 * start with a string.
 *
 * `['no-osd','set','speed','2']` → `{ verb: 'set', at: 1 }`. The legacy
 * space-joined spelling mpv's input.conf uses (`'no-osd set'`) is handled too,
 * even though it is `invalid parameter` over JSON IPC, because it costs one
 * line and a guard should not depend on which spelling reached it.
 */
export function verbOf(args: readonly unknown[]): { verb: string; at: number } | null {
  let at = 0
  let head = args[at]
  if (typeof head !== 'string') return null

  // Space-joined: 'no-osd set' or even 'async no-osd set'.
  const parts = head.trim().split(/\s+/)
  if (parts.length > 1) {
    let i = 0
    while (i < parts.length - 1 && PREFIX_SET.has(parts[i]!)) i++
    return { verb: parts[i]!, at }
  }

  // Separate array elements, which is the form mpv actually takes.
  while (typeof head === 'string' && PREFIX_SET.has(head)) {
    at++
    head = args[at]
  }
  return typeof head === 'string' ? { verb: head, at } : null
}

/**
 * Every property a command writes.
 *
 * Two things the single-property version missed:
 *   - the prefix forms above;
 *   - `loadfile`'s options argument. `['loadfile', f, 'replace', 0, 'speed=2.5']`
 *     and the map form `[..., -1, {speed: '3.0'}]` were both measured to set the
 *     property for real (speed came back 2.5 and 3.0), so a module could set
 *     anything it liked by loading a file with options.
 */
export function propertiesWrittenBy(args: readonly unknown[]): string[] {
  const found = verbOf(args)
  if (!found) return []
  const verb = canonicalCommand(found.verb)

  if (PROPERTY_WRITING_COMMANDS.has(verb)) {
    const name = args[found.at + 1]
    return typeof name === 'string' ? [name] : []
  }

  if (verb === 'loadfile' || verb === 'loadlist') {
    // loadfile url [flags [index [options]]] — options is the 5th element.
    const opts = args[found.at + 4]
    if (typeof opts === 'string') {
      return opts
        .split(',')
        .map((pair) => pair.split('=')[0]?.trim() ?? '')
        .filter(Boolean)
    }
    if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
      return Object.keys(opts as Record<string, unknown>)
    }
  }
  return []
}

/** Kept for callers that only need the first one. */
export function propertyWrittenBy(args: readonly unknown[]): string | null {
  return propertiesWrittenBy(args)[0] ?? null
}

/** True for a raw `vf`/`af` command, which only the chain owners may issue. */
export function isChainCommand(args: readonly unknown[]): boolean {
  const found = verbOf(args)
  return found !== null && CHAIN_COMMANDS.has(canonicalCommand(found.verb))
}

/** True for a command nobody may issue. */
export function isBannedCommand(args: readonly unknown[]): boolean {
  const found = verbOf(args)
  return found !== null && BANNED_COMMANDS.has(canonicalCommand(found.verb))
}

/** The command name a guard should report, prefixes removed. */
export function commandNameOf(args: readonly unknown[]): string | null {
  const found = verbOf(args)
  return found === null ? null : canonicalCommand(found.verb)
}
