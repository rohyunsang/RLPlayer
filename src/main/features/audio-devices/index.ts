import type { AudioDevice } from '@shared/types'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'
import { describeIdentity, identityOf, planReselection } from '@shared/mpv/tracks'
import type { TrackLike } from '@shared/mpv/tracks'

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
  dependsOn: ['core-af-chain', 'audio-tracks'],
  // §3.6: M15 "owns every AO-reinit round-trip; nothing else may re-set
  // `audio-device`". `ao-reload` is that round-trip in one command.
  ownsCommands: ['ao-reload'],
  ownsProperties: [
    'audio-device',
    'audio-exclusive',
    'audio-spdif',
    'audio-samplerate',
    'audio-format',
    'audio-buffer',
    'wasapi-exclusive-buffer',
    'audio-stream-silence',
    'audio-wait-open',
    'audio-fallback-to-null'
  ],
  requestsProperties: ['aid'],

  setup(c): void {
    ctx = c

    // A15/A16, and the settings window's output-device control. The list is
    // queried from mpv at open time and changes when the user plugs in a
    // headset, so no static `enum` can describe it — this is exactly what
    // `{ kind: 'custom' }` plus `ctx.settingsComponent()` is for. Before this
    // it was `<select id="audioDevice">` in the shared settings.html, which is
    // the M38 <-> M15 collision.
    ctx.settings.define([
      {
        id: 'audio-devices.device',
        section: 'audio',
        labelKey: 'audio-devices.device',
        descriptionKey: 'audio-devices.deviceDesc',
        type: { kind: 'custom', rendererComponent: 'audio-devices.picker' },
        default: 'auto',
        mpvOption: 'audio-device',
        keywords: ['출력', '장치', 'device', 'output'],
        order: 10
      }
    ])
    const legacyDevice = loadConfig().audioDevice
    if (legacyDevice) ctx.settings.set('audio-devices.device', legacyDevice)
    ctx.settings.onChange<string>('audio-devices.device', (v) => {
      void ctx.commands.invoke('audio-devices.select', v)
    })

    ctx.mpv.contributeArgs(10, () => {
      const device = ctx.settings.get<string>('audio-devices.device')
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
          // Read the selected track BEFORE the switch: reopening the audio
          // output can drop it, and mpv then re-picks by its own rules.
          const before = ctx.mpv.peek<TrackLike[]>('track-list') ?? []
          const previous = ctx.mpv.peek<number | false>('aid') ?? false
          const previousTrack = before.find((t) => t.type === 'audio' && t.id === previous)
          const identity = previousTrack ? identityOf(before, previousTrack) : null
          await ctx.mpv.set('audio-device', value)
          saveConfig({ audioDevice: value })

          /**
           * THE MEDIATED PATH, USED FOR REAL.
           *
           * `aid` is M11's (§3.6: "owns `aid` and `vid` outright"), and this
           * module must not round-trip it itself — that is the whole reason
           * `audio-tracks.reinitDecoder` exists. Until now `requestSet` had
           * ZERO call sites anywhere in `src/`, so the mediated half of §3.7
           * was a design nobody had ever executed. This is it, at the one
           * moment M15 genuinely needs it.
           *
           * A refusal is a NORMAL outcome, not an error: M11 refuses while its
           * own per-file restore is in flight, because granting it there picks
           * the wrong dub on a dual-audio release. Log it and move on.
           */
          /**
           * RE-RESOLVED BY IDENTITY, not by the captured index.
           *
           * Reopening the audio output can make mpv re-read external audio
           * files, and every command that re-reads a track list renumbers it —
           * the same shape that lost the Korean subtitle through `sid`. Asking
           * M11 to restore the OLD NUMBER after a renumber selects a different
           * dub, or nothing at all, and mpv reports `"error":"success"` either
           * way. So the request carries the id the track has NOW.
           */
          if (previous !== false && identity) {
            const after = ctx.mpv.peek<TrackLike[]>('track-list') ?? before
            const plan = planReselection(
              after,
              identity,
              ctx.mpv.peek<number | false>('aid') ?? false
            )
            if (plan.kind === 'lost') {
              ctx.log.warn(
                `${describeIdentity(identity)} is gone after the device switch; not guessing ` +
                  `at a replacement.`
              )
            } else if (plan.kind === 'write') {
              const r = await ctx.mpv.requestSet(
                'aid',
                plan.id,
                'the audio output was reopened for a device change and may have dropped the track'
              )
              if (!r.ok) ctx.log.warn(`audio track not re-asserted after the switch: ${r.reason}`)
            }
          }
        }
      }
    ])

    ctx.i18n.register('ko', {
      'audio-devices.select': '오디오 장치 선택',
      'audio-devices.device': '출력 장치',
      'audio-devices.deviceDesc': '목록은 창을 열 때 mpv에서 가져옵니다.',
      'audio-devices.auto': '자동'
    })
    ctx.i18n.register('en', {
      'audio-devices.select': 'Select audio device',
      'audio-devices.device': 'Output device',
      'audio-devices.deviceDesc': 'The list is read from mpv when this window opens.',
      'audio-devices.auto': 'Automatic'
    })
  }
}

export default mod
