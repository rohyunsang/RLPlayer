import { onContributionsChanged, panels, t, type PanelSpec } from './feature-host.ts'

/**
 * The consumer for `ctx.panel()`.
 *
 * Before this existed, `panels` was an array nothing read, so every module that
 * needed a side panel — M21's subtitle browser, M26's bookmarks, M27's
 * thumbnails, M29's media info, M30's history, M28's playlist — had to add its
 * own markup to `src/renderer/index.html` and its own rules to `styles.css`.
 * Six modules editing two shared files is six merge conflicts and one verified
 * collision (M28 and M21 both wanted the `#playlist` host).
 *
 * A panel now owns its DOM entirely. The host supplies a docked container per
 * side, in `order`, and watches the module's own element for `hidden` so the
 * layout can react without the module knowing anything about the chrome.
 */

interface Mounted {
  spec: PanelSpec
  container: HTMLElement
  unmount: () => void
  observer: MutationObserver
}

const mounted = new Map<string, Mounted>()
const sides: Record<'left' | 'right' | 'bottom', HTMLElement | null> = {
  left: null,
  right: null,
  bottom: null
}

let root: HTMLElement | null = null

function sideHost(side: 'left' | 'right' | 'bottom'): HTMLElement {
  const existing = sides[side]
  if (existing) return existing
  const el = document.createElement('div')
  el.className = `panel-dock panel-dock-${side}`
  el.dataset['side'] = side
  root?.appendChild(el)
  sides[side] = el
  return el
}

/** True when at least one panel on `side` is currently visible. */
function anyVisible(side: string): boolean {
  for (const m of mounted.values()) {
    if (m.spec.side === side && !m.container.hidden) return true
  }
  return false
}

function syncSideClasses(): void {
  for (const side of ['left', 'right', 'bottom'] as const) {
    document.body.classList.toggle(`panel-${side}-open`, anyVisible(side))
  }
  // Kept for the CSS the overlay already ships: any right-hand panel darkens
  // and narrows the chrome exactly the way the playlist used to.
  document.body.classList.toggle('playlist-open', anyVisible('right'))
}

function mountOne(spec: PanelSpec): void {
  const host = sideHost(spec.side)
  const container = document.createElement('section')
  container.className = 'panel'
  container.dataset['panelId'] = spec.id
  container.setAttribute('aria-label', t(spec.titleKey))
  // Panels start closed. The module opens itself when its own state says so,
  // which is the only place that knows.
  container.hidden = true

  // Insertion respects `order` without re-appending live panels: re-appending
  // an element that owns a drag gesture cancels the gesture.
  const before = [...host.children].find((c) => {
    const other = mounted.get((c as HTMLElement).dataset['panelId'] ?? '')
    return other !== undefined && other.spec.order > spec.order
  })
  host.insertBefore(container, before ?? null)

  const observer = new MutationObserver(syncSideClasses)
  observer.observe(container, { attributes: true, attributeFilter: ['hidden'] })

  let unmount: () => void = () => {}
  try {
    unmount = spec.mount(container) ?? (() => {})
  } catch (e) {
    console.error(`[panel-host] panel '${spec.id}' failed to mount:`, e)
    container.remove()
    observer.disconnect()
    return
  }
  mounted.set(spec.id, { spec, container, unmount, observer })
  syncSideClasses()
}

/** Mount every registered panel, and anything registered later. */
export function initPanelHost(container: HTMLElement): void {
  root = container
  const sync = (): void => {
    for (const spec of panels) {
      if (!mounted.has(spec.id)) mountOne(spec)
    }
  }
  sync()
  onContributionsChanged(sync)
}

export function disposePanelHost(): void {
  for (const m of mounted.values()) {
    m.observer.disconnect()
    try {
      m.unmount()
    } catch (e) {
      console.error(`[panel-host] panel '${m.spec.id}' unmount threw:`, e)
    }
    m.container.remove()
  }
  mounted.clear()
}
