import { onContributionsChanged, statsSections, t } from './feature-host.ts'
import type { StatsSection } from '../../../shared/renderer-api.ts'

/**
 * The consumer for `ctx.statsSection()` — the stats overlay (mpv's `i` panel,
 * rebuilt so it is ours and every module can add a row to it).
 *
 * Without a consumer, `statsSections` was an array nothing read, so M29's media
 * info, M07's decoder readout and M13's loudness meters would all have had to
 * add markup to the shared `main.ts`. A section now declares its fields and its
 * refresh policy and knows nothing about the overlay.
 *
 * Three refresh modes, and the reason they exist: a `static` section is read
 * once when the panel opens (codec, resolution); `onChange` re-reads when one
 * of the named mpv properties changes, which the player state already carries;
 * `poll` is for values that have no property to watch (dropped frames per
 * second, an encoder's progress). Everything stops when the panel is hidden —
 * a stats panel that keeps polling behind a closed overlay is a battery bug.
 */

let container: HTMLElement | null = null
let visible = false
let level: 'full' | 'short' | 'misc' = 'full'
const timers = new Map<string, number>()

function wanted(s: StatsSection): boolean {
  return !s.levels || s.levels.includes(level)
}

function renderSection(s: StatsSection): HTMLElement {
  const box = document.createElement('section')
  box.className = 'stats-section'
  box.dataset['sectionId'] = s.id

  const h = document.createElement('h3')
  h.textContent = t(s.titleKey)
  box.appendChild(h)

  const dl = document.createElement('dl')
  let fields: ReadonlyArray<{ labelKey: string; value: string }> = []
  try {
    fields = s.fields()
  } catch (e) {
    // One module's broken fields() must not blank the whole panel.
    console.error(`[stats-host] section '${s.id}' fields() threw:`, e)
    fields = [{ labelKey: 'core.statsError', value: String((e as Error).message) }]
  }
  for (const f of fields) {
    const dt = document.createElement('dt')
    dt.textContent = t(f.labelKey)
    const dd = document.createElement('dd')
    // textContent, never innerHTML: these strings come from file metadata.
    dd.textContent = f.value
    dl.append(dt, dd)
  }
  box.appendChild(dl)
  return box
}

function repaint(): void {
  if (!container || !visible) return
  container.textContent = ''
  const shown = statsSections.filter(wanted)
  if (shown.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'stats-empty'
    empty.textContent = t('core.statsEmpty')
    container.appendChild(empty)
    return
  }
  for (const s of shown) container.appendChild(renderSection(s))
}

function stopTimers(): void {
  for (const id of timers.values()) window.clearInterval(id)
  timers.clear()
}

function startTimers(): void {
  stopTimers()
  if (!visible) return
  for (const s of statsSections) {
    if (s.refresh?.mode !== 'poll') continue
    const every = Math.max(200, s.refresh.intervalMs)
    timers.set(s.id, window.setInterval(repaint, every))
  }
}

/** Called by the overlay whenever the player state changes. */
export function statsOnStateChange(): void {
  if (!visible) return
  // `onChange` sections watch mpv property names; the overlay only receives the
  // derived PlayerState, so any state push is treated as "something changed".
  // Cheaper than a second observation channel and indistinguishable to the eye.
  if (statsSections.some((s) => s.refresh?.mode === 'onChange')) repaint()
}

/**
 * Core's own section: mpv property writes the owner map refused.
 *
 * In a dev build a foreign write throws and this stays empty. In a SHIPPED
 * build it is dropped and counted instead, so that one misbehaving module
 * cannot black-screen the player — and until now the count went nowhere at all.
 * `refusalCount` was never read anywhere in `src/`, which made "surfaced in
 * stats" a comment rather than a fact, and made a module quietly corrupting
 * another's state indistinguishable from a module working.
 *
 * Here it is, surfaced for real, on a poll because there is no property to
 * watch and refusals are rare enough that two seconds is generous.
 */
function registerRefusalSection(read: () => Promise<Array<{ moduleId: string; count: number }>>): void {
  let refusals: Array<{ moduleId: string; count: number }> = []
  const pull = (): void => {
    void read()
      .then((r) => {
        refusals = r
      })
      .catch(() => {
        refusals = []
      })
  }
  pull()
  statsSections.push({
    id: 'core.refusals',
    order: 90,
    titleKey: 'core.refusals',
    refresh: { mode: 'poll', intervalMs: 2000 },
    fields: () => {
      pull()
      if (refusals.length === 0) return [{ labelKey: 'core.refusals', value: '—' }]
      return refusals.map((r) => ({ labelKey: r.moduleId, value: String(r.count) }))
    }
  })
  statsSections.sort((a, b) => a.order - b.order)
}

export function initStatsHost(
  el: HTMLElement,
  readRefusals?: () => Promise<Array<{ moduleId: string; count: number }>>
): void {
  container = el
  if (readRefusals) registerRefusalSection(readRefusals)
  onContributionsChanged(() => {
    if (visible) {
      repaint()
      startTimers()
    }
  })
}

export function statsVisible(): boolean {
  return visible
}

export function setStatsVisible(on: boolean, which: 'full' | 'short' | 'misc' = 'full'): void {
  visible = on
  level = which
  if (container) container.hidden = !on
  if (on) {
    repaint()
    startTimers()
  } else {
    stopTimers()
    if (container) container.textContent = ''
  }
}

export function toggleStats(which: 'full' | 'short' | 'misc' = 'full'): void {
  setStatsVisible(!(visible && level === which), which)
}
