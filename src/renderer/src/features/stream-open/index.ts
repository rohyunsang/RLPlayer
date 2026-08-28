import './stream-open.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M35 stream-open, renderer half.
 *
 * Four contribution points, no shared file touched:
 *
 *   `transportButton` — the Open URL toggle. R33's "minimum viable version" is
 *       "make the Open URL dialog remember servers", so the box and the history
 *       are one panel rather than a modal.
 *   `panel`          — the URL box, the recent list, R20's lock-open badge and
 *       R12's reload note.
 *   `seekbarLayer`   — R24, and it is the single most legible piece of streaming
 *       UI in the spec: for a live stream the seek bar shows the CACHED WINDOW
 *       and not a 0..duration bar, because `duration` is 0 or unknown for live.
 *   `statsSection`   — R16/R18's numbers in the `I` overlay.
 *   `settingsSection`— the two measured footguns R19 and R14 say to state in the
 *       UI, where the descriptor's own `descriptionKey` is not enough room.
 *
 * Everything user-visible resolves through `ctx.t()`; the keys are registered by
 * the main half, in ko and en.
 */

// The shapes the main half sends. Structural, not imported: `src/shared/` has no
// `features/stream-open/` directory in this module's `ownedFiles`, so putting a
// shared type there would be a partition failure. Both halves are in this row,
// and this comment plus the channel name is the contract.
interface RecentUrl {
  readonly url: string
  readonly title: string
  readonly lastPlayed: number
}

interface StreamPanelState {
  readonly open: boolean
  readonly recent: readonly RecentUrl[]
  readonly currentUrl: string | null
  readonly tlsOverridden: boolean
  readonly hlsReloadHint: boolean
}

interface CacheRange {
  readonly start: number
  readonly end: number
}

type BufferState =
  | { readonly network: false }
  | {
      readonly network: true
      readonly stalled: boolean
      readonly percent: number | null
      readonly seconds: number | null
      readonly forwardBytes: number | null
      readonly inputRate: number | null
      readonly cacheSpeed: number | null
      readonly fileCacheBytes: number | null
      readonly ranges: readonly CacheRange[]
      readonly bofCached: boolean
      readonly eofCached: boolean
      readonly live: boolean
    }

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
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

/**
 * Bytes, mirrored from the main half's `formatBytes` on purpose.
 *
 * The main half's version is tested; this one is four lines of presentation in a
 * different process. The alternative is a `src/shared/features/stream-open/`
 * directory, and this module's row does not own one — see the note on the state
 * types above. Reported rather than smuggled.
 */
function bytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

const EMPTY: StreamPanelState = {
  open: false,
  recent: [],
  currentUrl: null,
  tlsOverridden: false,
  hlsReloadHint: false
}

const mod: RendererFeatureModule = {
  id: 'stream-open',

  setup(ctx): void {
    let state: StreamPanelState = EMPTY
    let buffer: BufferState = { network: false }
    const stateListeners = new Set<(s: StreamPanelState) => void>()
    const bufferListeners = new Set<(b: BufferState) => void>()

    ctx.ipc.on<StreamPanelState>('stream-open:state', (s) => {
      if (!s) return
      state = s
      for (const cb of stateListeners) cb(s)
    })
    ctx.ipc.on<BufferState>('stream-open:buffer', (b) => {
      if (!b) return
      buffer = b
      for (const cb of bufferListeners) cb(b)
    })

    // -----------------------------------------------------------------------
    // The settings window gets the prose sections and nothing else.
    // -----------------------------------------------------------------------
    if (ctx.surface === 'settings') {
      ctx.settingsSection({
        id: 'stream-open.streamNotes',
        section: 'advanced',
        // 13: 'advanced' already has mediainfo at 22, and capture-encode holds 12
        // in 'general'. Whether the ordering namespace is per-section or global
        // is not something a module should have to know, so pick a number free
        // under both readings — a tie is rejected at boot either way.
        order: 13,
        titleKey: 'stream-open.notesTitle',
        mount(host): () => void {
          const wrap = el('div', 'so-settings-note')
          for (const key of [
            'stream-open.noteProxy',
            'stream-open.noteRtsp',
            'stream-open.noteTls'
          ]) {
            wrap.appendChild(el('p', undefined, ctx.t(key)))
          }
          host.appendChild(wrap)
          return () => wrap.remove()
        }
      })
      return
    }

    // -----------------------------------------------------------------------
    // R01/R03: the box
    // -----------------------------------------------------------------------
    ctx.transportButton({
      id: 'stream-open.toggle',
      order: 50,
      labelKey: 'stream-open.openUrl',
      mount(button, api): () => void {
        button.appendChild(svg('M6 10a3 3 0 010-4l2-2a3 3 0 014 4l-1 1M10 6a3 3 0 010 4l-2 2a3 3 0 01-4-4l1-1'))
        api.pressed(state.open)
        const cb = (s: StreamPanelState): void => api.pressed(s.open)
        stateListeners.add(cb)
        return () => stateListeners.delete(cb)
      },
      onClick(): void {
        ctx.ipc.send('stream-open:togglePanel')
      }
    })

    ctx.panel({
      id: 'stream-open',
      side: 'right',
      titleKey: 'stream-open.panelTitle',
      order: 30,
      mount(host): () => void {
        const root = el('div', 'so-panel')

        const head = el('div', 'so-head')
        head.appendChild(el('h2', undefined, ctx.t('stream-open.panelTitle')))
        const close = el('button', 'icon-btn small')
        close.type = 'button'
        close.setAttribute('aria-label', ctx.t('stream-open.closePanel'))
        close.appendChild(svg('M4 4l8 8M12 4l-8 8'))
        close.addEventListener('click', () => ctx.ipc.send('stream-open:togglePanel'))
        head.appendChild(close)

        const form = el('form', 'so-form')
        const input = el('input', 'so-input')
        input.type = 'text'
        input.placeholder = ctx.t('stream-open.urlPlaceholder')
        input.setAttribute('aria-label', ctx.t('stream-open.panelTitle'))
        // No `type="url"`, deliberately: the browser's own validation rejects
        // `udp://@239.1.1.1:5000` and `smb://host/share`, both of which R02
        // allows, and it would do so before this module's policy ever ran.
        input.autocomplete = 'off'
        input.spellcheck = false
        const go = el('button', 'so-go', ctx.t('stream-open.openButton'))
        go.type = 'submit'
        form.append(input, go)
        form.addEventListener('submit', (e) => {
          e.preventDefault()
          const url = input.value.trim()
          if (url.length === 0) return
          // The refusal path is the main half's: it owns the R02 policy and the
          // message. Clearing the box only on success would need this half to
          // duplicate the policy to know, so it clears either way and the toast
          // says what happened.
          ctx.ipc.send('stream-open:submit', { url })
          input.value = ''
        })

        const badge = el('div', 'so-badge-tls')
        badge.hidden = true
        const note = el('div', 'so-note')
        note.hidden = true

        const bufRow = el('div', 'so-buffer')
        const bufBar = el('div', 'so-buffer-bar')
        const bufFill = el('div', 'so-buffer-fill')
        bufBar.appendChild(bufFill)
        const bufText = el('span')
        bufRow.append(bufBar, bufText)
        bufRow.hidden = true

        const list = el('ul', 'so-recent')

        root.append(head, form, badge, note, bufRow, list)
        host.appendChild(root)

        const renderState = (s: StreamPanelState): void => {
          badge.hidden = !s.tlsOverridden
          badge.textContent = ctx.t('stream-open.badgeTls')
          note.hidden = !s.hlsReloadHint
          note.textContent = ctx.t('stream-open.hlsReload')

          list.replaceChildren()
          if (s.recent.length === 0) {
            list.appendChild(el('li', 'so-empty', ctx.t('stream-open.recentEmpty')))
            return
          }
          for (const r of s.recent) {
            const li = el('li', 'so-item')
            if (r.url === s.currentUrl) li.classList.add('so-current')
            const open = el('button', 'so-item-open', r.title)
            open.type = 'button'
            open.title = r.url
            open.addEventListener('click', () => ctx.ipc.send('stream-open:submit', { url: r.url }))
            const forget = el('button', 'so-item-forget', '✕')
            forget.type = 'button'
            forget.title = ctx.t('stream-open.forget')
            forget.setAttribute('aria-label', ctx.t('stream-open.forget'))
            forget.addEventListener('click', () => ctx.ipc.send('stream-open:forget', { url: r.url }))
            li.append(open, forget)
            list.appendChild(li)
          }
        }

        const renderBuffer = (b: BufferState): void => {
          // R16's gate, on the renderer side too: a local file gets no widget at
          // all rather than a widget reading 0%.
          if (!b.network) {
            bufRow.hidden = true
            return
          }
          bufRow.hidden = false
          bufFill.style.width = `${b.percent ?? 0}%`
          const parts: string[] = []
          if (b.stalled) parts.push(ctx.t('stream-open.buffering'))
          if (b.percent !== null) parts.push(`${Math.round(b.percent)}%`)
          if (b.seconds !== null) parts.push(`${b.seconds.toFixed(1)}s`)
          if (b.live) parts.push(ctx.t('stream-open.statsLive'))
          bufText.textContent = parts.join(' · ')
        }

        renderState(state)
        renderBuffer(buffer)
        stateListeners.add(renderState)
        bufferListeners.add(renderBuffer)

        // The panel can be mounted after the main half has already pushed, so
        // ask once rather than waiting for the next change.
        void ctx.ipc
          .invoke<undefined, StreamPanelState>('stream-open:getState')
          .then((s) => {
            if (s) {
              state = s
              renderState(s)
            }
          })
          .catch(() => undefined)
        void ctx.ipc
          .invoke<undefined, BufferState>('stream-open:getBuffer')
          .then((b) => {
            if (b) {
              buffer = b
              renderBuffer(b)
            }
          })
          .catch(() => undefined)

        return () => {
          stateListeners.delete(renderState)
          bufferListeners.delete(renderBuffer)
          root.remove()
        }
      }
    })

    // -----------------------------------------------------------------------
    // R24: the cached window on the seek bar
    // -----------------------------------------------------------------------
    const rangesEl = el('div', 'so-ranges')

    ctx.seekbarLayer({
      id: 'stream-open.cache',
      /**
       * 2, below every existing layer (nav-thumbnails 5, nav-chapters 10,
       * nav-bookmarks 20 and 30). This layer paints a background region and
       * declares no `hitTest`, so it belongs at the bottom of the paint stack
       * and last in hit order — it must never sit in front of a chapter tick.
       * The host rejects a duplicate ORDER as well as a duplicate id now, so the
       * number is a claim rather than a preference.
       */
      order: 2,

      render(c): void {
        if (rangesEl.parentElement !== c.el) c.el.appendChild(rangesEl)
        if (!buffer.network || buffer.ranges.length === 0) {
          rangesEl.replaceChildren()
          return
        }

        /**
         * THE WHOLE POINT OF R24. For a live stream `duration` is 0 or unknown,
         * so `timeToX` cannot place anything: the bar has no timeline. What the
         * user can actually scrub is the CACHED WINDOW, so for a live source the
         * geometry is computed against that window's own span, and for a normal
         * VOD stream against the duration, where the ranges are a buffered-region
         * indicator over a real timeline.
         *
         * `SeekbarLayerCtx.duration` is documented as "0 or unknown for live
         * streams — guard", and this is the guard.
         */
        const live = buffer.live || !(c.duration > 0)
        const first = buffer.ranges[0] as CacheRange
        const last = buffer.ranges[buffer.ranges.length - 1] as CacheRange
        const from = live ? first.start : 0
        const span = live ? Math.max(last.end - first.start, 1e-6) : c.duration
        const toPct = (t: number): number =>
          Math.max(0, Math.min(100, ((t - from) / span) * 100))

        const kids: HTMLElement[] = []
        for (const r of buffer.ranges) {
          const bar = el('div', live ? 'so-range so-range-live' : 'so-range')
          const l = toPct(r.start)
          bar.style.left = `${l}%`
          bar.style.width = `${Math.max(toPct(r.end) - l, 0.4)}%`
          kids.push(bar)
        }
        rangesEl.replaceChildren(...kids)
      }
    })

    // -----------------------------------------------------------------------
    // R16 / R18: the stats rows
    // -----------------------------------------------------------------------
    ctx.statsSection({
      id: 'stream-open.stats',
      order: 30,
      titleKey: 'stream-open.stats',
      // The buffering numbers move several times a second on a healthy stream;
      // the main half already coalesces its push, so a poll here is the cheaper
      // of the two and never busier than the overlay repaints.
      refresh: { mode: 'poll', intervalMs: 500 },
      fields: () => {
        const b = buffer
        if (!b.network) return []
        const rows: Array<{ labelKey: string; value: string }> = [
          {
            labelKey: 'stream-open.statsPercent',
            value: b.percent === null ? '—' : `${Math.round(b.percent)}%`
          },
          {
            labelKey: 'stream-open.statsSeconds',
            value: b.seconds === null ? '—' : `${b.seconds.toFixed(1)} s`
          },
          { labelKey: 'stream-open.statsForward', value: bytes(b.forwardBytes) },
          // R16: "raw-input-rate is documented 'may be inaccurate or missing' —
          // render it as a soft hint", which is what the label says.
          {
            labelKey: 'stream-open.statsRate',
            value: b.inputRate === null ? '—' : `${bytes(b.inputRate)}/s`
          },
          {
            labelKey: 'stream-open.statsSpeed',
            value: b.cacheSpeed === null ? '—' : `${bytes(b.cacheSpeed)}/s`
          },
          {
            labelKey: 'stream-open.statsRanges',
            value:
              b.ranges.length === 0
                ? '—'
                : `${b.ranges.length} · ${(b.ranges[b.ranges.length - 1] as CacheRange).end.toFixed(
                    0
                  )}s${b.bofCached ? ' ⟨' : ''}${b.eofCached ? ' ⟩' : ''}`
          }
        ]
        // R18 only exists when the disk cache is on, and a permanent "0 B" row
        // would read as a broken disk cache.
        if (b.fileCacheBytes !== null && b.fileCacheBytes > 0) {
          rows.push({ labelKey: 'stream-open.statsDisk', value: bytes(b.fileCacheBytes) })
        }
        if (b.live) rows.push({ labelKey: 'stream-open.statsLive', value: 'yes' })
        return rows
      }
    })
  }
}

export default mod
