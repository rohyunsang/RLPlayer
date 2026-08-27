import type {
  SeekbarLayer,
  SeekbarLayerCtx,
  SeekbarPointerEvent
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
 *      can only drag is a bar some people cannot use.
 *
 * No DOM API is called in here — only geometry the caller supplies — so the
 * whole interaction model is unit-testable under `node --test`.
 */

export interface SeekbarHostDeps {
  el: HTMLElement
  duration(): number
  width(): number
  /** The host's own scrub, used when no layer claims the press. */
  scrub(time: number, phase: 'down' | 'move' | 'up', cancelled: boolean): void
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
  private active: { layer: SeekbarLayer; handle: string } | null = null
  private hostScrubbing = false
  private focused: { layerId: string; handle: string } | null = null

  private readonly deps: SeekbarHostDeps

  constructor(deps: SeekbarHostDeps) {
    this.deps = deps
  }

  register(layer: SeekbarLayer): () => void {
    if (this.layers.some((l) => l.id === layer.id)) {
      throw new Error(`duplicate seek-bar layer id '${layer.id}'`)
    }
    this.layers.push(layer)
    this.layers.sort((a, b) => a.order - b.order)
    this.deps.invalidate?.()
    return () => {
      const i = this.layers.indexOf(layer)
      if (i >= 0) this.layers.splice(i, 1)
      if (this.active?.layer === layer) this.cancel()
      this.deps.invalidate?.()
    }
  }

  /** Paint order, low to high. */
  ordered(): readonly SeekbarLayer[] {
    return this.layers
  }

  ctx(): SeekbarLayerCtx {
    const duration = this.deps.duration()
    const width = this.deps.width()
    return {
      el: this.deps.el,
      duration,
      width,
      // Guarded for live streams, where duration is 0 or unknown (R24). Every
      // layer would otherwise divide by zero in its own way.
      timeToX: (t: number) => (duration > 0 ? (t / duration) * width : 0),
      xToTime: (x: number) => (duration > 0 ? (x / width) * duration : 0)
    }
  }

  render(): void {
    const base = this.ctx()
    for (const layer of this.layers) {
      try {
        layer.render(base)
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

  /** Hover is hit-test independent and goes to EVERY layer that wants it. */
  hover(x: number | null, mods: PointerMods = {}): void {
    if (x === null) {
      for (const layer of this.layers) layer.onHover?.(null)
      return
    }
    const claim = this.hit(x)
    for (const layer of this.layers) {
      if (!layer.onHover) continue
      const handle: string | null = claim?.layer === layer ? claim.handle : null
      layer.onHover({ ...this.event(handle ?? '', x, mods), handle })
    }
  }

  /** Tooltip fragments from every layer, merged by order into ONE tooltip, so
   *  the time, the chapter title and the thumbnail compose instead of stacking
   *  three floating boxes. */
  tooltips(x: number, mods: PointerMods = {}): Array<{ el: HTMLElement; order: number }> {
    const out: Array<{ el: HTMLElement; order: number }> = []
    for (const layer of this.layers) {
      if (!layer.tooltip) continue
      const claim = this.hit(x)
      const handle = claim?.layer === layer ? claim.handle : ''
      const frag = layer.tooltip(this.event(handle, x, mods))
      if (frag) out.push(frag)
    }
    return out.sort((a, b) => a.order - b.order)
  }

  /** Focus order for Tab: every handle a layer claims, in paint order. */
  focusHandle(layerId: string, handle: string): void {
    this.focused = { layerId, handle }
  }

  key(key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End', stepSec: number, shift = false): boolean {
    const target = this.focused
    if (!target) return false
    const layer = this.layers.find((l) => l.id === target.layerId)
    if (!layer?.onKey) return false
    layer.onKey({ handle: target.handle, key, stepSec, shift })
    return true
  }

  get dragging(): boolean {
    return this.active !== null || this.hostScrubbing
  }
}
