import './nav-chapters.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'
import type { Chapter } from '../../../../shared/types.ts'

/**
 * M25 nav-chapters, renderer half.
 *
 * WAVE 0 SEED, and it is here as the PROOF that the interactive seek-bar layer
 * works end to end: chapter ticks are drawn by a contributed layer, the ticks
 * are click-to-seek through `hitTest` + `onPointerUp`, the tick under the
 * pointer contributes a tooltip fragment, and arrow keys nudge the focused
 * tick. None of that was expressible in the render-only contract the spec
 * originally declared.
 *
 * Two of those three used to be a claim rather than a fact. `tooltip()` was
 * written and shipped and NEVER CALLED -- `main.ts` assigned the hover readout
 * directly, so the fragment was dead code -- and `onKey()` could not fire
 * because the overlay returned early on every arrow key inside a range input.
 * The host composes the tooltip from fragments now and the arrows reach
 * `key()`, so this module declares `handles()` (rule 4) and paints its own
 * focus ring from `ctx.focusedHandle`.
 *
 * Note the ownership rule holding on both halves: this file never writes an
 * mpv property. It sends to its own main half, which owns `chapter`.
 */

let chapters: Chapter[] = []
let duration = 0

const mod: RendererFeatureModule = {
  id: 'nav-chapters',

  setup(ctx): void {
    /**
     * The layer's container is CORE'S, handed to `render` as `c.el`. This module
     * used to create its own `<div class="seek-layer seek-chapters">`, which
     * meant knowing core's class name, which is how its two private selectors
     * ended up in core's stylesheet. It paints into what it is given now.
     */
    let host: HTMLElement | null = null

    // `ctx.state.subscribe` REPLAYS the last state synchronously (renderer-core
    // fires immediately when it already has one), so everything paint() closes
    // over has to exist before the subscribe, not after it. Declaring `ticks`
    // below the subscribe made the very first replayed paint() a TDZ
    // ReferenceError, which killed the rest of setup() — including the
    // seekbarLayer() registration — and left a permanently throwing subscriber
    // behind. Order is load-bearing here.
    let ticks: HTMLElement[] = []

    let focusedHandle: string | null = null

    function paint(): void {
      if (!host) return
      host.textContent = ''
      ticks = []
      if (duration <= 0 || chapters.length < 2) return
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i]
        if (!ch) continue
        const tick = document.createElement('span')
        tick.className = 'seek-chapter-tick'
        // A handle you can Tab to but cannot see is worse than one you cannot
        // reach: the arrows would move something invisible.
        if (focusedHandle === String(i)) tick.classList.add('focused')
        tick.style.left = `${(ch.time / duration) * 100}%`
        tick.title = ch.title
        host.appendChild(tick)
        ticks.push(tick)
      }
    }

    ctx.state.subscribe((s) => {
      chapters = s.chapters
      duration = s.duration
      paint()
    })

    ctx.seekbarLayer({
      id: 'nav-chapters.ticks',
      order: 10,
      render(c): void {
        host = c.el
        focusedHandle = c.focusedHandle
        paint()
      },
      /** Rule 4: every tick is Tab-reachable, in time order. */
      handles(): readonly string[] {
        return chapters.length < 2 ? [] : chapters.map((_, i) => String(i))
      },
      /** A 2px tick is only grabbable because of `tolerancePx`. */
      hitTest(c): string | null {
        if (chapters.length < 2 || c.duration <= 0) return null
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i]
          if (!ch) continue
          if (Math.abs(c.x - c.timeToX(ch.time)) <= c.tolerancePx) return String(i)
        }
        return null
      },
      onPointerUp(e): void {
        if (e.cancelled) return
        const index = Number(e.handle)
        if (Number.isFinite(index)) ctx.ipc.send('nav-chapters:goto', { index })
      },
      tooltip(e): { el: HTMLElement; order: number } | null {
        const ch = chapters[Number(e.handle)]
        if (!ch) return null
        const el = document.createElement('span')
        el.className = 'seek-tip-chapter'
        el.textContent = ch.title
        return { el, order: 20 }
      },
      onKey(e): void {
        const index = Number(e.handle)
        if (!Number.isFinite(index)) return
        if (e.key === 'Home') return ctx.ipc.send('nav-chapters:goto', { index: 0 })
        if (e.key === 'End') {
          return ctx.ipc.send('nav-chapters:goto', { index: chapters.length - 1 })
        }
        const delta = e.key === 'ArrowLeft' ? -1 : 1
        ctx.ipc.send('nav-chapters:goto', { index: index + delta })
      }
    })
  }
}

export default mod
