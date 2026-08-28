import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M31 shell-window, renderer half.
 *
 * WAVE 0 SEED, and the PROOF that `ctx.settingsSection()` is a real
 * contribution point. The layout SELECT is a descriptor — a fixed set of two
 * values is exactly what `{ kind: 'enum' }` is for — but the paragraph
 * explaining Electron #40515 and the "restart RLPlayer" button next to it are
 * prose and an action, and no descriptor can express either. Before this they
 * were hardcoded in `src/renderer/settings.html`, a file M31 may not touch.
 */

const mod: RendererFeatureModule = {
  id: 'shell-window',

  setup(ctx): void {
    if (ctx.surface !== 'settings') return

    ctx.settingsSection({
      id: 'shell-window.layoutHelp',
      section: 'video',
      order: 6,
      titleKey: 'shell-window.layoutHelp',
      mount(host): () => void {
        const hint = document.createElement('p')
        hint.className = 'hint'
        hint.textContent = ctx.t('shell-window.layoutHint')

        const relaunch = document.createElement('button')
        relaunch.type = 'button'
        relaunch.className = 'btn'
        relaunch.textContent = ctx.t('shell-window.relaunch')
        // Window topology is fixed when the windows are created, so the layout
        // change genuinely needs a fresh process — not an mpv respawn.
        relaunch.addEventListener('click', () => window.rlplayer.system.relaunch())

        host.append(hint, relaunch)
        return () => {
          hint.remove()
          relaunch.remove()
        }
      }
    })
  }
}

export default mod
