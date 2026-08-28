import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'

/**
 * M15 audio-devices, renderer half.
 *
 * WAVE 0 SEED, and the PROOF that `ctx.settingsComponent()` is a real
 * contribution point. The output-device control is the one setting on the page
 * that a descriptor genuinely cannot describe: the list comes from mpv's
 * `audio-device-list` at open time and changes when a headset is plugged in, so
 * there is no static `enum` to declare. The descriptor says
 * `{ kind: 'custom', rendererComponent: 'audio-devices.picker' }` and this file
 * supplies the picker.
 *
 * That is the whole reason the escape hatch exists. Everything else on the page
 * is generated.
 */

interface AudioDevice {
  name: string
  description: string
}

const mod: RendererFeatureModule = {
  id: 'audio-devices',

  setup(ctx): void {
    // The picker only exists in the settings window; registering it in the
    // overlay would be harmless but pointless.
    if (ctx.surface !== 'settings') return

    ctx.settingsComponent('audio-devices.picker', (host, binding) => {
      const select = document.createElement('select')
      select.setAttribute('aria-label', ctx.t('audio-devices.device'))
      host.appendChild(select)

      const fill = (devices: AudioDevice[]): void => {
        select.textContent = ''
        const list = devices.length > 0 ? devices : [{ name: 'auto', description: ctx.t('audio-devices.auto') }]
        for (const d of list) {
          const o = document.createElement('option')
          o.value = d.name
          // textContent: a device description comes from the driver.
          o.textContent = d.description || d.name
          select.appendChild(o)
        }
        select.value = binding.get<string>() || 'auto'
      }

      fill([])
      void ctx.ipc
        .invoke<undefined, AudioDevice[]>('audio-devices:list')
        .then(fill)
        .catch(() => {
          /* the fallback 'auto' entry is already in place */
        })

      select.addEventListener('change', () => binding.set(select.value))
      const off = binding.onChange(() => {
        select.value = binding.get<string>() || 'auto'
      })
      return () => {
        off()
        select.remove()
      }
    })
  }
}

export default mod
