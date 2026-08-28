import { app } from 'electron'
import { MpvManager, CORE_OBSERVED } from '../../mpv/manager'
import {
  OwnerMap,
  commandNameOf,
  isBannedCommand,
  isChainCommand,
  propertiesNeedingOwnership
} from './ownership.ts'
import { composeArgs, validateArgContributions, type ArgContribution } from './reserved.ts'
import { ContributionError } from '../errors.ts'
import type { FeatureId, MpvService, Unsubscribe } from '@shared/feature-api'
import type { PlayerState } from '@shared/types'

/**
 * core/mpv/bus — the property-observation bus and the only way to talk to mpv
 * (§5.3). WAVE 0 — FROZEN.
 *
 * WHY THERE IS NO `mpvBus` EXPORT ANY MORE.
 *
 * There used to be one, and it made every ownership guard in this file
 * decorative. All of these were measured to LAND A WRITE in the live mpv, from
 * a file under `src/main/features/`, in one line each:
 *
 *     mpvBus.createService('victim').set('speed', 1.5)        // any id, no flag
 *     mpvBus.createService('core/mpv/bus')                    // core's own id
 *     mpvBus.createService('x', { privileged: true })         // just ask
 *     mpvBus.setOwnerMap(new OwnerMap([{ id: 'me', ownsProperties: ['a*'] }]))
 *     mpvBus.contributeArgs('core/mpv/bus', 0, () => ['--speed=4'])
 *     mpvBus.chainExec(['vf', 'set', 'hflip'])
 *
 * The `setOwnerMap` one disarmed all thirty-eight of the hardened attacks at
 * once, and the legitimate owner was then refused its own property. The only
 * barrier was `check-forbidden.mjs`, whose import regex was `from '...'` — so
 * `await import('../../core/mpv/bus.ts')` escalated fully and the grep printed
 * "clean (90 files scanned)" and exited 0.
 *
 * A `#private` field was not the answer: the FACTORY that mints services was
 * public, and a public factory that takes the caller's word for who it is is
 * not an ownership system, it is a suggestion. So:
 *
 *   - the class is not exported and the instance is not exported;
 *   - `createMpvBus()` creates it EXACTLY ONCE and throws on a second call, so
 *     `await import(...)` from a module gets a function that refuses;
 *   - the only MpvService a module can ever hold is the one `core/registry`
 *     hands it, with its own id baked in, and the id is checked against the
 *     set of modules the registry actually loaded;
 *   - `privileged` is granted only to three hard-coded core ids, and asking
 *     for it under any other id throws rather than being believed.
 *
 * Bypassing this now requires editing a file under `src/main/core/`, which is
 * what `check:partition` and the extended grep are for. That is the difference
 * between a boundary and a reminder.
 */

const CORE_ID = 'core/mpv/bus'
const RESTART_DEBOUNCE_MS = 250

/**
 * The only ids that may ever hold a privileged service.
 *
 * A hard-coded set rather than a flag on the call, because
 * `createService(id, { privileged: true })` used to be exactly as easy to type
 * from a feature module as from core, and was believed either way.
 */
const PRIVILEGED_IDS: ReadonlySet<string> = new Set([CORE_ID, 'core/vf-chain', 'core/af-chain'])

type PropertyCb = (value: unknown) => void
type EventCb = (msg: Record<string, unknown>) => void
type Arbiter = (
  value: unknown,
  req: { from: FeatureId; reason: string }
) => Promise<{ ok: true } | { ok: false; reason: string }>

interface Observation {
  observeId: number | null
  cbs: Set<PropertyCb>
}

export interface BusHost {
  /** The HWND mpv embeds into, re-read on every (re)spawn. */
  hwnd(): string
  /** Core spawn args other than --wid and --input-ipc-server. */
  baseArgs(): string[]
  toast(message: string, kind: 'info' | 'error'): void
}

class MpvBus {
  /**
   * PRIVATE, and with a `#` rather than a `private` keyword so it is private at
   * RUNTIME too.
   *
   * It used to be `readonly manager = new MpvManager()` on the exported
   * `mpvBus` singleton, which meant every ownership check in this file could be
   * walked around in one line:
   *
   *     import { mpvBus } from '../../core/mpv/bus.ts'
   *     mpvBus.manager.client.setProperty('aid', 2)
   *
   * `check-forbidden.mjs` did not grep for `core/mpv/*` either, so nothing
   * caught it at any layer. The grep is extended now, but a grep is a
   * reminder — this is the boundary. Everything core legitimately needs is a
   * narrow method below; there is no longer a public path from the singleton to
   * `client.setProperty` or to an arbitrary `client.command`.
   */
  readonly #manager = new MpvManager()

  private readonly observations = new Map<string, Observation>()
  private readonly cache = new Map<string, unknown>()
  private readonly eventCbs = new Map<string, Set<EventCb>>()
  private readonly fileLoadedCbs = new Set<(path: string) => void | Promise<void>>()
  private readonly contributions: Array<{ ownerId: string; priority: number; fn: () => string[] }> =
    []
  private readonly arbiters = new Map<string, { owner: string; fn: Arbiter }>()
  private readonly chainHooks: Array<{ onFileLoaded(): void; onUnload(): void }> = []

  private owners: OwnerMap | null = null
  /** The ids the registry actually loaded. `createService` refuses anything else. */
  private knownIds: ReadonlySet<string> = new Set()
  private host: BusHost | null = null
  private awaitingFirstFrame = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartReason = ''
  private started = false
  private refusalHook: ((moduleId: string, detail: string) => void) | null = null
  private refusalSeen = false

  // --- wiring ------------------------------------------------------------

  attachHost(host: BusHost): void {
    this.host = host
  }

  /**
   * Installed ONCE, by `core/registry` at boot.
   *
   * A module used to be able to call this with an OwnerMap claiming `a*`…`z*`
   * and take over every property in the app; the legitimate owner was then
   * refused its own writes. There is no path to it from a module any more (the
   * bus is not exported), and a second call throws so a core file cannot do it
   * by accident either.
   */
  setOwnerMap(map: OwnerMap, moduleIds: readonly string[]): void {
    if (this.owners) {
      throw new ContributionError(
        'the mpv owner map is installed exactly once, at boot, by core/registry.'
      )
    }
    this.owners = map
    this.knownIds = new Set(moduleIds)
    // The owner map's hint text depends on whether an arbiter EXISTS, and only
    // the bus knows that. Without this, the OwnershipError told developers to
    // call `requestSet` for properties whose owner had never registered one.
    map.setArbiterProbe((property) => this.arbiters.has(property))
  }

  /**
   * A dropped write in a SHIPPED build used to vanish: `refusalCount` was never
   * read anywhere in `src/`, so the "surfaced in stats" comment was false and a
   * module quietly corrupting nothing was indistinguishable from a module
   * working. The first one now reaches the user's screen once, and every one of
   * them reaches the stats overlay, so a bug report can name the module.
   */
  private noteRefusal(moduleId: string, detail: string): void {
    if (this.refusalSeen) return
    this.refusalSeen = true
    this.refusalHook?.(moduleId, detail)
  }

  /**
   * Wires one filter chain to mpv and hands it the only raw `vf`/`af` exec that
   * exists. Called by `core/registry`; the chain keeps it in a closure and
   * never exposes it.
   */
  registerChain(chain: {
    onFileLoaded(): void
    onUnload(): void
    attachExec(exec: { command(args: unknown[]): Promise<unknown> }): void
  }): void {
    this.chainHooks.push(chain)
    chain.attachExec({ command: (args) => this.chainExec(args) })
  }

  /**
   * PRIVATE to this file. It is reached only through `MpvService.contributeArgs`,
   * which supplies the bound id; passing `'core/mpv/bus'` here used to buy a
   * module the `reserved.ts` exemptions and with them `--speed=4`, `--wid=999`,
   * `--vo=gpu` and `--fullscreen`.
   */
  private contributeArgs(ownerId: string, priority: number, fn: () => string[]): void {
    if (ownerId !== CORE_ID && (priority <= 0 || priority >= 1000)) {
      throw new ContributionError(
        `module '${ownerId}' contributed spawn args at priority ${priority}. ` +
          `Core reserves 0 and 1000; use 1..999.`
      )
    }
    this.contributions.push({ ownerId, priority, fn })
  }

  /** Evaluate every contributor once, at boot, and reject collisions (§3.3.1). */
  private collect(): ArgContribution[] {
    const base: ArgContribution[] = [
      { ownerId: CORE_ID, priority: 0, args: this.host?.baseArgs() ?? [] }
    ]
    for (const c of this.contributions) {
      let args: string[] = []
      try {
        args = c.fn()
      } catch (e) {
        // A contributor that throws must not stop mpv from starting.
        console.error(`[mpv-bus] ${c.ownerId} contributeArgs threw:`, (e as Error).message)
        continue
      }
      base.push({ ownerId: c.ownerId, priority: c.priority, args })
    }
    // The owner map is the fourth arg check (§4): an option follows its
    // property's owner. Passing it here is what turns that rule from prose in
    // the guide into a boot error naming both modules.
    validateArgContributions(base, (property) => this.owners?.ownerOf(property) ?? null)
    return base
  }

  /** Run the arg checks without spawning. Used at boot and by test:reserved-args. */
  validateContributions(): void {
    this.collect()
  }

  async start(): Promise<void> {
    const host = this.host
    if (!host) throw new Error('MpvBus.start() before attachHost()')
    const argv = [`--wid=${host.hwnd()}`, ...composeArgs(this.collect())]
    await this.#manager.start(argv)
    this.wireClient()
    this.started = true
    await this.resubscribeAll()
  }

  private wireClient(): void {
    const client = this.#manager.client
    client.on('property-change', (name: string, data: unknown) => {
      this.cache.set(name, data)
      this.#manager.applyProperty(name, data)
      const obs = this.observations.get(name)
      if (!obs) return
      for (const cb of [...obs.cbs]) {
        try {
          cb(data)
        } catch (e) {
          console.error(`[mpv-bus] observer for '${name}' threw:`, (e as Error).message)
        }
      }
    })
    client.on('mpv-event', (event: string, msg: Record<string, unknown>) => {
      if (event === 'start-file') {
        this.awaitingFirstFrame = true
        for (const c of this.chainHooks) c.onUnload()
      }
      if (event === 'file-loaded') {
        for (const c of this.chainHooks) c.onFileLoaded()
      }
      if (event === 'playback-restart' && this.awaitingFirstFrame) {
        this.awaitingFirstFrame = false
        void this.fireFileLoaded()
      }
      for (const cb of [...(this.eventCbs.get(event) ?? [])]) {
        try {
          cb(msg)
        } catch (e) {
          console.error(`[mpv-bus] '${event}' handler threw:`, (e as Error).message)
        }
      }
    })
  }

  /**
   * §3.3.1: property writes made before `playback-restart` are DROPPED by mpv,
   * so every per-file restore hangs off this and not off `file-loaded`.
   * Each callback is isolated: one module's bad restore must not abort the rest.
   */
  private async fireFileLoaded(): Promise<void> {
    const path = (this.cache.get('path') as string | undefined) ?? ''
    for (const cb of [...this.fileLoadedCbs]) {
      try {
        await cb(path)
      } catch (e) {
        console.error('[mpv-bus] afterFileLoaded handler threw:', (e as Error).message)
      }
    }
  }

  private async resubscribeAll(): Promise<void> {
    for (const name of CORE_OBSERVED) this.ensureObservation(name)
    for (const [name, obs] of this.observations) {
      if (obs.observeId !== null) continue
      try {
        obs.observeId = await this.#manager.client.observeProperty(name)
      } catch {
        /* mpv rejects unknown property names; the observer simply never fires */
      }
    }
  }

  private ensureObservation(name: string): Observation {
    let obs = this.observations.get(name)
    if (!obs) {
      obs = { observeId: null, cbs: new Set() }
      this.observations.set(name, obs)
    }
    return obs
  }

  // --- the primitives the per-module service is built on ------------------

  observe(name: string, cb: PropertyCb): Unsubscribe {
    const obs = this.ensureObservation(name)
    const first = obs.observeId === null
    obs.cbs.add(cb)
    if (first && this.started) {
      void this.#manager.client
        .observeProperty(name)
        .then((id) => {
          obs.observeId = id
        })
        .catch(() => {})
    }
    // Fire immediately with the cached value so a late module is not blind
    // until the property next changes.
    if (this.cache.has(name)) {
      try {
        cb(this.cache.get(name))
      } catch {
        /* isolated */
      }
    }
    return () => {
      obs.cbs.delete(cb)
      if (obs.cbs.size > 0) return
      // Core's own PlayerState subscriptions keep these alive; only a property
      // nothing else wants goes back off the wire.
      if ((CORE_OBSERVED as readonly string[]).includes(name)) return
      const id = obs.observeId
      obs.observeId = null
      this.observations.delete(name)
      if (id !== null && this.started) void this.#manager.client.unobserveProperty(id)
    }
  }

  peek(name: string): unknown {
    return this.cache.get(name)
  }

  onEvent(event: string, cb: EventCb): Unsubscribe {
    let set = this.eventCbs.get(event)
    if (!set) {
      set = new Set()
      this.eventCbs.set(event, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  }

  afterFileLoaded(cb: (path: string) => void | Promise<void>): Unsubscribe {
    this.fileLoadedCbs.add(cb)
    return () => this.fileLoadedCbs.delete(cb)
  }

  get isNetworkSource(): boolean {
    return this.cache.get('demuxer-via-network') === true
  }

  requestRestart(reason: string): void {
    this.restartReason = reason
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.respawn(this.restartReason)
    }, RESTART_DEBOUNCE_MS)
  }

  private async respawn(reason: string): Promise<void> {
    const host = this.host
    if (!host || !this.started) return
    const path = this.cache.get('path') as string | undefined
    const at = this.cache.get('time-pos') as number | undefined
    host.toast(`재생 엔진을 다시 시작합니다 (${reason})`, 'info')
    try {
      await this.#manager.shutdown()
      for (const obs of this.observations.values()) obs.observeId = null
      this.cache.clear()
      await this.start()
      if (path) await this.#manager.loadFile(path, at)
    } catch (e) {
      host.toast(`재생 엔진 재시작 실패: ${(e as Error).message}`, 'error')
    }
  }

  /**
   * The quit path. AWAITABLE, because the old one was not.
   *
   * `dispose()` was synchronous and its only kill was a `setTimeout` inside
   * `before-quit` that almost never fired. Returning a promise lets main's quit
   * hook actually wait for mpv to be gone before it calls `app.exit()`, which
   * is the difference between "usually no orphan" and "no orphan".
   */
  async shutdown(): Promise<{ orphaned: boolean }> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.started = false
    const r = await this.#manager.terminate()
    return { orphaned: r.orphaned }
  }

  /** Fire-and-forget, for paths that cannot await (a crash handler). */
  dispose(): void {
    void this.shutdown()
  }

  // --- the narrow surface core needs, and nothing wider -------------------

  /** The derived PlayerState the overlay paints. Read by main's pushState. */
  get playerState(): PlayerState {
    return this.#manager.state
  }

  /** Manager lifecycle events ('state', 'crashed'), for main's wiring. */
  onManager(event: 'state' | 'crashed', cb: (...args: never[]) => void): void {
    this.#manager.on(event, cb as (...a: unknown[]) => void)
  }

  /**
   * The raw exec the two filter chains need, and ONLY they.
   *
   * The old `chainExec` was a PUBLIC method on the exported singleton, and its
   * own comment claimed that importing the bus and calling it "buys a module
   * exactly nothing". It bought `mpvBus.chainExec(['vf','set','hflip'])` — a
   * filter-chain write that bypassed `core/vf-chain`'s label arbitration
   * entirely, which is the one thing §0.2 rule 5 exists to prevent. The
   * "refuses anything that is not a chain command" guard was the problem, not
   * the protection: a chain command is precisely what the attacker wanted.
   *
   * It is minted per chain now, by `registerChain`, and there is no way to ask
   * for one from outside this file.
   */
  private chainExec<T>(args: unknown[]): Promise<T> {
    if (!isChainCommand(args)) {
      throw new ContributionError(
        `the chain exec is for vf/af commands only; '${String(args[0])}' is not one.`
      )
    }
    return this.#manager.client.command<T>(args)
  }

  /** Refusal counts, for the stats overlay and for a bug report (§3.5 rule 5). */
  refusals(): Array<{ moduleId: string; count: number }> {
    return this.owners?.refusalEntries() ?? []
  }

  /** Called the first time a packaged build drops a foreign write. */
  onFirstRefusal(cb: (moduleId: string, property: string) => void): void {
    this.refusalHook = cb
  }

  // --- the per-module facade ---------------------------------------------

  /**
   * The ONLY MpvService any module ever sees, minted by `core/registry` with the
   * module's own id baked in.
   *
   * It now VALIDATES, which it did not before: `createService('victim')` and
   * `createService('core/mpv/bus')` both used to return a working service that
   * wrote whatever that id owned, and `{ privileged: true }` was granted to
   * anyone who typed it.
   */
  createService(ownerId: FeatureId, opts?: { privileged?: boolean }): MpvService {
    const bus = this
    const strict = !app.isPackaged
    const privileged = opts?.privileged === true

    if (privileged && !PRIVILEGED_IDS.has(ownerId)) {
      throw new ContributionError(
        `'${ownerId}' asked for a privileged mpv service. Privilege is not a flag a caller ` +
          `sets: it belongs to ${[...PRIVILEGED_IDS].join(', ')} and to nothing else.`
      )
    }
    if (!privileged && !PRIVILEGED_IDS.has(ownerId) && !bus.knownIds.has(ownerId)) {
      throw new ContributionError(
        `'${ownerId}' is not a module core/registry loaded. A service is minted for a module ` +
          `by the registry, once, with its own id — an id is not something a caller supplies.`
      )
    }

    const log = (m: string): void => {
      console.error(m)
      bus.noteRefusal(ownerId, m)
    }

    const checkWrite = (property: string): boolean => {
      // Core pieces hold their own properties (§3.7) and the two chains write
      // exactly one each; `privileged` covers the handful of core writes that
      // predate the owner map, such as the respawn path.
      if (privileged || !bus.owners) return true
      return bus.owners.assertWrite(ownerId, property, strict, log)
    }

    /**
     * Every guard a command has to pass, in one place so `command` and
     * `commandNoReply` cannot drift apart — which is how `commandNoReply` came
     * to skip the chain THROW and merely return.
     */
    const checkCommand = (args: unknown[]): boolean => {
      // Banned outright, privileged or not: screenshot-raw kills mpv over the
      // JSON IPC pipe (§7.7 trap 5) and there is no correct use of it.
      if (isBannedCommand(args)) {
        throw new ContributionError(
          `'${String(commandNameOf(args))}' is never allowed over JSON IPC: it kills mpv ` +
            `(§7.7 trap 5). Use ctx.commands.invoke('capture-still.save') or screenshot-to-file.`
        )
      }
      if (privileged) return true
      if (isChainCommand(args)) {
        throw new ContributionError(
          `module '${ownerId}' issued a raw '${String(commandNameOf(args))}' command. Filter ` +
            `chains have exactly one owner each (§0.2 rule 5): use ctx.vf / ctx.af.`
        )
      }
      // A COMMAND can be owned too. `sub-reload` is the case that started this:
      // it was declared in M17's ownsProperties, where it did nothing, because
      // it is not a property at all (mpv answers 'property not found').
      const name = commandNameOf(args)
      if (name !== null && bus.owners && !bus.owners.assertCommand(ownerId, name, strict, log)) {
        return false
      }
      // Named properties are checked for EVERYONE (`loadfile` is M28's and its
      // options argument can set any property at all); side effects a command
      // does not name are the OWNER's to cause. See propertiesNeedingOwnership.
      const ownsThis = name !== null && bus.owners?.commandOwnerOf(name) === ownerId
      for (const prop of propertiesNeedingOwnership(args, ownsThis)) {
        if (!checkWrite(prop)) return false
      }
      return true
    }

    return {
      observe<T>(name: string, cb: (v: T | undefined) => void): Unsubscribe {
        return bus.observe(name, cb as PropertyCb)
      },
      peek<T>(name: string): T | undefined {
        return bus.peek(name) as T | undefined
      },
      get<T>(name: string): Promise<T> {
        return bus.#manager.client.getProperty<T>(name)
      },
      async set(name: string, value: unknown): Promise<void> {
        if (!checkWrite(name)) return
        await bus.#manager.client.setProperty(name, value)
      },
      async requestSet(name, value, reason) {
        if (bus.owners && !bus.owners.owns(ownerId, name) && !bus.owners.mayRequest(ownerId, name)) {
          return {
            ok: false,
            reason:
              `'${name}' is not in ${ownerId}'s requestsProperties. Declare it so the ` +
              `dependency is visible in review and in modules.json.`
          }
        }
        const arb = bus.arbiters.get(name)
        if (!arb) {
          // Never fall through to a raw write: a missing arbiter is a design
          // gap, and silently writing anyway is exactly the race §3.7 exists
          // to stop. The REASON says what to do about it, because 'no-arbiter'
          // on its own sent people back to the same call in a loop.
          const owner = bus.owners?.ownerOf(name) ?? 'nobody'
          return {
            ok: false,
            reason:
              `'${name}' is owned by ${owner}, which has not registered an arbiter for it. ` +
              `Call ${owner}'s mediator command instead, or open a one-line PR against ` +
              `${owner} adding ctx.mpv.arbitrate('${name}', …) in its setup(). ` +
              `Declaring it in requestsProperties is necessary but not sufficient.`
          }
        }
        try {
          return await arb.fn(value, { from: ownerId, reason })
        } catch (e) {
          return { ok: false, reason: (e as Error).message }
        }
      },
      arbitrate(name: string, fn: Arbiter): void {
        if (bus.owners && !privileged && !bus.owners.owns(ownerId, name)) {
          throw new ContributionError(
            `module '${ownerId}' registered an arbiter for '${name}', which it does not own ` +
              `(owner: ${bus.owners.ownerOf(name) ?? 'nobody'}).`
          )
        }
        const existing = bus.arbiters.get(name)
        if (existing && existing.owner !== ownerId) {
          throw new ContributionError(
            `duplicate arbiter for '${name}': '${existing.owner}' and '${ownerId}'.`
          )
        }
        bus.arbiters.set(name, { owner: ownerId, fn })
      },
      async command<T>(args: unknown[]): Promise<T> {
        if (!checkCommand(args)) return undefined as T
        return bus.#manager.client.command<T>(args)
      },
      commandNoReply(args: unknown[]): void {
        if (!checkCommand(args)) return
        bus.#manager.client.commandNoReply(args)
      },
      onEvent(event, cb) {
        return bus.onEvent(event, cb)
      },
      afterFileLoaded(cb) {
        return bus.afterFileLoaded(cb)
      },
      contributeArgs(priority: number, fn: () => string[]): void {
        bus.contributeArgs(ownerId, priority, fn)
      },
      requestRestart(reason: string): void {
        bus.requestRestart(reason)
      },
      get isNetworkSource(): boolean {
        return bus.isNetworkSource
      }
    }
  }
}

export type { MpvBus }

let created = false

/**
 * Creates THE bus. Exactly once, at boot, from `src/main/index.ts`.
 *
 * This is the whole of the ownership-bypass fix. There is no singleton to
 * import, so `await import('../../core/mpv/bus.ts')` from a feature module
 * yields this function and this function refuses — the escalation that used to
 * be one line is now a throw naming the API the caller should have used.
 */
export function createMpvBus(): MpvBus {
  if (created) {
    throw new ContributionError(
      'core/mpv/bus is created once, at boot, by src/main/index.ts. Everything a module ' +
        'does to mpv arrives on ctx.mpv, which core/registry mints with your id baked in. ' +
        'If you are reading this from a feature module, the API you want is in ' +
        'docs/parity/02-wave0-api.md.'
    )
  }
  created = true
  return new MpvBus()
}
