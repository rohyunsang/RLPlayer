import type { OsdKind, PanelId, Unsubscribe } from '../../../shared/feature-api.ts'
import type {
  RendererFeatureContext,
  RendererFeatureModule,
  SeekbarLayer,
  SettingBinding,
  StatsSection
} from '../../../shared/renderer-api.ts'
import type { PlayerState } from '../../../shared/types.ts'
import { SeekbarHost } from './seekbar-host.ts'

/**
 * The renderer-side core hosts (§5.8). WAVE 0 — FROZEN.
 *
 * Same discovery rule as the main process: a renderer half is a directory under
 * `src/renderer/src/features/<same-id>/`, found by a glob, and there is no list
 * to edit. A module with no UI simply has no renderer half.
 */

const mods = import.meta.glob<{ default: RendererFeatureModule }>('../features/*/index.ts', {
  eager: true
})

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

// --- hosts ----------------------------------------------------------------

export interface PanelSpec {
  id: PanelId
  side: 'left' | 'right' | 'bottom'
  titleKey: string
  order: number
  mount(el: HTMLElement): () => void
}

export interface SettingsSectionSpec {
  id: string
  section: string
  order: number
  titleKey: string
  mount(el: HTMLElement): () => void
}

export const panels: PanelSpec[] = []
export const statsSections: StatsSection[] = []
export const settingsSections: SettingsSectionSpec[] = []
export const settingsComponents = new Map<
  string,
  (el: HTMLElement, api: SettingBinding) => () => void
>()

let seekbarHost: SeekbarHost | null = null
/** Layers registered before the bar exists are queued rather than dropped. */
const pendingLayers: SeekbarLayer[] = []

export function attachSeekbar(host: SeekbarHost): SeekbarHost {
  seekbarHost = host
  for (const l of pendingLayers.splice(0)) host.register(l)
  return host
}

export function getSeekbar(): SeekbarHost | null {
  return seekbarHost
}

// --- i18n (renderer half) -------------------------------------------------

const messages = new Map<string, string>()

export function registerRendererMessages(m: Record<string, string>): void {
  for (const [k, v] of Object.entries(m)) messages.set(k, v)
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

// --- context + loader -----------------------------------------------------

function createContext(id: string): RendererFeatureContext {
  const bridge = window.rl
  return {
    id,
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
        if (currentState) cb(currentState)
        return () => stateSubscribers.delete(cb)
      }
    },
    t,
    panel(p): void {
      panels.push(p)
      panels.sort((a, b) => a.order - b.order)
    },
    seekbarLayer(l): void {
      if (seekbarHost) seekbarHost.register(l)
      else pendingLayers.push(l)
    },
    statsSection(s): void {
      statsSections.push(s)
      statsSections.sort((a, b) => a.order - b.order)
    },
    settingsSection(s): void {
      settingsSections.push(s as SettingsSectionSpec)
      settingsSections.sort((a, b) => a.order - b.order)
    },
    settingsComponent(name, mount): void {
      settingsComponents.set(name, mount)
    },
    osd: { show: (m) => osdSink(m) }
  }
}

/** Renderer channels are namespaced exactly like the main side's. */
function assertNamespace(id: string, channel: string): void {
  if (!channel.startsWith(`${id}:`)) {
    throw new Error(
      `renderer module '${id}' used channel '${channel}', which is outside its namespace.`
    )
  }
}

export function loadRendererFeatures(): RendererFeatureModule[] {
  const loaded: RendererFeatureModule[] = []
  for (const [file, mod] of Object.entries(mods)) {
    const module = mod?.default
    if (!module) continue
    const dir = file.split('/').at(-2) ?? ''
    if (module.id !== dir) {
      console.error(`[renderer-core] module id '${module.id}' does not match directory '${dir}'`)
      continue
    }
    try {
      module.setup(createContext(module.id))
      loaded.push(module)
    } catch (e) {
      // Isolation, same rule as main: one broken renderer half must not take
      // the whole overlay down.
      console.error(`[renderer-core] '${module.id}' setup failed:`, e)
    }
  }
  return loaded
}

export { SeekbarHost }
