import { app } from 'electron'
import { MpvManager, CORE_OBSERVED } from '../../mpv/manager'
import { OwnerMap, isChainCommand, propertyWrittenBy } from './ownership.ts'
import { composeArgs, validateArgContributions, type ArgContribution } from './reserved.ts'
import { ContributionError } from '../errors.ts'
import type { FeatureId, MpvService, Unsubscribe } from '@shared/feature-api'

/**
 * core/mpv/bus — the property-observation bus and the only way to talk to mpv
 * (§5.3). WAVE 0 — FROZEN.
 *
 * Wraps `MpvManager`/`MpvClient`; it does not replace them. Everything a
 * module can do to mpv passes through `createService(id)`, which is where the
 * ownership check lives — so "mechanical property ownership" is not a
 * convention, it is the only code path that exists.
 */

const CORE_ID = 'core/mpv/bus'
const RESTART_DEBOUNCE_MS = 250

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

export class MpvBus {
  readonly manager = new MpvManager()

  private readonly observations = new Map<string, Observation>()
  private readonly cache = new Map<string, unknown>()
  private readonly eventCbs = new Map<string, Set<EventCb>>()
  private readonly fileLoadedCbs = new Set<(path: string) => void | Promise<void>>()
  private readonly contributions: Array<{ ownerId: string; priority: number; fn: () => string[] }> =
    []
  private readonly arbiters = new Map<string, { owner: string; fn: Arbiter }>()
  private readonly chainHooks: Array<{ onFileLoaded(): void; onUnload(): void }> = []

  private owners: OwnerMap | null = null
  private host: BusHost | null = null
  private awaitingFirstFrame = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartReason = ''
  private started = false

  // --- wiring ------------------------------------------------------------

  attachHost(host: BusHost): void {
    this.host = host
  }

  setOwnerMap(map: OwnerMap): void {
    this.owners = map
  }

  registerChain(chain: { onFileLoaded(): void; onUnload(): void }): void {
    this.chainHooks.push(chain)
  }

  contributeArgs(ownerId: string, priority: number, fn: () => string[]): void {
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
    validateArgContributions(base)
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
    await this.manager.start(argv)
    this.wireClient()
    this.started = true
    await this.resubscribeAll()
  }

  private wireClient(): void {
    const client = this.manager.client
    client.on('property-change', (name: string, data: unknown) => {
      this.cache.set(name, data)
      this.manager.applyProperty(name, data)
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
        obs.observeId = await this.manager.client.observeProperty(name)
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
      void this.manager.client
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
      if (id !== null && this.started) void this.manager.client.unobserveProperty(id)
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
      await this.manager.shutdown()
      for (const obs of this.observations.values()) obs.observeId = null
      this.cache.clear()
      await this.start()
      if (path) await this.manager.loadFile(path, at)
    } catch (e) {
      host.toast(`재생 엔진 재시작 실패: ${(e as Error).message}`, 'error')
    }
  }

  dispose(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.manager.dispose()
    this.started = false
  }

  // --- the per-module facade ---------------------------------------------

  /**
   * The ONLY MpvService any module ever sees. `ownerId` is baked in by the
   * registry, so a module cannot claim to be another one.
   *
   * `privileged` is granted to core pieces (the bus itself, the two filter
   * chains) that legitimately need to write their own properties.
   */
  createService(ownerId: FeatureId, opts?: { privileged?: boolean }): MpvService {
    const bus = this
    const strict = !app.isPackaged
    const privileged = opts?.privileged === true

    const checkWrite = (property: string): boolean => {
      // Core pieces hold their own properties (§3.7) and the two chains write
      // exactly one each; `privileged` covers the handful of core writes that
      // predate the owner map, such as the respawn path.
      if (privileged || !bus.owners) return true
      return bus.owners.assertWrite(ownerId, property, strict, (m) => console.error(m))
    }

    return {
      observe<T>(name: string, cb: (v: T | undefined) => void): Unsubscribe {
        return bus.observe(name, cb as PropertyCb)
      },
      peek<T>(name: string): T | undefined {
        return bus.peek(name) as T | undefined
      },
      get<T>(name: string): Promise<T> {
        return bus.manager.client.getProperty<T>(name)
      },
      async set(name: string, value: unknown): Promise<void> {
        if (!checkWrite(name)) return
        await bus.manager.client.setProperty(name, value)
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
          // to stop.
          return { ok: false, reason: 'no-arbiter' }
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
        if (!privileged && isChainCommand(args)) {
          throw new ContributionError(
            `module '${ownerId}' issued a raw '${String(args[0])}' command. Filter chains have ` +
              `exactly one owner each (§0.2 rule 5): use ctx.vf / ctx.af.`
          )
        }
        const prop = propertyWrittenBy(args)
        if (prop !== null && !privileged && !checkWrite(prop)) {
          return undefined as T
        }
        return bus.manager.client.command<T>(args)
      },
      commandNoReply(args: unknown[]): void {
        if (!privileged && isChainCommand(args)) return
        const prop = propertyWrittenBy(args)
        if (prop !== null && !privileged && !checkWrite(prop)) return
        bus.manager.client.commandNoReply(args)
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

export const mpvBus = new MpvBus()
