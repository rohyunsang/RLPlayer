import type {
  SeekbarLayer,
  SeekbarLayerCtx,
  SeekbarPointerEvent,
  SeekbarTooltipFragment,
  SeekbarUnclaimedEvent
} from '../../../shared/renderer-api.ts'

/**
 * The INTERACTIVE seek-bar layer host (§3.4). WAVE 0 — FROZEN.
 *
 * The declared `seekbarLayer` was render-only — no pointer events, no
 * hit-testing, no drag contract — which made N19 (a P0: "dragging a handle sets
 * ab-loop-a/-b") unbuildable through the API. N13 wants click-to-seek on
 * bookmark pins and N30 wants the bar itself for drag-scrub, so three modules
 * needed pointer interaction on one bar and the API gave none of them a way to
 * get it. Without this the first of the three reaches into the core host and
 * the collision just moves one directory over.
 *
 * The contract, in four rules:
 *   1. Interaction is OPT-IN. A layer with no `hitTest` never receives pointer
 *      events, so chapter ticks stay three lines long.
 *   2. Hit-testing runs in REVERSE paint order: the visually topmost layer is
 *      offered the pointer first. Returning null passes it down, and finally to
 *      the host's own scrub — which is therefore never stolen by accident.
 *   3. Exactly ONE onPointerUp per onPointerDown. Including on pointercancel,
 *      window blur and Esc, where it arrives with `cancelled: true`. A layer
 *      that leaks a drag because the user alt-tabbed is a layer that eats every
 *      subsequent click.
 *   4. Keyboard equivalence is mandatory for an interactive layer. A bar you
 *      can only drag is a bar some people cannot use. A layer with `hitTest`
 *      declares `handles()` and `onKey()`; Tab walks every handle in paint
 *      order and the arrows nudge the focused one.
 *
 *      THIS RULE USED TO BE UNSATISFIABLE, which is worse than not having it.
 *      `tooltips()`, `key()` and `focusHandle()` had ZERO production call
 *      sites -- grep found only seekbar-host.test.ts:170, :182 and :185 -- so
 *      the whole keyboard and tooltip half of this host was code that only its
 *      own test ran. Meanwhile `main.ts:464` returned early on any arrow key
 *      while a range input had focus, and the seek bar IS a range input, so
 *      even if `key()` had been wired it could never have been reached. A
 *      module author reading rule 4 would have implemented `onKey` and watched
 *      it never fire. Both halves are wired now: `main.ts` composes the shared
 *      tooltip from `tooltips()`, Tab drives `focusNext()`, and arrows reach
 *      `key()` before the early-out, which now applies only when no handle is
 *      focused.
 *   5. `order` IS A SLOT, NOT A HINT. It decides paint order, hit-test order
 *      (reversed) and the layer container's z-index, so a duplicate is rejected
 *      at registration exactly as a duplicate `id` is. It had already collided
 *      at n=4 — `nav-chapters.ticks` and `nav-thumbnails.preview` both at 10 —
 *      and was benign only because M27 declares no `hitTest` yet.
 *   6. A LAYER NEVER LEARNS ANYTHING ABOUT ANOTHER LAYER: not whether it
 *      claimed the pointer, not whether it printed a tooltip. Where two layers
 *      legitimately want to print the same KIND of thing they say so with a
 *      fragment `role`, and the host — the only thing that knows who claimed
 *      the pointer — keeps one. The alternative, M27 re-deriving M25's
 *      hit-test band from the chapter list and the bar width, shipped and was
 *      wrong at 22 of 24 sampled positions.
 *
 * No DOM API is called in here — only geometry the caller supplies — so the
 * whole interaction model is unit-testable under `node --test`.
 */

export interface SeekbarHostDeps {
  el: HTMLElement
  /**
   * Creates the element core owns for ONE layer, and returns it already
   * attached to `el`.
   *
   * This is the seek-bar half of what `ctx.panel()` already did for panels, and
   * its absence is why M25's `.seek-chapter-tick` and `.seek-tip-chapter` ended
   * up in `src/renderer/src/styles.css` — a core-owned file in the
   * `mustNotTouch` list of 40 of the 55 module rows. The layer had to build its
   * own container, so it had to know core's `seek-layer` class, so its styles
   * went where core's styles were. §6.3 needs chapter ticks, bookmark pins and
   * the A-B region on this bar at once, so M20, M26 and M27 were each one
   * commit from following it in.
   *
   * Optional so the interaction model stays unit-testable with no DOM at all.
   */
  layerEl?(id: string, order: number): HTMLElement
  duration(): number
  width(): number
  /** The host's own scrub, used when no layer claims the press. */
  scrub(time: number, phase: 'down' | 'move' | 'up', cancelled: boolean): void
  /**
   * Core's own tooltip fragment -- the timecode under the pointer.
   *
   * It lives here rather than in `main.ts`'s pointermove handler because the
   * merge has to happen in ONE place. It used to be
   * `seekHover.textContent = formatTime(...)`, an unconditional assignment on a
   * single line of `main.ts` -- a file in the `mustNotTouch` list of 40 of the
   * 55 rows -- so N37 (chapter title + timecode in the preview tooltip) and N13
   * (bookmark pins) each had to edit that same line to add anything, and M25's
   * already-shipped `tooltip()` fragment was dead code because nothing ever
   * called `tooltips()`.
   */
  baseTooltip?(x: number): { el: HTMLElement; order: number } | null
  /** Ask the page to repaint the layers. */
  invalidate?(): void
}

export interface PointerMods {
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
}

const DEFAULT_TOLERANCE = 6

export class SeekbarHost {
  private readonly layers: SeekbarLayer[] = []
  /** One core-owned container per layer; a module never creates its own. */
  private readonly layerEls = new Map<string, HTMLElement>()
  private active: { layer: SeekbarLayer; handle: string } | null = null
  private hostScrubbing = false
  private focused: { layerId: string; handle: string } | null = null
  /** Rule-4 warnings are once per layer: an every-frame log is noise, not a report. */
  private readonly warnedNoHandles = new Set<string>()

  private readonly deps: SeekbarHostDeps

  constructor(deps: SeekbarHostDeps) {
    this.deps = deps
  }

  register(layer: SeekbarLayer): () => void {
    if (this.layers.some((l) => l.id === layer.id)) {
      throw new Error(`duplicate seek-bar layer id '${layer.id}'`)
    }
    /**
     * A DUPLICATE `order` IS REJECTED THE SAME WAY A DUPLICATE ID IS.
     *
     * `order` is not decoration here: it decides paint order, it decides
     * hit-test order (reversed), and `main.ts` copies it straight into the
     * layer container's `z-index`. Two layers sharing it means all three fall
     * back to registration order — which is `import.meta.glob`'s directory
     * order, i.e. alphabetical by module id, i.e. an ordering nobody chose and
     * nothing states.
     *
     * It had already collided at n=4: `nav-chapters.ticks` and
     * `nav-thumbnails.preview` both registered at 10. Benign only because M27
     * declares no `hitTest`, so the tie could not steal a press yet — and "the
     * next module to add a hitTest breaks a shipped feature" is not a property
     * worth relying on with 34 modules still to land.
     */
    const clash = this.layers.find((l) => l.order === layer.order)
    if (clash) {
      throw new Error(
        `duplicate seek-bar layer order ${layer.order}: '${clash.id}' and '${layer.id}'. ` +
          `order decides paint order, hit-test order (reversed) and z-index, so a tie makes ` +
          `all three depend on module load order. Pick distinct orders and record them in ` +
          `docs/parity/02-wave0-api.md §3.4.`
      )
    }
    this.layers.push(layer)
    this.layers.sort((a, b) => a.order - b.order)
    const el = this.deps.layerEl?.(layer.id, layer.order)
    if (el) this.layerEls.set(layer.id, el)
    this.deps.invalidate?.()
    return () => {
      const i = this.layers.indexOf(layer)
      if (i >= 0) this.layers.splice(i, 1)
      if (this.active?.layer === layer) this.cancel()
      if (this.focused?.layerId === layer.id) this.focused = null
      this.layerEls.get(layer.id)?.remove()
      this.layerEls.delete(layer.id)
      this.deps.invalidate?.()
    }
  }

  /** Paint order, low to high. */
  ordered(): readonly SeekbarLayer[] {
    return this.layers
  }

  ctx(layerId?: string): SeekbarLayerCtx {
    const duration = this.deps.duration()
    const width = this.deps.width()
    return {
      // A layer paints into ITS OWN element, never into the shared container.
      el: (layerId !== undefined ? this.layerEls.get(layerId) : undefined) ?? this.deps.el,
      duration,
      width,
      // Only ever this layer's own handle: a layer must not be able to tell
      // whether another layer's pin is focused.
      focusedHandle:
        layerId !== undefined && this.focused?.layerId === layerId ? this.focused.handle : null,
      // Guarded for live streams, where duration is 0 or unknown (R24). Every
      // layer would otherwise divide by zero in its own way.
      timeToX: (t: number) => (duration > 0 ? (t / duration) * width : 0),
      xToTime: (x: number) => (duration > 0 ? (x / width) * duration : 0)
    }
  }

  render(): void {
    for (const layer of this.layers) {
      try {
        layer.render(this.ctx(layer.id))
      } catch (e) {
        console.error(`[seekbar] layer '${layer.id}' render threw:`, (e as Error).message)
      }
    }
  }

  private event(handle: string, x: number, mods: PointerMods): SeekbarPointerEvent {
    const c = this.ctx()
    let prevented = false
    return {
      handle,
      x,
      time: c.xToTime(x),
      shift: mods.shift === true,
      ctrl: mods.ctrl === true,
      alt: mods.alt === true,
      preventDefault: () => {
        prevented = true
        void prevented
      }
    }
  }

  /** Reverse paint order: topmost first. Returns null when nobody claims it. */
  private hit(x: number): { layer: SeekbarLayer; handle: string } | null {
    const base = this.ctx()
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]
      if (!layer?.hitTest) continue
      let handle: string | null = null
      try {
        handle = layer.hitTest({ ...base, x, tolerancePx: DEFAULT_TOLERANCE })
      } catch (e) {
        console.error(`[seekbar] layer '${layer.id}' hitTest threw:`, (e as Error).message)
      }
      if (handle) return { layer, handle }
    }
    return null
  }

  /** @returns true when a LAYER claimed the press (the host must not scrub). */
  pointerDown(x: number, mods: PointerMods = {}): boolean {
    if (this.active || this.hostScrubbing) this.cancel()
    const claim = this.hit(x)
    if (claim) {
      this.active = claim
      this.focused = { layerId: claim.layer.id, handle: claim.handle }
      claim.layer.onPointerDown?.(this.event(claim.handle, x, mods))
      return true
    }
    this.hostScrubbing = true
    this.deps.scrub(this.ctx().xToTime(x), 'down', false)
    return false
  }

  pointerMove(x: number, mods: PointerMods = {}): void {
    if (this.active) {
      this.active.layer.onPointerMove?.(this.event(this.active.handle, x, mods))
      return
    }
    if (this.hostScrubbing) this.deps.scrub(this.ctx().xToTime(x), 'move', false)
  }

  pointerUp(x: number, mods: PointerMods = {}, cancelled = false): void {
    if (this.active) {
      const { layer, handle } = this.active
      this.active = null
      layer.onPointerUp?.({ ...this.event(handle, x, mods), cancelled })
      return
    }
    if (this.hostScrubbing) {
      this.hostScrubbing = false
      this.deps.scrub(this.ctx().xToTime(x), 'up', cancelled)
    }
  }

  /** pointercancel, window blur, Esc. Guarantees the matching onPointerUp. */
  cancel(x = 0): void {
    this.pointerUp(x, {}, true)
  }

  /**
   * The event a layer gets when the pointer may or may not be on one of ITS
   * handles: hover and tooltip.
   *
   * `handle` is a real string or ABSENT — never `''`, never `null`. That was the
   * whole of the 24/24-wrong-chapter bug: the host handed `''` to every layer
   * that did not claim the hit, and `Number('') === 0`, so M25's chapter
   * fragment rendered at every position naming chapter 0. `Number(undefined)` is
   * `NaN`, so the same careless consumer now gets nothing instead of item zero.
   */
  private unclaimedEvent(
    handle: string | null,
    x: number,
    mods: PointerMods
  ): SeekbarUnclaimedEvent {
    // The base event needs SOME string for its `handle` field; it is discarded
    // by the spread below, and the discriminant decides what a consumer sees.
    const base = this.event(handle ?? 'unclaimed', x, mods)
    const { handle: _discard, ...rest } = base
    void _discard
    return handle === null ? { ...rest, claimed: false } : { ...rest, claimed: true, handle }
  }

  /** Hover is hit-test independent and goes to EVERY layer that wants it. */
  hover(x: number | null, mods: PointerMods = {}): void {
    if (x === null) {
      for (const layer of this.layers) layer.onHover?.(null)
      return
    }
    const claim = this.hit(x)
    for (const layer of this.layers) {
      if (!layer.onHover) continue
      layer.onHover(this.unclaimedEvent(claim?.layer === layer ? claim.handle : null, x, mods))
    }
  }

  /**
   * Tooltip fragments from every layer, merged by order into ONE tooltip, so the
   * time, the chapter title and the thumbnail compose instead of stacking three
   * floating boxes.
   *
   * TWO FRAGMENTS WITH THE SAME `role` COLLAPSE TO ONE, and the host is the only
   * thing that can decide which: it is the only thing that knows who claimed the
   * pointer. M25's chapter title (the tick under the pointer) and M27's chapter
   * caption (the chapter containing the hovered time) are both "the chapter", and
   * M27 previously tried to work out whether M25 would print by re-deriving
   * M25's hit-test band from the chapter list and the bar width. That premise was
   * false twice over — M25 printed everywhere, and even correct it only prints
   * when it WINS the hit-test against every other layer on the bar. Neither is
   * knowable from inside a foreign module, and a layer that could ask would be a
   * layer coupled to another module's internals.
   *
   * The rule: the claiming layer's fragment wins; otherwise the lowest `order`.
   */
  tooltips(x: number, mods: PointerMods = {}): SeekbarTooltipFragment[] {
    const collected: Array<{ frag: SeekbarTooltipFragment; claimed: boolean }> = []
    // Core's timecode is a fragment like any other, at order 0, so the merge
    // order is decided once here instead of half here and half in main.ts.
    const base = this.deps.baseTooltip?.(x)
    if (base) collected.push({ frag: base, claimed: false })
    // ONE hit-test for the whole tooltip. It was inside the loop, so an n-layer
    // bar ran n hit-tests per pointermove -- and every hitTest walks its layer's
    // own items, which for M26's bookmark pins is the whole list.
    const claim = this.hit(x)
    for (const layer of this.layers) {
      if (!layer.tooltip) continue
      const mine = claim?.layer === layer
      try {
        const got = layer.tooltip(this.unclaimedEvent(mine ? claim.handle : null, x, mods))
        if (!got) continue
        for (const frag of Array.isArray(got) ? got : [got as SeekbarTooltipFragment]) {
          if (frag) collected.push({ frag, claimed: mine })
        }
      } catch (e) {
        // One layer's broken tooltip must not blank the timecode.
        console.error(`[seekbar] layer '${layer.id}' tooltip threw:`, (e as Error).message)
      }
    }

    const byRole = new Map<string, { frag: SeekbarTooltipFragment; claimed: boolean }>()
    const out: SeekbarTooltipFragment[] = []
    for (const item of collected) {
      const role = item.frag.role
      if (role === undefined) {
        out.push(item.frag)
        continue
      }
      const held = byRole.get(role)
      if (!held) {
        byRole.set(role, item)
        continue
      }
      // The claiming layer is specific to what the pointer is ON; anything else
      // is a general answer for the position. Specific wins, then lowest order.
      const wins = item.claimed !== held.claimed ? item.claimed : item.frag.order < held.frag.order
      if (wins) byRole.set(role, item)
    }
    for (const item of byRole.values()) out.push(item.frag)
    // `sort` is stable, and layer `order` is now unique, so fragments that share
    // an `order` still merge in a defined sequence: their layers' paint order.
    return out.sort((a, b) => a.order - b.order)
  }

  /** Focus order for Tab: every handle a layer claims, in paint order. */
  focusHandle(layerId: string, handle: string): void {
    this.focused = { layerId, handle }
    this.deps.invalidate?.()
  }

  /** Which handle has keyboard focus, if any. Read by the page for its aria. */
  get focusedTarget(): { layerId: string; handle: string } | null {
    return this.focused
  }

  /**
   * Every focusable handle, in paint order.
   *
   * A layer that declares `hitTest` but not `handles` is grabbable with a
   * pointer and unreachable without one, which is rule 4 broken. It is not a
   * throw -- refusing to register the layer would take a working feature away
   * from sighted mouse users to punish its author -- but it is loud, once.
   */
  focusables(): Array<{ layerId: string; handle: string }> {
    const out: Array<{ layerId: string; handle: string }> = []
    for (const layer of this.layers) {
      if (!layer.handles) {
        if (layer.hitTest && !this.warnedNoHandles.has(layer.id)) {
          this.warnedNoHandles.add(layer.id)
          console.error(
            `[seekbar] layer '${layer.id}' is interactive (it has hitTest) but declares no ` +
              `handles(), so Tab cannot reach it. Keyboard equivalence is mandatory (rule 4).`
          )
        }
        continue
      }
      try {
        for (const handle of layer.handles(this.ctx(layer.id))) {
          out.push({ layerId: layer.id, handle })
        }
      } catch (e) {
        console.error(`[seekbar] layer '${layer.id}' handles() threw:`, (e as Error).message)
      }
    }
    return out
  }

  /**
   * Move focus by `delta` through `focusables()`.
   *
   * Returns false when it walks off either end WITHOUT wrapping, and that is
   * deliberate: the page uses the false to let Tab leave the seek bar for the
   * next control. A focus ring that traps the user inside one widget is the
   * usual way keyboard support gets added and then switched off again.
   */
  focusNext(delta: 1 | -1): boolean {
    const all = this.focusables()
    if (all.length === 0) return false
    const here = this.focused
    const at = here
      ? all.findIndex((f) => f.layerId === here.layerId && f.handle === here.handle)
      : -1
    const next = at < 0 ? (delta === 1 ? 0 : all.length - 1) : at + delta
    if (next < 0 || next >= all.length) {
      this.blur()
      return false
    }
    const target = all[next]
    if (!target) return false
    this.focusHandle(target.layerId, target.handle)
    return true
  }

  blur(): void {
    if (!this.focused) return
    this.focused = null
    this.deps.invalidate?.()
  }

  key(key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End', stepSec: number, shift = false): boolean {
    const target = this.focused
    if (!target) return false
    const layer = this.layers.find((l) => l.id === target.layerId)
    if (!layer?.onKey) return false
    try {
      layer.onKey({ handle: target.handle, key, stepSec, shift })
    } catch (e) {
      console.error(`[seekbar] layer '${layer.id}' onKey threw:`, (e as Error).message)
    }
    // TRUE means the page must not also act on this key. Returning false when
    // nothing is focused is what lets the range input keep its own arrow keys.
    return true
  }

  get dragging(): boolean {
    return this.active !== null || this.hostScrubbing
  }
}
