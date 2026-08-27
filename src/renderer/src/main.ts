import './styles.css'
import type { Keybinds, PlayerState, PlaylistState, ToastPayload } from '@shared/types'
import { eventToAccel } from '@shared/keybinds'
import { clamp, displayName, el, formatTime } from './util'

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
const playlistPanel = $('playlist')
const plItems = $<HTMLOListElement>('plItems')
const plCount = $('plCount')
const shuffleBtn = $<HTMLButtonElement>('shuffleBtn')
const repeatBtn = $<HTMLButtonElement>('repeatBtn')
const repeatBadge = $('repeatBadge')
const shortcutModal = $('shortcutModal')
const shortcutList = $('shortcutList')
const videoRegion = $('videoRegion')

// --- local view state -----------------------------------------------------

let state: PlayerState | null = null
let playlist: PlaylistState = { items: [], index: -1, open: false, repeat: 'off', shuffle: false }
let keybinds: Keybinds = {}
/** While the user drags the seek bar we must ignore incoming time-pos. */
let scrubbing = false
let osdTimer: number | undefined
let idleTimer: number | undefined

const SEEK_STEP = 0.1

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

function renderPlaylist(p: PlaylistState): void {
  playlist = p
  document.body.classList.toggle('playlist-open', p.open)
  playlistPanel.hidden = !p.open
  playlistBtn.setAttribute('aria-pressed', String(p.open))
  shuffleBtn.setAttribute('aria-pressed', String(p.shuffle))
  repeatBtn.setAttribute('aria-pressed', String(p.repeat !== 'off'))
  repeatBadge.hidden = p.repeat !== 'one'
  plCount.textContent = p.items.length ? `${p.index + 1}/${p.items.length}` : ''

  plItems.textContent = ''
  p.items.forEach((item, i) => {
    const li = el('li', 'pl-item' + (i === p.index ? ' current' : ''))
    li.tabIndex = 0
    li.draggable = true
    li.dataset.index = String(i)
    li.setAttribute('role', 'button')
    // textContent, never innerHTML: this string comes from a filesystem path.
    const name = el('span', 'pl-name', item.name)
    name.title = item.name
    li.appendChild(name)

    const rm = el('button', 'pl-remove')
    rm.type = 'button'
    rm.setAttribute('aria-label', `${item.name} 제거`)
    rm.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
    rm.addEventListener('click', (e) => {
      e.stopPropagation()
      api.playlist.remove(i)
    })
    li.appendChild(rm)

    li.addEventListener('dblclick', () => api.playlist.play(i))
    li.addEventListener('click', () => api.playlist.play(i))
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        api.playlist.play(i)
      }
    })
    plItems.appendChild(li)
  })

  const current = plItems.children[p.index]
  current?.scrollIntoView({ block: 'nearest' })
}

// --- OSD ------------------------------------------------------------------

function showOsd(text: string): void {
  osd.textContent = text
  osd.classList.add('show')
  window.clearTimeout(osdTimer)
  osdTimer = window.setTimeout(() => osd.classList.remove('show'), 900)
}

// --- toasts ---------------------------------------------------------------

function showToast(t: ToastPayload): void {
  const node = el('div', `toast${t.kind === 'error' ? ' error' : ''}`)
  node.setAttribute('role', t.kind === 'error' ? 'alert' : 'status')
  node.appendChild(el('span', 'toast-msg', t.message))

  if (t.actionLabel && t.action) {
    const btn = el('button', 'toast-action', t.actionLabel)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      if (t.action === 'restart') api.restart()
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

// seek bar: drag scrubbing
seek.addEventListener('pointerdown', () => {
  scrubbing = true
  document.body.classList.add('scrubbing')
})
const endScrub = (): void => {
  if (!scrubbing) return
  scrubbing = false
  document.body.classList.remove('scrubbing')
  api.action({ type: 'seek', seconds: Number(seek.value), absolute: true })
}
seek.addEventListener('pointerup', endScrub)
seek.addEventListener('pointercancel', endScrub)
seek.addEventListener('input', () => {
  fillPercent(seek)
  timeNow.textContent = formatTime(Number(seek.value))
  // Live-seek while dragging; commandNoReply on the main side keeps this cheap.
  if (scrubbing) api.action({ type: 'seek', seconds: Number(seek.value), absolute: true })
})
seek.addEventListener('change', () => {
  if (!scrubbing) api.action({ type: 'seek', seconds: Number(seek.value), absolute: true })
})
seek.addEventListener('pointermove', (e) => {
  if (!state || state.duration <= 0) return
  const rect = seek.getBoundingClientRect()
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
  seekHover.hidden = false
  seekHover.textContent = formatTime(ratio * state.duration)
  seekHover.style.left = `${ratio * 100}%`
})
seek.addEventListener('pointerleave', () => {
  seekHover.hidden = true
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
$('plCloseBtn').addEventListener('click', () => api.playlist.togglePanel())
subBtn.addEventListener('click', () => api.action({ type: 'toggleSubs' }))
shuffleBtn.addEventListener('click', () => api.playlist.setShuffle(!playlist.shuffle))
repeatBtn.addEventListener('click', () => {
  const order = ['off', 'one', 'all'] as const
  const next = order[(order.indexOf(playlist.repeat) + 1) % order.length]!
  api.playlist.setRepeat(next)
  showOsd({ off: '반복 없음', one: '한 파일 반복', all: '전체 반복' }[next])
})
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

// --- playlist drag reorder ------------------------------------------------

let dragFrom = -1

plItems.addEventListener('dragstart', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
  if (!li) return
  dragFrom = Number(li.dataset.index)
  li.classList.add('dragging')
  e.dataTransfer?.setData('text/plain', String(dragFrom))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
})

plItems.addEventListener('dragover', (e) => {
  e.preventDefault()
  const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
  for (const n of plItems.querySelectorAll('.drag-over')) n.classList.remove('drag-over')
  li?.classList.add('drag-over')
})

plItems.addEventListener('drop', (e) => {
  e.preventDefault()
  e.stopPropagation()
  const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
  for (const n of plItems.querySelectorAll('.drag-over')) n.classList.remove('drag-over')
  if (!li || dragFrom < 0) return
  const to = Number(li.dataset.index)
  if (to !== dragFrom) api.playlist.reorder(dragFrom, to)
  dragFrom = -1
})

plItems.addEventListener('dragend', () => {
  for (const n of plItems.querySelectorAll('.dragging')) n.classList.remove('dragging')
  dragFrom = -1
})

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

const BINDING_LABELS: Record<string, string> = {
  playPause: '재생 / 일시정지',
  stop: '정지',
  seek: '탐색',
  seekStart: '처음으로',
  seekEnd: '끝으로',
  volume: '볼륨',
  mute: '음소거',
  speed: '재생 속도',
  speedReset: '속도 초기화',
  frameBack: '이전 프레임',
  frameForward: '다음 프레임',
  screenshot: '스크린샷 저장',
  screenshotClipboard: '스크린샷 복사',
  toggleSubs: '자막 켜기/끄기',
  cycleSub: '자막 트랙 전환',
  cycleAudio: '오디오 트랙 전환',
  subDelay: '자막 싱크',
  audioDelay: '오디오 싱크',
  chapterNext: '다음 챕터',
  chapterPrev: '이전 챕터',
  next: '다음 파일',
  previous: '이전 파일',
  fullscreen: '전체화면',
  exitFullscreen: '전체화면 종료',
  alwaysOnTop: '항상 위에',
  togglePlaylist: '재생목록',
  open: '파일 열기',
  settings: '설정',
  quit: '종료'
}

function bindingLabel(binding: string): string {
  const [name, arg] = binding.split(':')
  const base = BINDING_LABELS[name ?? ''] ?? binding
  if (arg === undefined) return base
  const n = Number(arg)
  if (name === 'seek') return `${base} ${n > 0 ? '+' : ''}${n}초`
  if (name === 'volume') return `${base} ${n > 0 ? '+' : ''}${n}%`
  if (name === 'speed') return `${base} ${n > 0 ? '+' : ''}${n}×`
  if (name === 'subDelay' || name === 'audioDelay') return `${base} ${n > 0 ? '+' : ''}${n}초`
  return `${base} ${arg}`
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  const inRange = target instanceof HTMLInputElement && target.type === 'range'

  if (!shortcutModal.hidden && e.key === 'Escape') {
    shortcutModal.hidden = true
    return
  }

  // Let the focused slider handle its own arrow keys rather than double-acting.
  if (inRange && /^Arrow/.test(e.key)) return

  const accel = eventToAccel(e)
  const binding = keybinds[accel]
  if (!binding) return

  e.preventDefault()
  wakeChrome()

  // Give immediate visual feedback for the adjustments that have no other
  // on-screen affordance in fullscreen.
  const [name, arg] = binding.split(':')
  if (name === 'volume' && state) {
    showOsd(`${clamp(state.volume + Number(arg), 0, 150)}%`)
  } else if (name === 'speed' && state) {
    showOsd(`${clamp(state.speed + Number(arg), 0.25, 4).toFixed(2)}×`)
  } else if (name === 'seek') {
    showOsd(`${Number(arg) > 0 ? '▶▶' : '◀◀'} ${Math.abs(Number(arg))}초`)
  }

  api.runBinding(binding)
})

// --- shortcut sheet -------------------------------------------------------

function renderShortcuts(): void {
  shortcutList.textContent = ''
  const dl = document.createElement('dl')
  dl.className = 'shortcut-list'
  for (const [accel, binding] of Object.entries(keybinds)) {
    const dt = el('dt', undefined, accel)
    const dd = el('dd', undefined, bindingLabel(binding))
    dl.append(dt, dd)
  }
  shortcutList.appendChild(dl)
}

$('shortcutClose').addEventListener('click', () => {
  shortcutModal.hidden = true
})

// --- wiring ---------------------------------------------------------------

api.onState(render)
api.onPlaylist(renderPlaylist)
api.onToast(showToast)
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
})

wakeChrome()
