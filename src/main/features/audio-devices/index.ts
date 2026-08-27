import type { AudioDevice } from '@shared/types'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'

/**
 * M15 audio-devices — output device selection.
 *
 * WAVE 0 SEED. It owns every AO-reinit round-trip; nothing else may re-set
 * `audio-device`. When A20 (bitstream passthrough) lands it must NOT round-trip
 * `aid` itself — that is `audio-tracks.reinitDecoder` (§3.7.3), because M11 is
 * the only module that knows which track should be selected afterwards.
 */

let ctx: FeatureContext

const mod: FeatureModule = {
  id: 'audio-devices',
  ownsProperties: [
    'audio-device',
    'audio-exclusive',
    'audio-spdif',
    'audio-samplerate',
    'audio-format',
    'audio-buffer',
    'audio-stream-silence',
    'audio-wait-open',
    'audio-fallback-to-null'
  ],
  requestsProperties: ['aid'],

  setup(c): void {
    ctx = c

    ctx.mpv.contributeArgs(10, () => {
      const device = loadConfig().audioDevice
      return device && device !== 'auto' ? [`--audio-device=${device}`] : []
    })

    ctx.ipc.handle<void, AudioDevice[]>('audio-devices:list', async () => {
      try {
        const list =
          await ctx.mpv.get<{ name: string; description: string }[]>('audio-device-list')
        return Array.isArray(list)
          ? list.map((d) => ({ name: d.name, description: d.description || d.name }))
          : []
      } catch {
        return []
      }
    })

    ctx.commands.register([
      {
        id: 'audio-devices.select',
        labelKey: 'audio-devices.select',
        category: 'audio',
        internal: true,
        run: async (arg) => {
          const value = String(arg ?? 'auto')
          await ctx.mpv.set('audio-device', value)
          saveConfig({ audioDevice: value })
        }
      }
    ])

    ctx.i18n.register('ko', { 'audio-devices.select': '오디오 장치 선택' })
    ctx.i18n.register('en', { 'audio-devices.select': 'Select audio device' })
  }
}

export default mod
