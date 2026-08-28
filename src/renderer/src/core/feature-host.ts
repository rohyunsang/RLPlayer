import type { OsdKind, SettingSection, Unsubscribe } from '../../../shared/feature-api.ts'
import type {
  RendererFeatureContext,
  RendererFeatureModule,
  SeekbarLayer,
  SettingBinding,
  StatsSection,
  TransportButton
} from '../../../shared/renderer-api.ts'
import type { PlayerState } from '../../../shared/types.ts'

/**
 * The renderer-side registry: state fan-out, the five contribution registries,
 * the per-module context and the loader.
 *
 * Deliberately free of `import.meta.glob`, of the DOM hosts and of anything
 * Electron, so `node --test` can exercise the real implementation rather than a
 * copy of it. `core/index.ts` supplies the glob and the bridge; the DOM hosts in
 * `panel-host.ts` / `stats-host.ts` / `settings-form.ts` read the registries
 * below. A contribution with no consumer is decoration, and this file is the
 * half the consumers are built on.
 */

// --- state ----------------------------------------------------------------

let currentState: PlayerState | null = null
const stateSubscribers = new Set<(s: PlayerState) => void>()

export function publishState(s: PlayerState): void {
  currentState = s
  for (const cb of [...stateSubscribers]) {
    try {
      cb(s)
    } catch (e) {
      console.error('[renderer-core] state subscriber threw:', e)
    }
  }
}

export function getState(): PlayerState | null {
  return currentState
}

// --- contribution registries ----------------------------------------------

export interface PanelSpec {
  id: string
  side: 'left' | 'right' | 'bottom'
  titleKey: string
  order: number
  mount(el: HTMLElement): () => void
}

export interface SettingsSectionSpec {
  id: string
  section: SettingSection
  order: number
  titleKey: string
  mount(el: HTMLElement): () => void
}

export type SettingsComponentMount = (el: HTMLElement, api: SettingBinding) => () => void

export const panels: PanelSpec[] = []
/** `ctx.transportButton()`, consumed by `transport-host.ts`. */
export const transportButtons: TransportButton[] = []
export const statsSections: StatsSection[] = []
export const settingsSections: SettingsSectionSpec[] = []
export const settingsComponents = new Map<string, SettingsComponentMount>()

/**
 * The hosts mount whatever is registered when they are created, and then have
 * to hear about anything registered later — a module set up after the host, or
 * a module in a window that builds its chrome first. One listener list per
 * registry, rather than a re-render-everything broadcast, so a late panel does
 * not tear down a live one.
 */
type RegistryListener = () => void
const registryListeners = new Set<RegistryListener>()

export function onContributionsChanged(cb: RegistryListener): Unsubscribe {
  registryListeners.add(cb)
  return () => registryListeners.delete(cb)
}

function announce(): void {
  for (const cb of [...registryListeners]) {
    try {
      cb()
    } catch (e) {
      console.error('[renderer-core] contribution listener threw:', e)
    }
  }
}

// --- seek bar -------------------------------------------------------------

export interface SeekbarRegistrar {
  register(l: SeekbarLayer): void
}

let seekbarHost: SeekbarRegistrar | null = null
/** Layers registered before the bar exists are queued rather than dropped. */
const pendingLayers: SeekbarLayer[] = []

export function setSeekbarHost(host: SeekbarRegistrar): void {
  seekbarHost = host
  for (const l of pendingLayers.splice(0)) host.register(l)
}

export function getSeekbarHost(): SeekbarRegistrar | null {
  return seekbarHost
}

// --- i18n (renderer half) -------------------------------------------------

const messages = new Map<string, string>()

export function registerRendererMessages(m: Record<string, string>): void {
  for (const [k, v] of Object.entries(m)) messages.set(k, v)
}

/**
 * Fetch the catalog, with a few retries.
 *
 * Both windows start loading the moment `createWindows()` runs, which is before
 * main has finished wiring its IPC handlers, so the very first invoke can lose
 * a race it did not know it was in. Main registers the core handlers early now,
 * but "early" is not "synchronously with window creation": the honest fix is
 * for the renderer to accept that main comes up too, and to retry briefly
 * rather than render every label as its own message key for the session.
 */
export async function fetchMessages(
  invoke: (channel: string) => Promise<unknown>,
  attempts = 10,
  delayMs = 100
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const m = (await invoke('core-i18n:messages')) as Record<string, string>
      if (m && Object.keys(m).length > 0) {
        registerRendererMessages(m)
        return true
      }
    } catch {
      /* main is not up yet */
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = messages.get(key) ?? key
  if (!params) return raw
  return raw.replace(/\{([^{}]+)\}/g, (_m, name: string) => String(params[name] ?? ''))
}

// --- osd ------------------------------------------------------------------

type OsdSink = (m: { kind: OsdKind; text: string; value?: number }) => void
let osdSink: OsdSink = () => {}

export function setOsdSink(fn: OsdSink): void {
  osdSink = fn
}

// --- context --------------------------------------------------------------

/** The shape `window.rl` exposes; injected so this file needs no globals. */
export interface RendererBridge {
  invoke(channel: string, req?: unknown): Promise<unknown>
  send(channel: string, req?: unknown): void
  on(channel: string, cb: (payload: unknown) => void): () => void
}

/** Which window a module's renderer half is being set up in. */
export type Surface = 'player' | 'settings'

/** Renderer channels are namespaced exactly like the main side's. */
export function assertNamespace(id: string, channel: string): void {
  if (!channel.startsWith(`${id}:`)) {
    throw new Error(
      `renderer module '${id}' used channel '${channel}', which is outside its namespace.`
    )
  }
}

export function createContext(
  id: string,
  bridge: RendererBridge,
  surface: Surface
): RendererFeatureContext {
  return {
    id,
    surface,
    ipc: {
      invoke<Req, Res>(ch: string, r?: Req): Promise<Res> {
        assertNamespace(id, ch)
        return bridge.invoke(ch, r) as Promise<Res>
      },
      send<Req>(ch: string, r?: Req): void {
        assertNamespace(id, ch)
        bridge.send(ch, r)
      },
      on<T>(ch: string, cb: (p: T) => void): Unsubscribe {
        assertNamespace(id, ch)
        return bridge.on(ch, cb as (p: unknown) => void)
      }
    },
    state: {
      get: () => currentState,
      subscribe(cb): Unsubscribe {
        stateSubscribers.add(cb)
        // Replayed SYNCHRONOUSLY so a module that registers late is not blind
        // until the next push. Module authors: everything your subscriber
        // closes over must already exist at the point you subscribe.
        if (currentState) cb(currentState)
        return () => stateSubscribers.delete(cb)
      }
    },
    t,
    panel(p): void {
      panels.push(p as PanelSpec)
      panels.sort((a, b) => a.order - b.order)
      announce()
    },
    seekbarLayer(l): void {
      if (seekbarHost) seekbarHost.register(l)
      else pendingLayers.push(l)
    },
    transportButton(b): void {
      if (transportButtons.some((x) => x.id === b.id)) {
        throw new Error(`duplicate transport button id '${b.id}'`)
      }
      transportButtons.push(b)
      transportButtons.sort((a, x) => a.order - x.order)
      announce()
    },
    statsSection(s): void {
      statsSections.push(s)
      statsSections.sort((a, b) => a.order - b.order)
      announce()
    },
    settingsSection(s): void {
      settingsSections.push(s as SettingsSectionSpec)
      settingsSections.sort((a, b) => a.order - b.order)
      announce()
    },
    settingsComponent(name, mount): void {
      settingsComponents.set(name, mount)
      announce()
    },
    osd: { show: (m) => osdSink(m) }
  }
}

// --- loader ---------------------------------------------------------------

export interface DiscoveredRendererModule {
  /** The glob key, e.g. '../features/playlist/index.ts'. */
  file: string
  module: RendererFeatureModule | undefined
}

/**
 * Set once the modules have been set up. `loadModules` is IDEMPOTENT: a second
 * call returns the same list instead of running every `setup()` again.
 *
 * That guard is load-bearing, not decoration. A stray duplicate call re-runs
 * every module's `setup()`, and because `state.subscribe` replays the last
 * state synchronously, the re-entrant run executes module code in a state the
 * first run never saw. One such duplicate — spliced inside the overlay's
 * `keydown` handler — leaked a permanently throwing state subscriber on every
 * single keypress. Loading features is a boot step; it happens once.
 */
let loaded: RendererFeatureModule[] | null = null

export function loadModules(
  discovered: readonly DiscoveredRendererModule[],
  makeContext: (id: string) => RendererFeatureContext
): RendererFeatureModule[] {
  if (loaded) return loaded
  const out: RendererFeatureModule[] = []
  loaded = out
  for (const { file, module } of discovered) {
    if (!module) continue
    const dir = file.split('/').at(-2) ?? ''
    if (module.id !== dir) {
      console.error(`[renderer-core] module id '${module.id}' does not match directory '${dir}'`)
      continue
    }
    try {
      module.setup(makeContext(module.id))
      out.push(module)
    } catch (e) {
      // Isolation, same rule as main: one broken renderer half must not take
      // the whole overlay down.
      console.error(`[renderer-core] '${module.id}' setup failed:`, e)
    }
  }
  announce()
  return out
}

/** Tests only: forget every registration so each case starts clean. */
export function __resetForTests(): void {
  loaded = null
  currentState = null
  stateSubscribers.clear()
  panels.length = 0
  transportButtons.length = 0
  statsSections.length = 0
  settingsSections.length = 0
  settingsComponents.clear()
  registryListeners.clear()
  pendingLayers.length = 0
  seekbarHost = null
  messages.clear()
  osdSink = () => {}
}
