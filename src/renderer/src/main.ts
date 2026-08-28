import './styles.css'
import type {
  OsdPayload,
  PlayerState,
  PlaylistState,
  ResolvedKeybinds,
  ToastPayload
} from '@shared/types'
import { accelFromEvent } from '@shared/input/accel'
import { clamp, displayName, el, formatTime } from './util'
import {
  SeekbarHost,
  attachSeekbar,
  initPanelHost,
  initStatsHost,
  loadRendererFeatures,
  publishState,
  registerRendererMessages,
  setOsdSink,
  statsOnStateChange,
  toggleStats
} from './core'

const api = window.rlplayer

// --- element lookups ------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing element #${id}`)
  return node as T
}

const stage = $('stage')
const mediaTitle = $('mediaTitle')
const seek = $<HTMLInputElement>('seek')
const seekBuffer = $('seekBuffer')
const seekHover = $('seekHover')
const seekLayers = $('seekLayers')
const timeNow = $('timeNow')
const timeTotal = $('timeTotal')
const playBtn = $<HTMLButtonElement>('playBtn')
const playIcon = $('playIcon')
const volume = $<HTMLInputElement>('volume')
const volReadout = $('volReadout')
const muteBtn = $<HTMLButtonElement>('muteBtn')
const speedBtn = $<HTMLButtonElement>('speedBtn')
const subBtn = $<HTMLButtonElement>('subBtn')
const playlistBtn = $<HTMLButtonElement>('playlistBtn')
const fsBtn = $<HTMLButtonElement>('fsBtn')
const maxBtn = $<HTMLButtonElement>('maxBtn')
const osd = $('osd')
const toasts = $('toasts')
const dropzone = $('dropzone')
const shortcutModal = $('shortcutModal')
const shortcutList = $('shortcutList')
const videoRegion = $('videoRegion')
// The two contribution hosts. Everything inside them is a module's, never the
// overlay's: `panelRoot` docks whatever `ctx.panel()` registered, `stats` shows
// whatever `ctx.statsSection()` registered.
const panelRoot = $('panelRoot')
const statsPanel = $('stats')

// --- local view state -----------------------------------------------------

let state: PlayerState | null = null
let keybinds: ResolvedKeybinds = {}
/** While the user drags the seek bar we must ignore incoming time-pos. */
let scrubbing = false
let osdTimer: number | undefined
let idleTimer: number | undefined

const SEEK_STEP = 0.1

/**
 * The interactive seek-bar layer host (§3.4). Contributed layers paint into
 * `#seekLayers` and are offered the pointer in reverse paint order; when none
 * of them claims a press, the host falls through to the ordinary scrub below,
 * which is why adding a bookmark pin can never silently break drag-to-seek.
 */
const seekbar = attachSeekbar(
  new SeekbarHost({
    el: seekLayers,
    duration: () => state?.duration ?? 0,
    width: () => seek.getBoundingClientRect().width,
    scrub(time, phase, cancelled) {
      if (phase === 'down') {
        scrubbing = true
        document.body.classList.add('scrubbing')
      }
      if (!cancelled) api.action({ type: 'seek', seconds: time, absolute: true })
      if (phase === 'up') {
        scrubbing = false
        document.body.classList.remove('scrubbing')
      }
    },
    invalidate: () => {
      if (state) seekbar.render()
    }
  })
)

// --- rendering ------------------------------------------------------------

function fillPercent(input: HTMLInputElement): void {
  const min = Number(input.min)
  const max = Number(input.max)
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0
  input.style.setProperty('--fill', `${pct}%`)
}

/**
 * Compat layout: main needs the exact rectangle we reserved for video so it can
 * place mpv's inset child window there. Reported whenever the box changes.
 */
function reportVideoRegion(): void {
  if (state?.layoutMode !== 'compat') return
  const r = videoRegion.getBoundingClientRect()
  api.window.setVideoRegion({
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height)
  })
}

const regionObserver = new ResizeObserver(reportVideoRegion)
regionObserver.observe(videoRegion)
window.addEventListener('resize', reportVideoRegion)

function render(s: PlayerState): void {
  const layoutChanged = state?.layoutMode !== s.layoutMode
  state = s
  publishState(s)
  statsOnStateChange()
  seekbar.render()
  document.body.classList.toggle('idle', s.idle || !s.path)
  document.body.classList.toggle('fullscreen', s.fullscreen)
  document.body.classList.toggle('compat', s.layoutMode === 'compat')
  if (layoutChanged) reportVideoRegion()

  mediaTitle.textContent = s.path ? s.title || displayName(s.path) : '재생 중인 파일 없음'
  document.title = s.path ? `${s.title || displayName(s.path)} - RLPlayer` : 'RLPlayer'

  // seek bar
  const dur = s.duration > 0 ? s.duration : 0
  seek.max = String(dur || 1)
  seek.step = String(SEEK_STEP)
  seek.disabled = dur <= 0
  if (!scrubbing) {
    seek.value = String(clamp(s.timePos, 0, dur || 1))
    fillPercent(seek)
  }
  seek.setAttribute('aria-valuetext', `${formatTime(s.timePos)} / ${formatTime(dur)}`)
  timeNow.textContent = formatTime(scrubbing ? Number(seek.value) : s.timePos)
  timeTotal.textContent = formatTime(dur)

  // buffered-ahead indicator
  if (dur > 0) {
    const ahead = clamp((s.timePos + s.cacheSeconds) / dur, 0, 1) * 100
    seekBuffer.style.width = `${ahead}%`
  } else {
    seekBuffer.style.width = '0'
  }

  // play / pause
  const playing = !s.paused && !s.idle
  playIcon.innerHTML = ''
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('class', 'fill')
  p.setAttribute('d', playing ? 'M4 2.5h3.2v11H4zM8.8 2.5H12v11H8.8z' : 'M4 2.5l9 5.5-9 5.5z')
  playIcon.appendChild(p)
  playBtn.setAttribute('aria-label', playing ? '일시정지' : '재생')

  // volume
  if (document.activeElement !== volume) {
    volume.value = String(s.volume)
    fillPercent(volume)
  }
  volReadout.textContent = s.muted ? '음소거' : `${s.volume}%`
  volReadout.classList.toggle('boosted', !s.muted && s.volume > 100)
  muteBtn.setAttribute('aria-pressed', String(s.muted))
  muteBtn.setAttribute('aria-label', s.muted ? '음소거 해제' : '음소거')

  speedBtn.textContent = `${s.speed.toFixed(2)}×`
  subBtn.setAttribute('aria-pressed', String(s.sid !== false))
  fsBtn.setAttribute('aria-label', s.fullscreen ? '전체화면 종료' : '전체화면')
  maxBtn.setAttribute('aria-label', s.maximized ? '이전 크기로' : '최대화')
}

/**
 * The playlist PANEL is M28's, contributed through `ctx.panel()` and living
 * entirely in `src/renderer/src/features/playlist/`. What is left here is the
 * transport bar's own toggle button, which the overlay owns: it needs to know
 * whether the panel is open so it can show a pressed state.
 */
function renderPlaylistButton(p: PlaylistState): void {
  playlistBtn.setAttribute('aria-pressed', String(p.open))
}

// --- OSD ------------------------------------------------------------------

/**
 * ONE OSD element, always. Messages coalesce by `kind`, so dragging the volume
 * slider produces a single updating readout rather than forty stacked ones --
 * and because main applies the per-kind enable/disable, anything that arrives
 * here is something the user asked to see.
 */
function showOsd(msg: OsdPayload): void {
  osd.dataset.kind = msg.kind
  osd.textContent = msg.text
  osd.classList.add('show')
  window.clearTimeout(osdTimer)
  osdTimer = window.setTimeout(() => osd.classList.remove('show'), msg.durationMs ?? 900)
}

// --- toasts ---------------------------------------------------------------

function showToast(t: ToastPayload): void {
  const node = el('div', `toast${t.kind === 'error' ? ' error' : ''}`)
  node.setAttribute('role', t.kind === 'error' ? 'alert' : 'status')
  node.appendChild(el('span', 'toast-msg', t.message))

  if (t.actionLabel) {
    const btn = el('button', 'toast-action', t.actionLabel)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      // The callback lives in main, keyed by id: a toast action is a module's
      // code, not the overlay's.
      if (typeof t.id === 'number') api.toastAction(t.id)
      node.remove()
    })
    node.appendChild(btn)
  }

  const close = el('button', 'toast-close')
  close.type = 'button'
  close.setAttribute('aria-label', '알림 닫기')
  close.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
  close.addEventListener('click', () => node.remove())
  node.appendChild(close)

  toasts.appendChild(node)
  window.setTimeout(() => node.remove(), t.kind === 'error' ? 8000 : 6000)
}

// --- chrome auto-hide -----------------------------------------------------

function wakeChrome(): void {
  document.body.classList.remove('chrome-hidden', 'hide-cursor')
  window.clearTimeout(idleTimer)
  // Only auto-hide in fullscreen; in a window the controls are part of the
  // frame the user is looking at. Never in compat mode, where hiding the
  // chrome would resize the video region underneath it.
  if (!state?.fullscreen || state.idle || state.layoutMode === 'compat') return
  idleTimer = window.setTimeout(() => {
    if (shortcutModal.hidden === false) return
    document.body.classList.add('chrome-hidden', 'hide-cursor')
  }, 2500)
}

// --- input ----------------------------------------------------------------

let clickTimer: number | undefined

stage.addEventListener('click', () => {
  // Delay so a double-click does not also toggle playback.
  window.clearTimeout(clickTimer)
  clickTimer = window.setTimeout(() => api.action({ type: 'playPause' }), 220)
})

stage.addEventListener('dblclick', () => {
  window.clearTimeout(clickTimer)
  api.window.toggleFullscreen()
})

stage.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  api.menu.popup(Math.round(e.clientX), Math.round(e.clientY))
})

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 5 : -5
    api.action({ type: 'volumeBy', delta })
  },
  { passive: false }
)

document.addEventListener('mousemove', wakeChrome)

// --- seek bar -------------------------------------------------------------
//
// Every pointer gesture on the bar is offered to the contributed layers first
// (topmost wins) and only then to the ordinary scrub. `claimed` is the flag
// that keeps a grabbed A-B handle or bookmark pin from also seeking.

let claimed = false

const barX = (clientX: number): number => {
  const rect = seek.getBoundingClientRect()
  return clamp(clientX - rect.left, 0, rect.width)
}

seek.addEventListener('pointerdown', (e) => {
  seek.setPointerCapture(e.pointerId)
  claimed = seekbar.pointerDown(barX(e.clientX), {
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey
  })
  if (claimed) e.preventDefault()
})

const endScrub = (cancelled: boolean) => (e: PointerEvent): void => {
  if (!seekbar.dragging) return
  seekbar.pointerUp(barX(e.clientX), { shift: e.shiftKey }, cancelled)
  claimed = false
}
seek.addEventListener('pointerup', endScrub(false))
seek.addEventListener('pointercancel', endScrub(true))
// Releasing outside the window must still deliver exactly one onPointerUp.
window.addEventListener('blur', () => {
  if (seekbar.dragging) seekbar.cancel()
  claimed = false
})

seek.addEventListener('input', () => {
  fillPercent(seek)
  timeNow.textContent = formatTime(Number(seek.value))
  // Live-seek while dragging; commandNoReply on the main side keeps this cheap.
  if (scrubbing && !claimed) {
    api.action({ type: 'seek', seconds: Number(seek.value), absolute: true })
  }
})
seek.addEventListener('change', () => {
  if (!scrubbing && !claimed) {
    api.action({ type: 'seek', seconds: Number(seek.value), absolute: true })
  }
})
seek.addEventListener('pointermove', (e) => {
  const x = barX(e.clientX)
  if (seekbar.dragging) {
    seekbar.pointerMove(x, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey })
    if (claimed) return
  } else {
    seekbar.hover(x, { shift: e.shiftKey })
  }
  if (!state || state.duration <= 0) return
  const rect = seek.getBoundingClientRect()
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
  seekHover.hidden = false
  seekHover.textContent = formatTime(ratio * state.duration)
  seekHover.style.left = `${ratio * 100}%`
})
seek.addEventListener('pointerleave', () => {
  seekHover.hidden = true
  if (!seekbar.dragging) seekbar.hover(null)
})

volume.addEventListener('input', () => {
  fillPercent(volume)
  api.action({ type: 'setVolume', value: Number(volume.value) })
})

// --- buttons --------------------------------------------------------------

playBtn.addEventListener('click', () => api.action({ type: 'playPause' }))
$('prevBtn').addEventListener('click', () => api.runBinding('previous'))
$('nextBtn').addEventListener('click', () => api.runBinding('next'))
muteBtn.addEventListener('click', () => api.action({ type: 'toggleMute' }))
fsBtn.addEventListener('click', () => api.window.toggleFullscreen())
playlistBtn.addEventListener('click', () => api.playlist.togglePanel())
subBtn.addEventListener('click', () => api.action({ type: 'toggleSubs' }))
speedBtn.addEventListener('click', (e) => {
  // Left click steps up, right click steps down, both wrap within 0.25-4x.
  api.action({ type: 'speedBy', delta: e.shiftKey ? -0.25 : 0.25 })
})
speedBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  api.action({ type: 'setSpeed', value: 1 })
})

$('menuBtn').addEventListener('click', () => {
  const r = $('menuBtn').getBoundingClientRect()
  api.menu.popup(Math.round(r.left), Math.round(r.bottom))
})
$('minBtn').addEventListener('click', () => api.window.minimize())
maxBtn.addEventListener('click', () => api.window.toggleMaximize())
$('closeBtn').addEventListener('click', () => api.window.close())

// --- window move / resize -------------------------------------------------

const titlebarDrag = $('titlebarDrag')
titlebarDrag.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  titlebarDrag.setPointerCapture(e.pointerId)
  api.window.beginDrag('move')
})
titlebarDrag.addEventListener('pointerup', () => api.window.endDrag())
titlebarDrag.addEventListener('pointercancel', () => api.window.endDrag())
titlebarDrag.addEventListener('dblclick', () => api.window.toggleMaximize())

for (const handle of document.querySelectorAll<HTMLElement>('.rz')) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    handle.setPointerCapture(e.pointerId)
    api.window.beginDrag('resize', handle.dataset.edge)
  })
  handle.addEventListener('pointerup', () => api.window.endDrag())
  handle.addEventListener('pointercancel', () => api.window.endDrag())
}

// --- file drop ------------------------------------------------------------

let dragDepth = 0

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  dropzone.hidden = false
})
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropzone.hidden = true
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  dropzone.hidden = true
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => api.pathForFile(f)).filter(Boolean)
  if (paths.length > 0) api.openPaths(paths)
})

// --- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  const inRange = target instanceof HTMLInputElement && target.type === 'range'

  if (!shortcutModal.hidden && e.key === 'Escape') {
    shortcutModal.hidden = true
    return
  }

  // Let the focused slider handle its own arrow keys rather than double-acting.
  if (inRange && /^Arrow/.test(e.key)) return

  // e.code, never e.key: with the Korean IME composing, e.key is 'Process'
  // for every letter and every bare-letter binding silently stops working.
  const accel = accelFromEvent(e)
  const entry = keybinds[accel]
  if (!entry) return

  e.preventDefault()
  wakeChrome()
  // The OSD is main's job now: the module that changes the value is the one
  // that knows what to say about it.
  api.invokeCommand(entry.commandId)
})

// --- shortcut sheet -------------------------------------------------------

function renderShortcuts(): void {
  shortcutList.textContent = ''
  const dl = document.createElement('dl')
  dl.className = 'shortcut-list'
  // Both halves come from the command registry: the label from the command's
  // own labelKey, the key from whichever preset is active. Nothing here knows
  // what any of the commands do.
  const rows = Object.values(keybinds).sort((a, b) => a.label.localeCompare(b.label))
  for (const entry of rows) {
    dl.append(el('dt', undefined, entry.accelLabel), el('dd', undefined, entry.label))
  }
  shortcutList.appendChild(dl)
}

$('shortcutClose').addEventListener('click', () => {
  shortcutModal.hidden = true
})

// --- wiring ---------------------------------------------------------------

api.onState(render)
api.onPlaylist(renderPlaylistButton)
api.onToast(showToast)
api.onOsd(showOsd)
api.onKeybinds((k) => {
  keybinds = k
  renderShortcuts()
})
api.onUiCommand((name) => {
  if (name === 'showShortcuts') {
    renderShortcuts()
    shortcutModal.hidden = false
    $('shortcutClose').focus()
  }
  // The stats overlay is core's host; every row in it is a module's
  // `ctx.statsSection()`.
  if (name === 'toggleStats') toggleStats('full')
})

wakeChrome()

/**
 * Boot, once.
 *
 * The catalog is fetched BEFORE the modules are set up, because a module's
 * `mount()` calls `ctx.t()` while it builds its DOM and a label resolved after
 * the fact would need every panel to re-render. This runs exactly once: an
 * accidental second call used to re-enter every module's `setup()`, and the
 * loader now refuses it outright.
 */
async function boot(): Promise<void> {
  setOsdSink((m) => showOsd({ kind: m.kind, text: m.text, value: m.value }))
  try {
    const messages = (await window.rl.invoke('core-i18n:messages')) as Record<string, string>
    registerRendererMessages(messages)
  } catch (e) {
    // A missing catalog means keys render as their ids, which is ugly but
    // usable. It must never stop the overlay from coming up.
    console.warn('[overlay] message catalog unavailable:', e)
  }
  initPanelHost(panelRoot)
  initStatsHost(statsPanel)
  // Renderer feature modules, discovered by the same directory glob main uses.
  loadRendererFeatures('player')
  seekbar.render()
}

void boot()
