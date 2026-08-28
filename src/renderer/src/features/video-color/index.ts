import './video-color.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M01 video-color, renderer half.
 *
 * There is deliberately no panel and no custom component here. All thirteen of
 * this module's controls are ordinary bounded `int`/`float`/`bool`/`enum`
 * descriptors, and §7 is explicit that reaching for an escape hatch to render
 * an ordinary value is the thing not to do — the generated form already gives
 * each of them a slider with a readout.
 *
 * What a descriptor CANNOT express is the two sentences a user needs in order
 * to choose between the two halves of this module: the five colour knobs are
 * VO-level and free, and the three filters below them are lavfi and force an
 * hwdec copy-back. That is prose, plus one action — V53's "reset video
 * settings so a bad saved state is recoverable", which has to be reachable
 * without knowing which of thirteen rows to put back. Prose and an action are
 * exactly what `ctx.settingsSection()` is for (M31's Electron #40515 note is
 * the other user).
 */

const mod: RendererFeatureModule = {
  id: 'video-color',

  setup(ctx): void {
    // The overlay and the settings window run the same glob; nothing here
    // belongs to the player surface.
    if (ctx.surface !== 'settings') return

    ctx.settingsSection({
      id: 'video-color.help',
      section: 'video',
      order: 8,
      titleKey: 'video-color.help',
      mount(host): () => void {
        const wrap = document.createElement('div')
        wrap.className = 'vc-help'

        for (const key of ['video-color.helpProps', 'video-color.helpFilters']) {
          const p = document.createElement('p')
          p.className = 'vc-help-line'
          p.textContent = ctx.t(key)
          wrap.appendChild(p)
        }

        const reset = document.createElement('button')
        reset.type = 'button'
        // `btn` is core's component class, used here from inside this module's
        // own subtree — the same thing M31's relaunch button does. Everything
        // this module DEFINES is prefixed `vc-` and lives in its own stylesheet,
        // because a feature selector in core's `styles.css` is what
        // `check:partition` fails the build for.
        reset.className = 'btn vc-reset'
        reset.textContent = ctx.t('video-color.helpReset')
        // The renderer half never writes an mpv property (§3.4): it sends to
        // its own main half, which owns all six.
        reset.addEventListener('click', () => ctx.ipc.send('video-color:reset'))

        wrap.appendChild(reset)
        host.appendChild(wrap)
        return () => {
          wrap.remove()
        }
      }
    })
  }
}

export default mod
