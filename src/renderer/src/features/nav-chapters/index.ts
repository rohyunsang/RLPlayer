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
 * Note the ownership rule holding on both halves: this file never writes an
 * mpv property. It sends to its own main half, which owns `chapter`.
 */

let chapters: Chapter[] = []
let duration = 0

const mod: RendererFeatureModule = {
  id: 'nav-chapters',

  setup(ctx): void {
    const host = document.createElement('div')
    host.className = 'seek-layer seek-chapters'

    ctx.state.subscribe((s) => {
      chapters = s.chapters
      duration = s.duration
      paint()
    })

    let ticks: HTMLElement[] = []

    function paint(): void {
      host.textContent = ''
      ticks = []
      if (duration <= 0 || chapters.length < 2) return
      for (const ch of chapters) {
        const tick = document.createElement('span')
        tick.className = 'seek-chapter-tick'
        tick.style.left = `${(ch.time / duration) * 100}%`
        tick.title = ch.title
        host.appendChild(tick)
        ticks.push(tick)
      }
    }

    ctx.seekbarLayer({
      id: 'nav-chapters.ticks',
      order: 10,
      render(c): void {
        if (host.parentElement !== c.el) c.el.appendChild(host)
        paint()
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
        const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
        if (delta === 0) return
        ctx.ipc.send('nav-chapters:goto', { index: index + delta })
      }
    })
  }
}

export default mod
