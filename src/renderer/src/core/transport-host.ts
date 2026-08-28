import { onContributionsChanged, t, transportButtons } from './feature-host.ts'

/**
 * The consumer for `ctx.transportButton()`.
 *
 * WHAT IT REPLACES. `src/renderer/index.html` carried `#subBtn` (M17's subtitle
 * toggle) and `#playlistBtn` (M28's playlist toggle) as literal markup, with
 * their click handlers and their pressed-state rendering in
 * `src/renderer/src/main.ts`. Both files are `core-renderer`'s and both appear
 * in the `mustNotTouch` list of 40 of the 55 rows in `docs/parity/modules.json`.
 *
 * That is the third instance of one pattern. `#playlist` was a panel host in a
 * core file until `ctx.panel()`; `.seek-chapter-tick` was a module's style in a
 * core stylesheet until the seek-bar layer host handed each layer its own
 * container. Each time, the module that got there first set a precedent and the
 * next four followed it into the same file. Here the next four are M22 (capture
 * still), M26 (bookmarks), M27 (thumbnails) and M35 (open URL), and §6.3 wants
 * several of them at once.
 *
 * The division of labour is the same as `panel-host`: core owns the `<button>`,
 * its `icon-btn` class, its position in the row and its accessible name; the
 * module owns what is inside it and what happens on click. A module therefore
 * never names a core class and never has a reason to style one.
 */

interface Mounted {
  unmount: () => void
  el: HTMLButtonElement
}

const mounted = new Map<string, Mounted>()
let host: HTMLElement | null = null

function sync(): void {
  if (!host) return
  for (const spec of transportButtons) {
    if (mounted.has(spec.id)) continue
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'icon-btn'
    el.dataset['transportButton'] = spec.id
    const label = t(spec.labelKey)
    el.setAttribute('aria-label', label)
    el.title = label
    el.addEventListener('click', (e) => {
      try {
        spec.onClick({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, button: e.button })
      } catch (err) {
        console.error(`[transport] button '${spec.id}' onClick threw:`, err)
      }
    })
    let unmount = (): void => {}
    try {
      unmount =
        spec.mount(el, {
          pressed: (on) => el.setAttribute('aria-pressed', String(on))
        }) ?? (() => {})
    } catch (err) {
      console.error(`[transport] button '${spec.id}' mount threw:`, err)
    }
    mounted.set(spec.id, { unmount, el })
  }

  // Re-append in `order`. A late registration must not land at the end of the
  // row just because it arrived late — the row's left-to-right order is part of
  // the design, not an accident of module load order.
  for (const spec of transportButtons) {
    const m = mounted.get(spec.id)
    if (m) host.appendChild(m.el)
  }
}

export function initTransportHost(el: HTMLElement): void {
  host = el
  sync()
  onContributionsChanged(sync)
}

/** Tests only. */
export function __resetTransportHost(): void {
  for (const m of mounted.values()) {
    try {
      m.unmount()
    } catch {
      /* a module's teardown must not stop the rest */
    }
    m.el.remove()
  }
  mounted.clear()
  host = null
}
