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
  /**
   * The handle of THIS layer that currently has keyboard focus, or null.
   *
   * Paint the focus ring yourself: a handle you can Tab to but cannot see is
   * worse than one you cannot reach, because the arrow keys then move something
   * invisible. See rule 4 on `SeekbarHost`.
   */
  readonly focusedHandle: string | null
  timeToX(t: number): number
  xToTime(x: number): number
}

export interface SeekbarPointerEvent {
  /**
   * The handle of THIS layer under the pointer.
   *
   * Always a real handle on the pointer callbacks: they only fire for the layer
   * whose `hitTest` claimed the press. `onHover` and `tooltip` fire at EVERY
   * position, so they get `SeekbarUnclaimedEvent` instead — see why below.
   */
  readonly handle: string
  readonly x: number
  readonly time: number
  readonly shift: boolean
  readonly ctrl: boolean
  readonly alt: boolean
  preventDefault(): void
}

/**
 * "No handle" as a shape that CANNOT be mistaken for a handle.
 *
 * THE BUG THIS TYPE EXISTS FOR. The host used to hand every layer that did not
 * claim the hit `handle = ''`, and M25's tooltip did
 * `chapters[Number(e.handle)]`. `Number('') === 0`, so the chapter fragment
 * rendered at every pointer position, always naming chapter 0. Measured over 24
 * positions in the packaged build: 24/24 printed "Intro", and 22 of the 24
 * contradicted M27's caption inside the same `#seekHover` box — at 5:00 and 9:20
 * the tooltip said "Intro" and "End" simultaneously.
 *
 * So the absent case is a DISCRIMINATED UNION, and both halves of that matter:
 *
 *  - `claimed` makes the correct code obvious and reading `handle` as a string
 *    a type error until you have checked it;
 *  - the absent case carries `handle?: undefined` rather than `null` or `''`,
 *    because `Number(undefined)` is `NaN` and `arr[NaN]` is `undefined`, while
 *    `Number(null)` is `0` and `Number('')` is `0`. A careless consumer now gets
 *    nothing instead of item zero. "No handle" is unrepresentable as a valid
 *    index rather than merely discouraged.
 */
export type HandleClaim =
  | { readonly claimed: true; readonly handle: string }
  | { readonly claimed: false; readonly handle?: undefined }

/** Hover and tooltip fire at every position, so their handle may be absent. */
export type SeekbarUnclaimedEvent = Omit<SeekbarPointerEvent, 'handle'> & HandleClaim

/** @deprecated The old name for `SeekbarUnclaimedEvent`; kept so an in-flight
 *  module still compiles. It is the same type. */
export type SeekbarHoverEvent = SeekbarUnclaimedEvent

/**
 * One contribution to the ONE shared tooltip.
 *
 * `role` is how two layers that legitimately want to print the same KIND of
 * thing compose to one line instead of two. M25 prints the chapter title of the
 * tick under the pointer; M27 prints the chapter containing the hovered time.
 * Both are "the chapter", and before this existed M27 tried to derive whether
 * M25 would print by re-deriving M25's hit-test band from the chapter list and
 * the bar width. That premise was false in two directions — M25 printed
 * everywhere (the bug above), and even when fixed M25 only prints if it WINS the
 * hit-test, which a foreign layer cannot know — so the de-duplication belongs
 * in the host, which is the only thing that knows who claimed the pointer.
 *
 * The rule, applied by `SeekbarHost.tooltips()`: among fragments sharing a role,
 * the one from the layer that CLAIMED the pointer wins; failing that, the lowest
 * `order` wins. Nothing else about a layer is visible to any other layer.
 */
export interface SeekbarTooltipFragment {
  el: HTMLElement
  /** Low to high inside the tooltip. Core's timecode is 0. */
  order: number
  /** Fragments sharing a role collapse to one. Omit if nothing can duplicate it. */
  role?: string
}

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
  onHover?(e: SeekbarUnclaimedEvent | null): void
  /**
   * Fragments for the ONE shared tooltip, merged with every other layer's by
   * `order` (core's timecode is order 0). Returning fragments is how the chapter
   * title and the thumbnail compose with the time instead of stacking three
   * floating boxes over each other.
   *
   * Return an ARRAY when the parts have different roles or want different
   * positions in the merge: M27 returns its preview image and its chapter
   * caption separately, so the host can drop the caption (role 'chapter') when
   * M25 has the tick under the pointer without also dropping the image.
   *
   * The event is a `SeekbarUnclaimedEvent`: this runs at EVERY pointer position,
   * not only where your `hitTest` claimed, so check `e.claimed` first. See the
   * type for the 24/24-wrong-chapter bug that came of assuming otherwise.
   */
  tooltip?(
    e: SeekbarUnclaimedEvent
  ): SeekbarTooltipFragment | readonly SeekbarTooltipFragment[] | null
  /**
   * Every handle this layer currently offers, in the order Tab should reach
   * them. REQUIRED for an interactive layer (rule 4): a layer with `hitTest`
   * and no `handles` is grabbable with a pointer and unreachable without one.
   */
  handles?(ctx: SeekbarLayerCtx): readonly string[]
  onKey?(e: {
    handle: string
    key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
    stepSec: number
    shift: boolean
  }): void
}

/**
 * A control in the transport bar's own button row (§3.4).
 *
 * WHY THIS EXISTS. `src/renderer/index.html` hard-coded `#playlistBtn` (M28's)
 * and `#subBtn` (M17's) — two feature-specific controls in a core file that
 * appears in the `mustNotTouch` list of 40 of the 55 rows. That is the same
 * shape as the `#playlist` panel host and M25's `.seek-chapter-tick`, both of
 * which have already been fixed by giving the thing a contribution point; and
 * the next four modules that want a button in that row (M22's capture, M26's
 * bookmarks, M27's thumbnails, M35's URL box) were each one commit from editing
 * the same file.
 *
 * `check:partition` cannot catch this one on its own — core's `main.ts` really
 * did reference `#playlistBtn`, so the id had a legitimate core user and no
 * ownership rule could fire. The fix is the host, not the detector.
 *
 * The module owns everything inside its button. The host owns the `<button>`,
 * its class and its position, so a module never needs to know `icon-btn`.
 */
export interface TransportButton {
  id: string
  /** Left to right within the row's right-hand group. Core's own end at 100. */
  order: number
  /** Tooltip and accessible name, resolved through `ctx.t()`. */
  labelKey: string
  /**
   * Paint into the button core created. Return a teardown.
   * `pressed(on)` sets `aria-pressed`, so a toggle does not have to reach for
   * the element to reflect its own state.
   */
  mount(el: HTMLButtonElement, api: { pressed(on: boolean): void }): () => void
  onClick(e: { shift: boolean; ctrl: boolean; alt: boolean; button: number }): void
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
  /** A control in the transport bar's button row. Ignored in the settings window. */
  transportButton(b: TransportButton): void
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
