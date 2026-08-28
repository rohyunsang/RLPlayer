/**
 * The RENDERER half of the plugin API (§3.4). WAVE 0 — FROZEN.
 *
 * Split out of `feature-api.ts` because these interfaces mention `HTMLElement`,
 * and `feature-api.ts` is compiled under the MAIN tsconfig too, which carries
 * no DOM lib. `tsconfig.node.json` excludes this file; the renderer sees both.
 */

import type {
  FeatureId,
  IpcChannel,
  OsdKind,
  PanelId,
  SettingSection,
  Unsubscribe
} from './feature-api'
import type { PlayerState } from './types'

export interface SeekbarLayerCtx {
  readonly el: HTMLElement
  /** 0 or unknown for live streams — guard. */
  readonly duration: number
  readonly width: number
  timeToX(t: number): number
  xToTime(x: number): number
}

export interface SeekbarPointerEvent {
  readonly handle: string
  readonly x: number
  readonly time: number
  readonly shift: boolean
  readonly ctrl: boolean
  readonly alt: boolean
  preventDefault(): void
}

/** Hover carries a NULLABLE handle: the pointer may be over no handle at all,
 *  and an intersection type cannot widen `handle` back to null. */
export type SeekbarHoverEvent = Omit<SeekbarPointerEvent, 'handle'> & { handle: string | null }

export interface SeekbarLayer {
  id: string
  /** Paint order low→high; hit-test order is the reverse. */
  order: number
  render(ctx: SeekbarLayerCtx): void
  /** Interaction is opt-in: no hitTest means no pointer events at all. */
  hitTest?(ctx: SeekbarLayerCtx & { x: number; tolerancePx: number }): string | null
  onPointerDown?(e: SeekbarPointerEvent): void
  onPointerMove?(e: SeekbarPointerEvent): void
  onPointerUp?(e: SeekbarPointerEvent & { cancelled: boolean }): void
  /** Hit-test independent, throttled to one frame. `null` on leave. */
  onHover?(e: SeekbarHoverEvent | null): void
  tooltip?(e: SeekbarPointerEvent): { el: HTMLElement; order: number } | null
  onKey?(e: {
    handle: string
    key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
    stepSec: number
    shift: boolean
  }): void
}

export interface StatsSection {
  id: string
  order: number
  titleKey: string
  levels?: ReadonlyArray<'full' | 'short' | 'misc'>
  fields(): ReadonlyArray<{ labelKey: string; value: string }>
  refresh?:
    | { mode: 'static' }
    | { mode: 'onChange'; watch: readonly string[] }
    | { mode: 'poll'; intervalMs: number }
}

export interface SettingBinding {
  get<T>(): T
  set<T>(v: T): void
  onChange(cb: () => void): Unsubscribe
}

export interface RendererFeatureContext {
  readonly id: FeatureId
  /**
   * Which window this half is being set up in. The overlay and the settings
   * window run the SAME glob, so `setup()` is called once per surface; branch
   * on this rather than assuming there is only one renderer. `panel()` and
   * `seekbarLayer()` are ignored in the settings window, `settingsSection()`
   * and `settingsComponent()` are ignored in the player, so a module that just
   * registers everything is still correct — this exists for the expensive work.
   */
  readonly surface: 'player' | 'settings'
  readonly ipc: {
    invoke<Req, Res>(ch: IpcChannel, r?: Req): Promise<Res>
    send<Req>(ch: IpcChannel, r?: Req): void
    on<T>(ch: IpcChannel, cb: (p: T) => void): Unsubscribe
  }
  readonly state: {
    get(): PlayerState | null
    subscribe(cb: (s: PlayerState) => void): Unsubscribe
  }
  readonly t: (key: string, params?: Record<string, string | number>) => string
  panel(p: {
    id: PanelId
    side: 'left' | 'right' | 'bottom'
    titleKey: string
    order: number
    mount(el: HTMLElement): () => void
  }): void
  seekbarLayer(l: SeekbarLayer): void
  statsSection(s: StatsSection): void
  settingsSection(s: {
    id: string
    section: SettingSection
    order: number
    titleKey: string
    mount(el: HTMLElement): () => void
  }): void
  settingsComponent(name: string, mount: (el: HTMLElement, api: SettingBinding) => () => void): void
  readonly osd: { show(m: { kind: OsdKind; text: string; value?: number }): void }
}

export interface RendererFeatureModule {
  readonly id: FeatureId
  setup(ctx: RendererFeatureContext): void
  dispose?(): void
}
