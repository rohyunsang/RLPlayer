import './capture-still.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M22 capture-still, renderer half.
 *
 * Two contributions, no shared file touched:
 *
 *   - a TRANSPORT BUTTON. `src/renderer/index.html` hard-coded `#playlistBtn`
 *     and `#subBtn` until `ctx.transportButton()` existed, and the API guide
 *     names M22 as one of the four modules that were one commit from following
 *     them into that file. This is the button, and it is in this directory.
 *   - a SETTINGS SECTION carrying the filename-template legend. The template
 *     specifiers (`%F`, `%wH`, `%#02n`) are not guessable and mpv's failure mode
 *     for a bad one is silence — it refuses to overwrite and simply writes
 *     nothing — so the legend is part of the feature, not decoration.
 *
 * The ownership rule holds on this side too: nothing here writes an mpv
 * property. Every gesture is an `ipc.send` to this module's main half, which
 * owns `screenshot-*` and the two screenshot commands.
 *
 * DECLARE FIRST, SUBSCRIBE LAST. `ctx.state.subscribe()` replays the last state
 * synchronously, so anything a subscriber closes over must already exist — the
 * TDZ crash that killed the rest of nav-chapters' setup(). This file subscribes
 * to nothing at module scope for exactly that reason; the button's state comes
 * from its own IPC channel, established inside `mount`.
 */

/**
 * Mirrors the main half's push payload.
 *
 * IT IS DUPLICATED, AND THAT IS A REPORTED DEFECT, NOT A CHOICE. §10 of the API
 * guide says a module's two halves share `src/shared/features/<id>/`, "listed in
 * your row's ownedFiles" — but only 3 of the 40 feature rows in
 * docs/parity/modules.json actually list it, and M22's is not one of them.
 * Creating `src/shared/features/capture-still/wire.ts` makes
 * `npm run check:partition` exit 1 with "is owned by NOBODY", and the fix is a
 * modules.json edit, which is not a file this module owns. So the type is
 * written twice, which is the exact defect the shared directory exists to
 * prevent.
 */
interface CaptureState {
  burst: boolean
  done: number
  total: number
}

const TEMPLATE_LEGEND: ReadonlyArray<[string, string]> = [
  ['%F', 'capture-still.legend.F'],
  ['%f', 'capture-still.legend.f'],
  ['%wH.%wM.%wS.%wT', 'capture-still.legend.pos'],
  ['%#02n', 'capture-still.legend.n'],
  ['%tY-%tm-%td', 'capture-still.legend.date'],
  ['%{media-title}', 'capture-still.legend.prop'],
  ['%%', 'capture-still.legend.percent']
]

function svgIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const body = document.createElementNS(ns, 'path')
  // A camera: body with a lens.
  body.setAttribute(
    'd',
    'M6 2h4l1 2h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3zM8 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z'
  )
  body.setAttribute('fill', 'currentColor')
  svg.appendChild(body)
  return svg
}

const mod: RendererFeatureModule = {
  id: 'capture-still',

  setup(ctx): void {
    if (ctx.surface === 'player') {
      ctx.transportButton({
        id: 'capture-still.capture',
        // 10, 20 and 30 are subs-tracks, playlist and nav-bookmarks; core's own
        // controls end at 100.
        order: 40,
        labelKey: 'capture-still.transportButton',
        mount(button, api): () => void {
          button.appendChild(svgIcon())
          const badge = document.createElement('span')
          badge.className = 'cap-burst-badge'
          badge.hidden = true
          button.appendChild(badge)
          api.pressed(false)

          const paint = (s: CaptureState): void => {
            api.pressed(s.burst)
            badge.hidden = !s.burst
            badge.textContent = s.burst ? `${s.done}/${s.total}` : ''
            button.classList.toggle('cap-bursting', s.burst)
          }

          // Ask once for the current state, then follow the pushes. A button
          // mounted while a burst is already running must not show "idle".
          void ctx.ipc
            .invoke<undefined, CaptureState>('capture-still:getState')
            .then(paint)
            .catch(() => undefined)
          return ctx.ipc.on<CaptureState>('capture-still:state', paint)
        },
        onClick(e): void {
          // One button, three gestures, and each one is a command the keybind
          // editor also lists — the button is a second way in, never a second
          // implementation.
          if (e.ctrl) ctx.ipc.send('capture-still:burst')
          else if (e.shift) ctx.ipc.send('capture-still:clipboard')
          else ctx.ipc.send('capture-still:save')
        }
      })
    }

    if (ctx.surface === 'settings') {
      ctx.settingsSection({
        id: 'capture-still.templateHelp',
        section: 'general',
        order: 10,
        titleKey: 'capture-still.templateHelp',
        mount(host): () => void {
          const table = document.createElement('dl')
          table.className = 'cap-legend'
          for (const [spec, key] of TEMPLATE_LEGEND) {
            const dt = document.createElement('dt')
            dt.textContent = spec
            const dd = document.createElement('dd')
            dd.textContent = ctx.t(key)
            table.append(dt, dd)
          }
          const note = document.createElement('p')
          note.className = 'cap-legend-note'
          note.textContent = ctx.t('capture-still.legend.note')
          host.append(table, note)
          return () => {
            table.remove()
            note.remove()
          }
        }
      })
    }
  }
}

export default mod
