import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M17 subs-tracks, renderer half.
 *
 * WAVE 0 SEED, and it exists for exactly one reason: the subtitle toggle used to
 * be `<button id="subBtn">` in `src/renderer/index.html`, with its click handler
 * and its `aria-pressed` rendering in `src/renderer/src/main.ts`. Both files are
 * `core-renderer`'s, and both are in the `mustNotTouch` list of 40 of the 55
 * rows in `docs/parity/modules.json` — so one module's control lived in the two
 * files nobody else was allowed to edit, and the four modules that want the next
 * button in that row (M22 capture, M26 bookmarks, M27 thumbnails, M35 open URL)
 * had a committed precedent to follow into it.
 *
 * That is the third time this exact shape has been fixed: `#playlist` became
 * `ctx.panel()`, `.seek-chapter-tick` became a seek-bar layer with its own
 * container, and now the button row becomes `ctx.transportButton()`.
 *
 * The pressed state is read from `PlayerState.sid`, which is what the overlay
 * did, so the behaviour is unchanged: the button lights when a subtitle track is
 * selected. (`sub-visibility` is what the command actually toggles; it is not in
 * the core `PlayerState` and adding it there is M17's call to make when it
 * builds the rest of this module, not a change to smuggle into a move.)
 */

const mod: RendererFeatureModule = {
  id: 'subs-tracks',

  setup(ctx): void {
    // The settings window runs the same glob and has no transport bar.
    if (ctx.surface !== 'player') return

    ctx.transportButton({
      id: 'subs-tracks.toggle',
      order: 10,
      labelKey: 'subs-tracks.toggleVisibility',
      mount(el, api): () => void {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('aria-hidden', 'true')
        const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        box.setAttribute('x', '1.5')
        box.setAttribute('y', '3.5')
        box.setAttribute('width', '13')
        box.setAttribute('height', '9')
        box.setAttribute('rx', '1.5')
        const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        lines.setAttribute('d', 'M4 9.5h3M9 9.5h3')
        svg.append(box, lines)
        el.appendChild(svg)
        return ctx.state.subscribe((s) => api.pressed(s.sid !== false))
      },
      onClick(): void {
        ctx.ipc.send('subs-tracks:toggleVisibility')
      }
    })
  }
}

export default mod
