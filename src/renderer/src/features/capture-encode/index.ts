import './capture-encode.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M23 capture-encode, renderer half.
 *
 * WHY THIS EXISTS AT ALL, given that C18 says "encode job progress, queue and
 * cancel" and §11 hands a module `ctx.osd.progress({ cancellable: true })` for
 * exactly that: **that handle is inert in both directions, and it still is.**
 * Re-measured this round, on the tree this module ships into:
 *
 *   - `OsdBus.progress()` sends `ui:progress` and `src/preload/index.ts:77`
 *     exposes it as `onProgress` — and `grep -rn onProgress src/renderer`
 *     returns NOTHING. Nothing subscribes, so a progress handle renders nothing.
 *   - `ProgressHandle.cancelled` reads a set whose only writer is
 *     `ipcMain.on('ui:progressCancel')` (`src/main/ipc.ts:158`), and the preload
 *     exposes no sender for that channel, so `cancelled` can never become true.
 *
 * Connecting that wire means editing `src/renderer/src/main.ts` and
 * `src/preload/index.ts` — two files in this module's `mustNotTouch` and in 40
 * of the 55 rows'. So the progress a user can actually see is built here, out of
 * contribution points that DO render: a panel, a transport button, and this
 * module's own IPC channels. The main half still drives the core handle as well,
 * so the day the wire is connected there is nothing to change.
 *
 * DECLARE FIRST, SUBSCRIBE LAST. `ctx.state.subscribe()` replays the last state
 * synchronously, so anything a subscriber closes over must exist already — the
 * TDZ crash that killed the rest of nav-chapters' `setup()`. This file
 * subscribes to no player state at module scope at all; everything it draws
 * arrives on its own channels, established inside `mount`.
 */

/**
 * Mirrors the main half's push payload.
 *
 * IT IS DUPLICATED, AND THAT IS A REPORTED DEFECT, NOT A CHOICE. §10 says a
 * module's two halves share `src/shared/features/<id>/`, "listed in your row's
 * ownedFiles" — but only 3 of the 40 feature rows in docs/parity/modules.json
 * list one, and M23's is not among them. Creating
 * `src/shared/features/capture-encode/wire.ts` produces a file owned by nobody,
 * which `check:partition` fails; adding it to the row is a manifest edit this
 * module may not make. M22 wrote the same paragraph one directory over.
 */
type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface JobWire {
  id: string
  kind: string
  label: string
  name: string
  state: JobState
  percent: number | null
  error: string | null
}

interface JobsWire {
  jobs: JobWire[]
}

/** What the quick-start row offers, as command ids the main half also exposes. */
const QUICK_ACTIONS: ReadonlyArray<{ command: string; labelKey: string }> = [
  { command: 'capture-encode.exportClip', labelKey: 'capture-encode.exportClip' },
  { command: 'capture-encode.extractAudio', labelKey: 'capture-encode.extractAudio' },
  { command: 'capture-encode.exportGif', labelKey: 'capture-encode.exportGif' },
  { command: 'capture-encode.exportWebp', labelKey: 'capture-encode.exportWebp' },
  { command: 'capture-encode.burstFrames', labelKey: 'capture-encode.burstFrames' },
  { command: 'capture-encode.contactSheet', labelKey: 'capture-encode.contactSheet' }
]

const LIMIT_KEYS: readonly string[] = [
  'capture-encode.limits.ffmpeg',
  'capture-encode.limits.subs',
  'capture-encode.limits.sheet',
  'capture-encode.limits.hw',
  'capture-encode.limits.cut',
  'capture-encode.limits.stream'
]

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function svg(d: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const root = document.createElementNS(ns, 'svg')
  root.setAttribute('viewBox', '0 0 16 16')
  root.setAttribute('width', '16')
  root.setAttribute('height', '16')
  root.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', d)
  p.setAttribute('fill', 'currentColor')
  root.appendChild(p)
  return root
}

/** A film frame with an arrow leaving it: "export". */
const ICON_EXPORT =
  'M2 3h9a1 1 0 0 1 1 1v3h-1.5V4.5H3.5v7H7V13H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm9.5 4.5L15 10l-3.5 2.5V11H8V9h3.5z'

const mod: RendererFeatureModule = {
  id: 'capture-encode',

  setup(ctx): void {
    if (ctx.surface === 'player') {
      // ---------------------------------------------------------------------
      // Shared, declared BEFORE anything that can call it.
      // ---------------------------------------------------------------------
      let panelHost: HTMLElement | null = null
      let setOpen: (on: boolean) => void = () => {}
      let pressed: (on: boolean) => void = () => {}
      let isOpen = false

      const applyOpen = (on: boolean): void => {
        isOpen = on
        if (panelHost) panelHost.hidden = !on
        pressed(on)
      }
      setOpen = applyOpen

      // ---------------------------------------------------------------------
      // The job panel — C18's progress, queue and cancel
      // ---------------------------------------------------------------------
      ctx.panel({
        id: 'capture-encode',
        side: 'right',
        titleKey: 'capture-encode.panelTitle',
        // 10 and 20 are the playlist and the bookmark manager.
        order: 70,
        mount(host): () => void {
          panelHost = host

          const head = el('div', 'enc-head')
          head.appendChild(el('h2', undefined, ctx.t('capture-encode.panelTitle')))
          const cancelAll = el('button', 'icon-btn small')
          cancelAll.type = 'button'
          cancelAll.title = ctx.t('capture-encode.cancelAll')
          cancelAll.setAttribute('aria-label', ctx.t('capture-encode.cancelAll'))
          cancelAll.appendChild(svg('M4 4l8 8M12 4l-8 8'))
          cancelAll.addEventListener('click', () => ctx.ipc.send('capture-encode:cancelAll'))
          head.appendChild(cancelAll)

          const list = el('ul', 'enc-jobs')
          const empty = el('p', 'enc-empty', ctx.t('capture-encode.jobsEmpty'))

          const quick = el('div', 'enc-quick')
          quick.appendChild(el('h3', undefined, ctx.t('capture-encode.quickActions')))
          for (const a of QUICK_ACTIONS) {
            const b = el('button', 'enc-quick-btn', ctx.t(a.labelKey))
            b.type = 'button'
            // The panel is a second way in, never a second implementation: this
            // asks the main half to invoke the very command the menu and the
            // keybind editor invoke.
            b.addEventListener('click', () =>
              ctx.ipc.send('capture-encode:start', { command: a.command })
            )
            quick.appendChild(b)
          }

          host.append(head, list, empty, quick)

          const paint = (s: JobsWire): void => {
            const jobs = Array.isArray(s?.jobs) ? s.jobs : []
            list.replaceChildren()
            for (const j of jobs) {
              const row = el('li', `enc-job enc-${j.state}`)
              const top = el('div', 'enc-job-top')
              top.appendChild(el('span', 'enc-job-label', j.label))
              top.appendChild(
                el('span', 'enc-job-state', ctx.t(`capture-encode.state.${j.state}`))
              )
              const cancel = el('button', 'icon-btn tiny')
              cancel.type = 'button'
              cancel.title = ctx.t('capture-encode.cancelJob')
              cancel.setAttribute('aria-label', ctx.t('capture-encode.cancelJob'))
              cancel.appendChild(svg('M4 4l8 8M12 4l-8 8'))
              cancel.disabled = j.state !== 'queued' && j.state !== 'running'
              cancel.addEventListener('click', () =>
                ctx.ipc.send('capture-encode:cancel', { id: j.id })
              )
              top.appendChild(cancel)
              row.appendChild(top)

              row.appendChild(el('div', 'enc-job-name', j.name))

              // A determinate bar when there is a number, an indeterminate
              // stripe when there is not — a queued job and a job whose first
              // `time-pos` has not arrived are different states and must look it.
              const bar = el('div', 'enc-bar')
              const fill = el('div', 'enc-bar-fill')
              if (j.percent === null) {
                bar.classList.add('enc-bar-idle')
              } else {
                fill.style.width = `${Math.min(100, Math.max(0, j.percent))}%`
                bar.setAttribute('role', 'progressbar')
                bar.setAttribute('aria-valuenow', String(j.percent))
                bar.setAttribute('aria-valuemin', '0')
                bar.setAttribute('aria-valuemax', '100')
              }
              bar.appendChild(fill)
              row.appendChild(bar)

              if (j.error) row.appendChild(el('p', 'enc-job-error', j.error))
              list.appendChild(row)
            }
            empty.hidden = jobs.length > 0
            // A job starting is the one moment the panel should show itself
            // without being asked; a user who closed it is not overruled again.
            if (jobs.some((j) => j.state === 'running' || j.state === 'queued') && !isOpen) {
              applyOpen(true)
            }
          }

          // Ask once, then follow the pushes: a panel mounted while a job is
          // already running must not show "nothing running".
          void ctx.ipc
            .invoke<undefined, JobsWire>('capture-encode:getJobs')
            .then(paint)
            .catch(() => undefined)

          const offJobs = ctx.ipc.on<JobsWire>('capture-encode:jobs', paint)
          const offPanel = ctx.ipc.on<{ open: boolean | 'toggle' }>(
            'capture-encode:panel',
            (p) => applyOpen(p?.open === 'toggle' ? !isOpen : p?.open === true)
          )

          return () => {
            offJobs()
            offPanel()
            panelHost = null
          }
        }
      })

      // ---------------------------------------------------------------------
      // The transport button
      // ---------------------------------------------------------------------
      ctx.transportButton({
        id: 'capture-encode.togglePanel',
        // 10, 20, 30 and 40 are subs-tracks, playlist, nav-bookmarks and
        // capture-still; core's own controls end at 100.
        order: 70,
        labelKey: 'capture-encode.transportButton',
        mount(button, api): () => void {
          button.appendChild(svg(ICON_EXPORT))
          const badge = el('span', 'enc-badge')
          badge.hidden = true
          button.appendChild(badge)
          pressed = (on) => api.pressed(on)
          api.pressed(isOpen)

          return ctx.ipc.on<JobsWire>('capture-encode:jobs', (s) => {
            const active = (s?.jobs ?? []).filter(
              (j) => j.state === 'running' || j.state === 'queued'
            ).length
            badge.hidden = active === 0
            badge.textContent = active > 0 ? String(active) : ''
            button.classList.toggle('enc-busy', active > 0)
          })
        },
        onClick(): void {
          setOpen(!isOpen)
        }
      })
    }

    if (ctx.surface === 'settings') {
      /**
       * The honest-limits block. Every line of it is a verified negative from
       * §2.4 — no ffmpeg, burn-in only, no per-tile timestamps, probe-then-fall
       * back, cache-only cuts, network-only stream recording — and each one is
       * something a user would otherwise discover by getting a result they did
       * not expect.
       */
      ctx.settingsSection({
        id: 'capture-encode.limits',
        section: 'general',
        // 10 is capture-still's filename-template legend.
        order: 12,
        titleKey: 'capture-encode.limitsTitle',
        mount(host): () => void {
          const ul = el('ul', 'enc-limits')
          for (const key of LIMIT_KEYS) ul.appendChild(el('li', undefined, ctx.t(key)))
          host.appendChild(ul)
          return () => ul.remove()
        }
      })
    }
  }
}

export default mod
