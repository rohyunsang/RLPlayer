import './nav-bookmarks.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'
/**
 * ONE definition of each wire type, checked at BOTH ends. `Bookmark` and
 * `BookmarkPanelState` were declared here and twice more on the main side.
 */
import type {
  Bookmark,
  BookmarkPanelState
} from '../../../../shared/features/nav-bookmarks/wire.ts'

/**
 * M26 nav-bookmarks, renderer half.
 *
 * This is the module the seek-bar contribution host was rebuilt for, so it is
 * also the test of whether the rebuild worked. It puts THREE things on the one
 * seek bar M25 already draws chapter ticks on — bookmark pins, the A-B region
 * and two draggable A-B endpoint grips — plus two fragments into the ONE shared
 * tooltip, plus a docked panel and a transport button. Not one line of
 * `src/renderer/index.html`, `src/renderer/src/main.ts` or
 * `src/renderer/src/styles.css` was touched to do it; every private selector
 * below lives in this directory's own stylesheet.
 *
 * TWO LAYERS, not one, and the order matters. The A-B layer paints ABOVE the
 * pins (30 > 20) so that hit-testing — which runs in reverse paint order —
 * offers it the pointer first: an endpoint grip you cannot grab because a pin
 * sits under it is the whole feature gone. They do not overlap visually,
 * because §2.5 N13 puts the pins BELOW the bar and the region inside it (a
 * different SHAPE from the chapter ticks, not merely a different colour).
 *
 * The ownership rule holds here exactly as it does in the main half: nothing in
 * this file writes an mpv property. Every gesture ends in an `ipc.send` to
 * `nav-bookmarks`'s main half, which owns `ab-loop-a` / `-b` / `-count`.
 */

/** Mirrors the main half's record. It cannot be imported: `src/shared` is
 *  core's, and `tsconfig.web.json` does not include `src/main`, so the two
 *  halves of a module have no shared compilation unit to put a type in. */
const EMPTY: BookmarkPanelState = {
  open: false,
  duration: 0,
  bookmarks: [],
  loop: { a: null, b: null, soft: false, count: 0, remaining: null }
}

const pad = (n: number): string => String(n).padStart(2, '0')

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0))
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const svg = (d: string): SVGSVGElement => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 16 16')
  s.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  s.appendChild(p)
  return s
}

const mod: RendererFeatureModule = {
  id: 'nav-bookmarks',

  setup(ctx): void {
    // The settings window runs the same glob. A seek bar and a bookmark panel
    // have no meaning there, and building their DOM would be wasted work.
    if (ctx.surface !== 'player') return

    /**
     * DECLARE FIRST, SUBSCRIBE LAST (§3.4).
     *
     * `ctx.ipc.on` does not replay, but `ctx.state.subscribe` DOES — it fires
     * synchronously inside this `setup()` — and M25 shipped a live bug by
     * declaring a paint variable below its subscribe: the first replayed paint
     * threw a TDZ ReferenceError, which killed the rest of `setup()` and so its
     * `seekbarLayer()` never registered at all. Everything a repaint touches is
     * declared here, above every registration.
     */
    let state: BookmarkPanelState = EMPTY
    let pinsHost: HTMLElement | null = null
    let loopHost: HTMLElement | null = null
    let pinFocus: string | null = null
    let loopFocus: string | null = null
    /** While an endpoint or a pin is being dragged, the bar follows the pointer
     *  and mpv hears nothing until the drag ends. */
    let drag: { layer: 'pin' | 'loop'; handle: string; time: number } | null = null
    let repaintPanel: () => void = () => {}

    const duration = (): number => state.duration
    const pct = (t: number): number => {
      const d = duration()
      // `ctx.duration` is 0 for a live stream. Every layer would otherwise
      // divide by zero in its own way (R24).
      return d > 0 ? Math.max(0, Math.min(100, (t / d) * 100)) : 0
    }

    const loopA = (): number | null =>
      drag?.layer === 'loop' && drag.handle === 'a' ? drag.time : state.loop.a
    const loopB = (): number | null =>
      drag?.layer === 'loop' && drag.handle === 'b' ? drag.time : state.loop.b
    const pinTime = (b: Bookmark): number =>
      drag?.layer === 'pin' && drag.handle === b.id ? drag.time : b.t

    // -- the pins layer ---------------------------------------------------

    function paintPins(): void {
      if (!pinsHost) return
      pinsHost.textContent = ''
      if (duration() <= 0) return
      for (const bookmark of state.bookmarks) {
        // §2.5 N13: a different SHAPE from M25's chapter tick, not just a
        // different colour. Chapters are a thin tick inside the bar; a bookmark
        // is a pin hanging below it, and a saved A-B section is a wider pin.
        const pin = el('span', 'bm-pin')
        if (bookmark.b !== undefined) pin.classList.add('bm-pin-section')
        if (pinFocus === bookmark.id) pin.classList.add('bm-pin-focused')
        pin.style.left = `${pct(pinTime(bookmark))}%`
        pin.title = ctx.t('nav-bookmarks.pinLabel', { title: bookmark.title })
        pinsHost.appendChild(pin)
      }
    }

    ctx.seekbarLayer({
      id: 'nav-bookmarks.pins',
      order: 20,
      render(c): void {
        pinsHost = c.el
        pinFocus = c.focusedHandle
        paintPins()
      },
      /** Rule 4: every pin is Tab-reachable, in time order. */
      handles(): readonly string[] {
        return state.bookmarks.map((b) => b.id)
      },
      /** A 6 px pin is only grabbable because of `tolerancePx`. */
      hitTest(c): string | null {
        if (c.duration <= 0) return null
        for (const bookmark of state.bookmarks) {
          if (Math.abs(c.x - c.timeToX(bookmark.t)) <= c.tolerancePx) return bookmark.id
        }
        return null
      },
      onPointerDown(e): void {
        drag = { layer: 'pin', handle: e.handle, time: e.time }
      },
      onPointerMove(e): void {
        if (drag?.layer !== 'pin') return
        drag = { layer: 'pin', handle: drag.handle, time: Math.max(0, e.time) }
        paintPins()
      },
      onPointerUp(e): void {
        const held = drag
        drag = null
        paintPins()
        if (e.cancelled || held?.layer !== 'pin') return
        const bookmark = state.bookmarks.find((b) => b.id === e.handle)
        if (!bookmark) return
        // A press that never moved is "jump here"; a real drag is "move the
        // pin". 0.4 s of timeline is well under one pin's width on any bar.
        if (Math.abs(e.time - bookmark.t) < 0.4) ctx.ipc.send('nav-bookmarks:goto', { id: e.handle })
        else ctx.ipc.send('nav-bookmarks:move', { id: e.handle, t: Math.max(0, e.time) })
      },
      tooltip(e): { el: HTMLElement; order: number } | null {
        const bookmark = state.bookmarks.find((b) => b.id === e.handle)
        if (!bookmark) return null
        const node = el('span', 'bm-tip', bookmark.title)
        // Core's timecode is order 0 and M25's chapter title is order 20, so
        // this composes UNDER both in the one shared tooltip rather than
        // opening a second floating box over them.
        return { el: node, order: 30 }
      },
      onKey(e): void {
        // The pointer equivalent of a pin is "click to jump", so the keyboard
        // equivalent is the same thing on the neighbouring pin.
        const ordered = [...state.bookmarks].sort((x, y) => x.t - y.t)
        if (ordered.length === 0) return
        const at = ordered.findIndex((b) => b.id === e.handle)
        const target =
          e.key === 'Home'
            ? ordered[0]
            : e.key === 'End'
              ? ordered[ordered.length - 1]
              : ordered[Math.min(ordered.length - 1, Math.max(0, at + (e.key === 'ArrowLeft' ? -1 : 1)))]
        if (target) ctx.ipc.send('nav-bookmarks:goto', { id: target.id })
      }
    })

    // -- the A-B region layer ---------------------------------------------

    function paintLoop(): void {
      if (!loopHost) return
      loopHost.textContent = ''
      if (duration() <= 0) return
      const a = loopA()
      const b = loopB()
      if (a === null && b === null) return

      if (a !== null && b !== null && b > a) {
        const region = el('span', 'bm-region')
        if (state.loop.soft) region.classList.add('bm-region-soft')
        region.style.left = `${pct(a)}%`
        region.style.width = `${Math.max(0, pct(b) - pct(a))}%`
        loopHost.appendChild(region)
      }
      for (const [handle, value] of [
        ['a', a],
        ['b', b]
      ] as const) {
        if (value === null) continue
        const grip = el('span', `bm-handle bm-handle-${handle}`)
        if (loopFocus === handle) grip.classList.add('bm-handle-focused')
        grip.style.left = `${pct(value)}%`
        grip.title = ctx.t(handle === 'a' ? 'nav-bookmarks.handleA' : 'nav-bookmarks.handleB')
        loopHost.appendChild(grip)
      }
    }

    ctx.seekbarLayer({
      id: 'nav-bookmarks.abloop',
      order: 30,
      render(c): void {
        loopHost = c.el
        loopFocus = c.focusedHandle
        paintLoop()
      },
      /** Rule 4. Only the endpoints that exist are Tab-reachable — an empty
       *  focus stop on a loop nobody set is a Tab press that does nothing. */
      handles(): readonly string[] {
        const out: string[] = []
        if (state.loop.a !== null) out.push('a')
        if (state.loop.b !== null) out.push('b')
        return out
      },
      hitTest(c): string | null {
        if (c.duration <= 0) return null
        const a = state.loop.a
        const b = state.loop.b
        if (a !== null && Math.abs(c.x - c.timeToX(a)) <= c.tolerancePx) return 'a'
        if (b !== null && Math.abs(c.x - c.timeToX(b)) <= c.tolerancePx) return 'b'
        return null
      },
      onPointerDown(e): void {
        drag = { layer: 'loop', handle: e.handle, time: e.time }
      },
      onPointerMove(e): void {
        if (drag?.layer !== 'loop') return
        // Preview only: N19's drag writes nothing until the pointer is released,
        // because a property write per pointermove is forty writes a second on
        // a property mpv re-plans the loop for.
        drag = { layer: 'loop', handle: drag.handle, time: Math.max(0, e.time) }
        paintLoop()
      },
      onPointerUp(e): void {
        const held = drag
        drag = null
        paintLoop()
        if (e.cancelled || held?.layer !== 'loop') return
        ctx.ipc.send('nav-bookmarks:setLoopPoint', {
          which: e.handle === 'b' ? 'b' : 'a',
          t: Math.max(0, e.time)
        })
      },
      tooltip(e): { el: HTMLElement; order: number } | null {
        if (e.handle !== 'a' && e.handle !== 'b') return null
        const a = state.loop.a
        const b = state.loop.b
        const text =
          a !== null && b !== null
            ? `${ctx.t('nav-bookmarks.title')} ${formatTime(a)} – ${formatTime(b)}`
            : ctx.t(e.handle === 'a' ? 'nav-bookmarks.handleA' : 'nav-bookmarks.handleB')
        return { el: el('span', 'bm-tip bm-tip-loop', text), order: 40 }
      },
      onKey(e): void {
        // Shift gives the 0.1 s nudge N18 is about; a bare arrow moves by the
        // host's own step so the gesture matches every other seek-bar handle.
        const step = e.shift ? 0.1 : e.stepSec
        const which = e.handle === 'b' ? 'b' : 'a'
        const from = which === 'a' ? state.loop.a : state.loop.b
        if (from === null) return
        const target =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? duration()
              : Math.max(0, from + (e.key === 'ArrowLeft' ? -step : step))
        ctx.ipc.send('nav-bookmarks:setLoopPoint', { which, t: target })
      }
    })

    // -- the transport button ---------------------------------------------

    ctx.transportButton({
      id: 'nav-bookmarks.toggle',
      order: 30,
      labelKey: 'nav-bookmarks.togglePanel',
      mount(button, api): () => void {
        button.appendChild(svg('M4 2h8v12l-4-3-4 3z'))
        api.pressed(false)
        return ctx.ipc.on<BookmarkPanelState>('nav-bookmarks:state', (s) => api.pressed(s.open))
      },
      onClick(): void {
        ctx.ipc.send('nav-bookmarks:togglePanel')
      }
    })

    // -- the manager panel (N11) ------------------------------------------

    ctx.panel({
      id: 'nav-bookmarks',
      side: 'right',
      titleKey: 'nav-bookmarks.title',
      order: 20,
      mount(host): () => void {
        const head = el('div', 'bm-head')
        const heading = el('h2', undefined, ctx.t('nav-bookmarks.title'))
        const count = el('span', 'bm-count')
        heading.appendChild(count)
        head.appendChild(heading)

        const tools = el('div', 'bm-tools')
        const addBtn = el('button', 'icon-btn small')
        addBtn.type = 'button'
        addBtn.title = ctx.t('nav-bookmarks.add')
        addBtn.setAttribute('aria-label', ctx.t('nav-bookmarks.add'))
        addBtn.appendChild(svg('M8 3v10M3 8h10'))

        const exportBtn = el('button', 'icon-btn small')
        exportBtn.type = 'button'
        exportBtn.title = ctx.t('nav-bookmarks.export')
        exportBtn.setAttribute('aria-label', ctx.t('nav-bookmarks.export'))
        exportBtn.appendChild(svg('M8 2v8M5 7l3 3 3-3M3 13h10'))

        const importBtn = el('button', 'icon-btn small')
        importBtn.type = 'button'
        importBtn.title = ctx.t('nav-bookmarks.import')
        importBtn.setAttribute('aria-label', ctx.t('nav-bookmarks.import'))
        importBtn.appendChild(svg('M8 12V4M5 7l3-3 3 3M3 13h10'))

        const closeBtn = el('button', 'icon-btn small')
        closeBtn.type = 'button'
        closeBtn.setAttribute('aria-label', ctx.t('nav-bookmarks.close'))
        closeBtn.appendChild(svg('M4 4l8 8M12 4l-8 8'))

        tools.append(addBtn, exportBtn, importBtn, closeBtn)
        head.appendChild(tools)

        // N11: "the filter box is the part PotPlayer users actually mention".
        // A 3-hour lecture with 40 bookmarks is unusable as a flat list.
        const filter = el('input', 'bm-filter')
        filter.type = 'search'
        filter.placeholder = ctx.t('nav-bookmarks.filter')
        filter.setAttribute('aria-label', ctx.t('nav-bookmarks.filter'))

        const items = el('ol', 'bm-items')
        const empty = el('p', 'bm-empty', ctx.t('nav-bookmarks.empty'))
        host.append(head, filter, items, empty)

        addBtn.addEventListener('click', () => ctx.ipc.send('nav-bookmarks:add'))
        exportBtn.addEventListener('click', () => ctx.ipc.send('nav-bookmarks:export'))
        importBtn.addEventListener('click', () => ctx.ipc.send('nav-bookmarks:import'))
        closeBtn.addEventListener('click', () => ctx.ipc.send('nav-bookmarks:togglePanel'))
        filter.addEventListener('input', () => render())

        function render(): void {
          host.hidden = !state.open
          count.textContent = state.bookmarks.length ? String(state.bookmarks.length) : ''

          const query = filter.value.trim().toLowerCase()
          const shown = state.bookmarks.filter(
            (b) =>
              !query ||
              b.title.toLowerCase().includes(query) ||
              formatTime(b.t).includes(query)
          )
          empty.hidden = shown.length > 0
          empty.textContent = ctx.t(
            state.bookmarks.length === 0 ? 'nav-bookmarks.empty' : 'nav-bookmarks.noMatch'
          )

          items.textContent = ''
          for (const bookmark of shown) {
            const row = el('li', 'bm-item')
            row.dataset['id'] = bookmark.id

            const time = el('span', 'bm-time', formatTime(bookmark.t))
            // textContent, never innerHTML: the title is user-entered text.
            const name = el('input', 'bm-name')
            name.type = 'text'
            name.value = bookmark.title
            name.setAttribute('aria-label', ctx.t('nav-bookmarks.renamePrompt'))

            row.append(time, name)
            if (bookmark.b !== undefined) {
              row.appendChild(el('span', 'bm-badge', ctx.t('nav-bookmarks.section')))
            }

            const remove = el('button', 'bm-remove')
            remove.type = 'button'
            remove.setAttribute('aria-label', ctx.t('nav-bookmarks.remove'))
            remove.appendChild(svg('M4 4l8 8M12 4l-8 8'))
            row.appendChild(remove)

            time.addEventListener('click', () =>
              ctx.ipc.send('nav-bookmarks:goto', { id: bookmark.id })
            )
            name.addEventListener('change', () =>
              ctx.ipc.send('nav-bookmarks:rename', { id: bookmark.id, title: name.value })
            )
            name.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') name.blur()
              // The overlay's own player keybinds must not fire while a
              // bookmark is being renamed.
              e.stopPropagation()
            })
            remove.addEventListener('click', () =>
              ctx.ipc.send('nav-bookmarks:remove', { id: bookmark.id })
            )
            items.appendChild(row)
          }
        }

        // One subscription for the whole module, at the bottom of `setup`;
        // this panel is repainted through `repaintPanel` rather than adding a
        // second handler that would render every push twice.
        repaintPanel = render
        // Main pushes on change; ask once so a panel mounted after the last
        // push is not empty.
        ctx.ipc.send('nav-bookmarks:request')
        render()
        return () => {
          repaintPanel = () => {}
        }
      }
    })

    // -- the one state subscription, registered LAST -----------------------

    ctx.ipc.on<BookmarkPanelState>('nav-bookmarks:state', (next) => {
      state = next ?? EMPTY
      paintPins()
      paintLoop()
      repaintPanel()
    })
    ctx.ipc.send('nav-bookmarks:request')

    // `duration` arrives on the core PlayerState, not on our channel, and the
    // pins are positioned as a percentage of it — so a file whose duration
    // resolves after the last push would draw every pin at 0.
    ctx.state.subscribe((s) => {
      if (s.duration === state.duration) return
      state = { ...state, duration: s.duration }
      paintPins()
      paintLoop()
    })
  }
}

export default mod
