import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'

/**
 * M07 video-decode — hardware decoding and the video output.
 *
 * WAVE 0 SEED: `hwdec` only, which is what the v0.1 settings window changes.
 *
 * `--vo` and `--gpu-context` are core-reserved SPAWN args (Appendix A) because
 * the two-window `--wid` embedding depends on them, but the `vo` PROPERTY is
 * M07's (§3.7). Changing the VO is restart-scoped: write the setting, then ask
 * for a respawn — mpv cannot swap its video output in place.
 */

let ctx: FeatureContext

const mod: FeatureModule = {
  id: 'video-decode',
  ownsProperties: [
    'hwdec',
    'hwdec-codecs',
    'hwdec-software-fallback',
    'hwdec-extra-frames',
    'vo',
    'gpu-api',
    'gpu-context',
    'd3d11-adapter',
    'd3d11-warp',
    'd3d11-feature-level',
    'd3d11-output-mode',
    'd3d11-sync-interval',
    'd3d11-flip',
    'd3d11-output-format',
    'd3d11-output-csp',
    'background',
    'background-color',
    'corner-rounding'
  ],

  setup(c): void {
    ctx = c

    ctx.mpv.contributeArgs(10, () => [
      `--hwdec=${loadConfig().hwdec || 'auto-safe'}`,
      // V52: mpv's default letterbox fill is a checkerboard, which looks like a
      // rendering fault on a 2.35:1 film in a 16:9 window.
      '--background=color',
      '--background-color=#FF000000'
    ])

    ctx.commands.register([
      {
        id: 'video-decode.setHwdec',
        labelKey: 'video-decode.setHwdec',
        category: 'video',
        internal: true,
        run: async (arg) => {
          const value = String(arg ?? 'auto-safe')
          await ctx.mpv.set('hwdec', value)
          saveConfig({ hwdec: value })
        }
      },
      {
        id: 'video-decode.setVo',
        labelKey: 'video-decode.setVo',
        category: 'video',
        internal: true,
        run: (arg) => {
          const value = String(arg ?? 'gpu-next')
          if (value === loadConfig().vo) return
          saveConfig({ vo: value })
          // Restart-scoped: mpv cannot swap its video output in place.
          ctx.mpv.requestRestart('video output changed')
        }
      }
    ])

    ctx.i18n.register('ko', {
      'video-decode.setHwdec': '하드웨어 가속',
      'video-decode.setVo': '비디오 출력'
    })
    ctx.i18n.register('en', {
      'video-decode.setHwdec': 'Hardware decoding',
      'video-decode.setVo': 'Video output'
    })
  }
}

export default mod
