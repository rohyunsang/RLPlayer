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
 * CORRECTION, re-measured against the same pinned binary because the previous
 * revision of this comment was simply wrong. It claimed mpv accepts exactly ONE
 * prefix and that `['async','no-osd','set',...]` is `invalid parameter`. It is
 * not. All four of these returned `error: success` AND wrote the property:
 *
 *   ['async','no-osd','set','speed','1.5']    -> success, speed 1 -> 1.5
 *   ['no-osd','async','set','speed','1.75']   -> success, speed 1 -> 1.75
 *   ['osd-msg','raw','set','speed','2.0']     -> success, speed 1 -> 2
 *   ['async','async','set','speed','2.25']    -> success, speed 1 -> 2.25
 *
 * The guard below already strips a RUN of prefixes, so it was correct while the
 * comment was not — which is the dangerous shape: the next person to "simplify"
 * the loop to a single strip would have had a comment telling them it was safe.
 * Stripping a run is the required behaviour, not belt and braces.
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
export const BANNED_COMMANDS = new Set([
  'screenshot-raw',
  /**
   * `apply-profile` writes an UNBOUNDED set of properties in one call, and it
   * was measured doing exactly that from an unrelated module:
   * `['apply-profile','fast']` rewrote `scale` from `lanczos` to `bilinear` —
   * M06's property — with no throw and no refusal counted, because the owner map
   * only ever looked at commands whose second argument NAMES a property.
   *
   * There is no way to police it: the set of properties a profile touches lives
   * inside mpv, and we run with `--no-config` so the only profiles available are
   * mpv's built-ins, every one of which stomps somebody's owned property. A
   * module that wants a preset applies its own properties.
   */
  'apply-profile',
  /**
   * `update-clipboard` pushes mpv's `clipboard/text` into the SYSTEM clipboard.
   *
   * Every clipboard path in this product is Electron's (`clipboard.writeText`):
   * L25 "copy media info", L34 "copy path(s)", M22's "paste into Paint". mpv
   * writing the same clipboard from the other side is a race with no owner and
   * no benefit — we never set `clipboard/text`, so what it would write is
   * whatever mpv last put there. There is no correct use of it here.
   */
  'update-clipboard'
])

/**
 * COMMANDS THAT MUTATE NOTHING, each with the reason it is on this list.
 *
 * This exists so the ownership question can be asked about EVERY command the
 * pinned binary has, rather than only about the ones somebody remembered to put
 * in `COMMAND_SIDE_EFFECTS`. `commands.test.ts` walks the binary's own
 * `--input-cmdlist` (via docs/parity/mpv-commands.json) and requires each name
 * to be classified: owned, banned, chain-reserved, property-writing — or here.
 *
 * That inversion is the point. The old test iterated the hand-written
 * side-effect table, so a command missing from that table was invisible to the
 * check that existed to find missing commands — the same self-referential
 * blindness that let `seek` ship with no owner. Adding a name here is now a
 * deliberate, reviewable claim that it writes nothing, and bumping the mpv pin
 * surfaces every command the new build added.
 */
export const NON_MUTATING_COMMANDS = new Set([
  // Pure string transforms. Each returns a value and touches no player state.
  'escape-ass',
  'expand-path',
  'expand-text',
  'normalize-path',
  // mpv's documented no-op. It exists to bind a key to nothing.
  'ignore',
  // Terminal output only. We run `--terminal=yes --msg-level=all=error` and
  // nothing parses mpv's status line, so this reaches no state we hold.
  'flush-status-line'
])

/**
 * COMMANDS THAT WRITE PROPERTIES WITHOUT NAMING THEM.
 *
 * This table is the fix for the widest remaining ownership hole. `assertCommand`
 * only guarded commands that had an OWNER, and `propertiesWrittenBy` only
 * understood commands whose second element is a property name — so from an
 * unrelated module, every one of these landed silently:
 *
 *   ['frame-step']       -> flipped core-owned `pause` (measured: false -> true)
 *   ['frame-back-step']  -> same
 *   ['ab-loop']          -> set M26's `ab-loop-a` (measured: "no" -> 2.466667)
 *   ['sub-seek', 1]      -> seeks, and M24 owns seeking
 *
 * No throw, no refusal counted, nothing in the log.
 *
 * The command NAMES are checked against the pinned binary's own
 * `--input-cmdlist` by `commands.test.ts` (via docs/parity/mpv-commands.json),
 * so a typo or a command mpv renamed fails CI rather than silently guarding
 * nothing. The side EFFECTS have to be hand-written — `--input-cmdlist` prints
 * argument signatures, not what they mutate — and each line below was verified
 * over JSON IPC by reading the property before and after.
 */
export const COMMAND_SIDE_EFFECTS: Readonly<Record<string, readonly string[]>> = {
  // Seeking. §3.6's M25 row says N51 "seeks through M24's command, it does not
  // own seeking"; that sentence is enforced by M24 owning these four.
  seek: ['time-pos'],
  'revert-seek': ['time-pos'],
  'frame-step': ['pause', 'time-pos'],
  'frame-back-step': ['pause', 'time-pos'],
  // §1.5: `sub-step` shifts subtitle TIMING, `sub-seek` seeks VIDEO. Both are
  // M20's, and keeping the confusable pair with one owner is the point.
  'sub-seek': ['time-pos'],
  'sub-step': ['sub-delay'],
  // A-B loop. M26 owns the properties, so it owns the command that sets them.
  'ab-loop': ['ab-loop-a', 'ab-loop-b'],
  // Track lists. M11 owns aid/vid, M17 owns sid.
  'sub-add': ['sid'],
  'sub-remove': ['sid'],
  'sub-reload': ['sid'],
  'audio-add': ['aid'],
  'audio-remove': ['aid'],
  'audio-reload': ['aid'],
  'video-add': ['vid'],
  'video-remove': ['vid'],
  'video-reload': ['vid'],
  'rescan-external-files': ['sid', 'aid'],
  // The queue. M28 already owns `playlist-*` as a glob; the effects are listed
  // so the table is the single place to read "what does this touch".
  'playlist-next': ['playlist-pos'],
  'playlist-prev': ['playlist-pos'],
  'playlist-next-playlist': ['playlist-pos'],
  'playlist-prev-playlist': ['playlist-pos'],
  'playlist-play-index': ['playlist-pos'],
  'playlist-shuffle': ['playlist-pos'],
  'playlist-unshuffle': ['playlist-pos'],
  'playlist-remove': ['playlist-pos'],
  'playlist-move': ['playlist-pos'],
  'playlist-clear': ['playlist-pos'],
  stop: ['path', 'playlist-pos'],
  // The audio output reinit round-trip, which §3.6 gives to M15 outright.
  'ao-reload': ['audio-device'],
  // mpv's own resume file. Ours is core/state/per-file; mpv writing a second one
  // behind it is how two resume positions disagree.
  'write-watch-later-config': ['path'],
  'delete-watch-later-config': ['path']
}

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
      'subprocess',
      // The OSD is `ctx.osd`. A module issuing show-text directly bypasses the
      // per-kind enable flags the user set in preferences.
      'show-text',
      'show-progress',
      'print-text',
      // …and the same argument for everything else that draws inside mpv's own
      // video surface. These render UNDER our overlay's opaque areas (U06), so a
      // module using them produces something the user can only half see.
      'osd-overlay',
      'overlay-add',
      'overlay-remove',
      // INPUT INJECTION, the same family as keypress/keydown/keyup above.
      // `mouse` was named in §6 and owned by nobody: `assertCommand(x,'mouse')`
      // returned true for every module. mpv's child HWND is `EnableWindow(hwnd,0)`
      // under `--wid` and we pass `--input-cursor=no`, so synthesised pointer
      // input either does nothing or drives mpv's own bindings behind the
      // overlay's back. Neither is a module's to decide.
      'mouse',
      'begin-vo-dragging',
      // mpv's own native context menu. Ours is `ctx.menu` (§3.3.5).
      'context-menu',
      // Transport-level: drops the demuxer and AV buffers. It belongs with the
      // respawn path, not with whichever module wanted a faster seek.
      'drop-buffers',
      // The property-notification plumbing IS this bus.
      'notify-property',
      // mpv's own resume file. Ours is core/state/per-file; a module writing
      // mpv's as well is how two resume positions come to disagree.
      'write-watch-later-config',
      'delete-watch-later-config'
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
  /**
   * Whether an arbiter is actually REGISTERED for a property.
   *
   * The owner map cannot know this on its own — arbiters live on the bus — and
   * not knowing it is what made `writeHint` lie. It promised "video-decode's
   * arbiter will answer" to anyone who had declared the property in
   * `requestsProperties`, without checking that one existed; in that exact case
   * `requestSet` returned `{ ok: false, reason: 'no-arbiter' }` and the
   * developer had followed the error message into a dead end.
   */
  private hasArbiter: (property: string) => boolean = () => false

  /** Wired once by core/mpv/bus, which is where the arbiters actually live. */
  setArbiterProbe(fn: (property: string) => boolean): void {
    this.hasArbiter = fn
  }

  arbiterRegistered(property: string): boolean {
    return this.hasArbiter(property)
  }

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
    // The hint MUST NOT promise an arbiter that is not registered. It used to,
    // and `requestSet` then answered 'no-arbiter' — the error message sent you
    // to a call that could not succeed.
    if (map.arbiterRegistered(property)) {
      return (
        `Use ctx.mpv.requestSet('${property}', value, reason) — you declared it in ` +
        `requestsProperties and ${owner} has registered an arbiter, so it will answer ` +
        `(a refusal is a normal outcome; handle it).`
      )
    }
    return (
      `You declared '${property}' in requestsProperties, but ${owner} has NOT registered an ` +
      `arbiter for it, so ctx.mpv.requestSet('${property}', …) would answer 'no-arbiter'. ` +
      `Call ${owner}'s mediator command, or open a one-line PR against ${owner} adding ` +
      `ctx.mpv.arbitrate('${property}', …) in its setup().`
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
 * COMMAND SHAPE, checked before any guard reads the array. FAIL CLOSED.
 *
 * THE BUG THIS EXISTS FOR. Every guard below started with `verbOf()`, and
 * `verbOf()` answered `null` — "I do not recognise this" — whenever the head
 * was not a primitive string. `null` then flowed into `propertiesWrittenBy()`
 * (→ `[]`, nothing to own-check), `isChainCommand()` (→ false), and
 * `isBannedCommand()` (→ false). So "unrecognised" meant "allowed", and the
 * whole of §3.7 switched itself off for any command shape it had not been
 * taught. Measured in strict/dev mode, 9 of 11 probes landed and 0 threw:
 *
 *   [new String('set'), 'speed', 4]        → JSON `["set","speed",4]`, unchecked
 *   [new String('vf'), 'set', 'hflip']     → a raw filter-chain write (§0.2 r5)
 *   [new String('apply-profile'), 'fast']  → the BANNED command, unchecked
 *   ['set', new String('speed'), 4]        → verb recognised, PROPERTY skipped
 *
 * The last one is the sharpest: the head is a real string, so `verbOf` was
 * happy, and only the property name was boxed — `explicitPropertiesWrittenBy`
 * did `typeof name === 'string' ? [name] : []` and returned nothing to check.
 *
 * A boxed primitive is `typeof 'object'` and `JSON.stringify`s as a plain
 * string, so mpv executes exactly what the guard refused to look at. The same
 * is true of any object carrying a `toJSON`. The fix is not to teach the guards
 * one more shape — it is to refuse every shape that is not the one shape the
 * wire format has: JSON primitives, plus a plain object/array for `loadfile`'s
 * options argument.
 *
 * LIMIT, stated honestly: a Proxy that lies about `toJSON` and its prototype
 * would still get through. This is a guardrail against accidents and against
 * the ordinary bypass, not a sandbox — a module that wants to lie about its
 * own object identity is already running in-process.
 */
const JSON_PRIMITIVE = new Set(['string', 'number', 'boolean'])

function shapeProblem(v: unknown, where: string, nested: boolean): string | null {
  if (v === null) return null
  const t = typeof v
  if (t === 'number') {
    return Number.isFinite(v as number) ? null : `${where} is ${String(v)}, which JSON drops`
  }
  if (JSON_PRIMITIVE.has(t)) return null
  if (t === 'undefined') return `${where} is undefined, which JSON.stringify drops`
  if (t !== 'object') return `${where} is a ${t}`

  const tag = Object.prototype.toString.call(v)
  if (tag !== '[object Object]' && tag !== '[object Array]') {
    // `[object String]` is `new String('set')`, the whole reason for this file.
    return (
      `${where} is ${tag}, not a JSON value. It serialises to something the ownership ` +
      `guards never inspected, which is a bypass, not a convenience.`
    )
  }
  if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return `${where} carries a toJSON(), so what mpv receives is not what was checked`
  }
  if (nested) {
    // One level only: `loadfile`'s options map, whose values are scalars.
    return `${where} nests an object or array more than one level deep`
  }
  const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(v)
    ? v.map((x, i) => [String(i), x] as const)
    : Object.entries(v as Record<string, unknown>)
  for (const [k, val] of entries) {
    const p = shapeProblem(val, `${where}.${k}`, true)
    if (p) return p
  }
  return null
}

/**
 * Why `args` is not a legal mpv command, or null when it is.
 *
 * Exported so `guards.test.ts` can assert on the reason rather than only on the
 * throw, and so a future caller that wants to report instead of throw can.
 */
export function commandShapeProblem(args: readonly unknown[]): string | null {
  if (!Array.isArray(args)) return 'an mpv command is an array'
  if (args.length === 0) return 'an mpv command is a non-empty array; this one is empty'
  for (let i = 0; i < args.length; i++) {
    const p = shapeProblem(args[i], `argument ${i}`, false)
    if (p) return p
  }
  return null
}

/** Throws unless every element of `args` is a JSON value mpv can receive. */
export function assertCommandShape(args: readonly unknown[]): void {
  const problem = commandShapeProblem(args)
  if (problem === null) return
  throw new ContributionError(
    `refusing an mpv command whose shape the ownership guards cannot read: ${problem}. ` +
      `Every element must be a string, a finite number, a boolean, null, or (for loadfile's ` +
      `options argument) a flat object or array of those. An unrecognised shape used to ` +
      `disable every check in §3.7 silently; it is a hard error now.`
  )
}

/**
 * Strip mpv's command prefixes and return the verb.
 *
 * `['no-osd','set','speed','2']` → `{ verb: 'set', at: 1 }`. The legacy
 * space-joined spelling mpv's input.conf uses (`'no-osd set'`) is handled too,
 * even though it is `invalid parameter` over JSON IPC, because it costs one
 * line and a guard should not depend on which spelling reached it.
 *
 * THROWS rather than returning null when the head is not a primitive string.
 * Returning null meant "unrecognised", and every caller read that as "nothing
 * to guard" — see the note on `commandShapeProblem` above. A head that is not
 * a string is a command nobody can police, so it does not run.
 *
 * `['bogus-prefix','set',…]` is NOT this case: the head is a string, so the
 * verb is `bogus-prefix`, it matches no table, and mpv rejects it on its own.
 */
export function verbOf(args: readonly unknown[]): { verb: string; at: number } | null {
  // THE SINGLE CHOKE POINT. `isChainCommand`, `isBannedCommand`, `commandNameOf`
  // and both halves of `propertiesWrittenBy` all funnel through here, so the
  // shape check belongs here rather than in each of them:
  // `['set', new String('speed'), 4]` has a legal head and fails only on the
  // boxed PROPERTY NAME, which a head-only check misses in exactly the guard
  // that mattered.
  assertCommandShape(args)
  let at = 0
  let head = args[at]
  if (typeof head !== 'string') {
    // Shape-legal but still not a string head: a plain object or a number in
    // position 0. mpv cannot execute it and no guard can read it.
    throw new ContributionError(
      `an mpv command must start with a command NAME; argument 0 is ${typeof head}. ` +
        `This used to return null, which every guard read as 'nothing to check'.`
    )
  }

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
/**
 * Properties a command names OUTRIGHT: `['set','aid',2]`'s `aid`, and every key
 * in `loadfile`'s options map.
 *
 * These are ALWAYS ownership-checked, including for the module that owns the
 * command. `loadfile` is M28's, and its options argument was measured to set any
 * property you like (`['loadfile', f, 'replace', 0, 'speed=2.5']` really set
 * speed to 2.5) — so "M28 owns loadfile" must never become "M28 may write
 * anything".
 */
export function explicitPropertiesWrittenBy(args: readonly unknown[]): string[] {
  // The shape is checked inside `verbOf`, which every guard in this file goes
  // through. `['set', new String('speed'), 4]` is the case that matters here:
  // the head was fine, only the property NAME was boxed, and the
  // `typeof name === 'string'` test below returned an empty list — so the write
  // was ownership-checked against nothing and mpv received `["set","speed",4]`.
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

/**
 * Properties a command writes WITHOUT naming them, from COMMAND_SIDE_EFFECTS.
 *
 * These are checked for everyone EXCEPT the module that owns the command, and
 * the asymmetry is the whole design:
 *
 *   - An unrelated module issuing `['frame-step']` is refused, because it does
 *     not own `frame-step`. That is the bug this table was written for.
 *   - M24, which DOES own `frame-step`, is allowed the `pause` write that comes
 *     with it. Refusing it would mean nobody could frame-step at all, since
 *     `pause` is core's and always will be.
 *
 * The decision about who may cause a given side effect is therefore made ONCE,
 * in `modules.json`, where `commands.test.ts` checks it — a module owning a
 * command whose side effect lands in a THIRD module's property has to declare
 * that property in `requestsProperties` and the holder has to answer for it.
 * It is not re-litigated per call, where the only available answer is "drop it
 * silently".
 */
export function impliedPropertiesWrittenBy(args: readonly unknown[]): string[] {
  const found = verbOf(args)
  if (!found) return []
  return [...(COMMAND_SIDE_EFFECTS[canonicalCommand(found.verb)] ?? [])]
}

/** Every property a command writes, named or not. */
export function propertiesWrittenBy(args: readonly unknown[]): string[] {
  const explicit = explicitPropertiesWrittenBy(args)
  return explicit.length > 0 ? explicit : impliedPropertiesWrittenBy(args)
}

/**
 * The properties `MpvService.command()` must ownership-check for this caller.
 *
 * Pure, and split out of the bus on purpose: this one boolean is the difference
 * between "seeking works" and "resume silently stopped working in packaged
 * builds", and that is not a decision that should only be reachable through
 * Electron. See `impliedPropertiesWrittenBy` for why the owner is exempt from
 * the implied set and never from the explicit one.
 */
export function propertiesNeedingOwnership(
  args: readonly unknown[],
  ownsCommand: boolean
): string[] {
  const explicit = explicitPropertiesWrittenBy(args)
  return ownsCommand ? explicit : [...explicit, ...impliedPropertiesWrittenBy(args)]
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
