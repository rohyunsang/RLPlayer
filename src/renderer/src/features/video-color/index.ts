import './video-color.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M01 video-color, renderer half. Two contributions, one per surface.
 *
 * SETTINGS SURFACE. There is deliberately no panel and no custom component:
 * all thirteen of this module's controls are ordinary bounded
 * `int`/`float`/`bool`/`enum` descriptors, and §7 is explicit that reaching for
 * an escape hatch to render an ordinary value is the thing not to do — the
 * generated form already gives each of them a slider with a readout.
 *
 * What a descriptor CANNOT express is the two sentences a user needs in order
 * to choose between the two halves of this module: the five colour knobs are
 * VO-level and free, and the three filters below them are lavfi and force an
 * hwdec copy-back. That is prose, plus one action — V53's "reset video
 * settings so a bad saved state is recoverable", which has to be reachable
 * without knowing which of thirteen rows to put back. Prose and an action are
 * exactly what `ctx.settingsSection()` is for (M31's Electron #40515 note is
 * the other user).
 *
 * PLAYER SURFACE. §4.2 lists M01 among the producers of an M29 stats section,
 * additive and non-blocking. It earns its place on this module's own §6.3
 * acceptance criterion — "brightness ±100 visibly changes the picture WITH
 * hwdec active, proving it is a VO-level property, not a filter" — which is a
 * claim you can only check in the app if something tells you the knobs moved
 * and no CPU filter of this module's went into the chain.
 */

/**
 * The stats payload. Declared here and again in the main half, which is the
 * duplication §3.4 says `src/shared/features/<id>/` exists to stop — except
 * that M01's `ownedFiles` does not list that directory, so this module may not
 * create it. Reported as a finding; kept to two string fields so the copy is
 * small and `value` arrives already formatted.
 */
interface StatsRow {
  labelKey: string
  value: string
}

const mod: RendererFeatureModule = {
  id: 'video-color',

  setup(ctx): void {
    // The overlay and the settings window run the SAME glob, so this runs once
    // per surface. Each host ignores what does not belong to it, but the pull
    // below is real work, so branch rather than register both blindly.
    if (ctx.surface === 'player') {
      // Declared BEFORE the section that closes over it: `fields()` can be
      // called during registration, and a `let` read from above its own
      // declaration is the TDZ throw that killed nav-chapters' setup().
      let rows: readonly StatsRow[] = []

      const pull = (): void => {
        void ctx.ipc
          .invoke<undefined, { rows: StatsRow[] }>('video-color:stats')
          .then((r) => {
            rows = r?.rows ?? []
          })
          .catch(() => {
            rows = []
          })
      }
      pull()

      ctx.statsSection({
        id: 'video-color.stats',
        // Video family, after M07's decode block at 20 and well clear of core's
        // own refusal block at 90. Stats orders are slot-unique now, so a tie
        // is a contribution error rather than a silent load-order decision.
        order: 25,
        titleKey: 'video-color.stats',
        // The overlay only receives the derived PlayerState, so the host treats
        // any state push as "something changed" and repaints. `fields()` is
        // SYNCHRONOUS, so this renders the last answer and asks for the next —
        // the shape core's own `core.refusals` section uses, one frame stale by
        // construction and invisible at that.
        refresh: { mode: 'onChange', watch: ['brightness', 'contrast', 'saturation', 'hue', 'gamma'] },
        fields: () => {
          pull()
          return rows.map((r) => ({ labelKey: r.labelKey, value: r.value }))
        }
      })
      return
    }

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
        // `btn` is core's component class (defined in core/settings.css), used
        // here from inside this module's own subtree — the same thing M31's
        // relaunch button does, and legitimate because the partition check asks
        // who owns a selector by its LEFTMOST compound. Everything this module
        // DEFINES is prefixed `vc-` and lives in its own stylesheet.
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
