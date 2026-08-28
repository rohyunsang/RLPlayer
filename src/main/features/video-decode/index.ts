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
    'background-tile-color-0',
    'background-tile-color-1',
    'background-tile-size',
    'background-blur-radius',
    'corner-rounding'
  ],

  setup(c): void {
    ctx = c

    // V49/V54, and the settings window's two video controls. These used to be
    // `<select id="hwdec">` and `<select id="vo">` hardcoded in
    // `src/renderer/settings.html` — a file M07 is forbidden to touch and M38
    // owns, which is the M38 ↔ M07 collision the audit measured. The form is
    // generated from descriptors now, so both controls are declared here, in
    // the module that owns the properties behind them.
    ctx.settings.define([
      {
        id: 'video-decode.hwdec',
        section: 'video',
        labelKey: 'video-decode.hwdec',
        descriptionKey: 'video-decode.hwdecDesc',
        type: {
          kind: 'enum',
          options: [
            { value: 'auto-safe', labelKey: 'video-decode.hwdec.autoSafe' },
            { value: 'auto', labelKey: 'video-decode.hwdec.auto' },
            { value: 'd3d11va', labelKey: 'video-decode.hwdec.d3d11va' },
            { value: 'no', labelKey: 'video-decode.hwdec.no' }
          ]
        },
        default: 'auto-safe',
        mpvOption: 'hwdec',
        keywords: ['하드웨어', '가속', 'hwdec', 'gpu'],
        order: 10
      },
      {
        id: 'video-decode.vo',
        section: 'video',
        labelKey: 'video-decode.vo',
        descriptionKey: 'video-decode.voDesc',
        type: {
          kind: 'enum',
          options: [
            { value: 'gpu-next', labelKey: 'video-decode.vo.gpuNext' },
            { value: 'gpu', labelKey: 'video-decode.vo.gpu' }
          ]
        },
        default: 'gpu-next',
        mpvOption: 'vo',
        requiresRestart: true,
        keywords: ['비디오 출력', 'vo', 'hdr'],
        order: 20
      }
    ])

    // v0.1 stored both on AppConfig, and core still reads `vo` there when it
    // composes the spawn argv. M07 is the single writer of both sides, so the
    // mirror has exactly one owner; seed once from the legacy value so an
    // upgrading user keeps their choice.
    const cfg0 = loadConfig()
    if (cfg0.hwdec) ctx.settings.set('video-decode.hwdec', cfg0.hwdec)
    if (cfg0.vo) ctx.settings.set('video-decode.vo', cfg0.vo)
    ctx.settings.onChange<string>('video-decode.hwdec', (v) => {
      void ctx.commands.invoke('video-decode.setHwdec', v)
    })
    ctx.settings.onChange<string>('video-decode.vo', (v) => {
      void ctx.commands.invoke('video-decode.setVo', v)
    })

    ctx.mpv.contributeArgs(10, () => [
      `--hwdec=${ctx.settings.get<string>('video-decode.hwdec') || 'auto-safe'}`,
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

    // The stats overlay's decoder row, contributed through ctx.statsSection()
    // from this module's renderer half. Nothing in main.ts knows it exists.
    ctx.i18n.register('ko', {
      'video-decode.setHwdec': '하드웨어 가속',
      'video-decode.setVo': '비디오 출력',
      'video-decode.hwdec': '하드웨어 가속',
      'video-decode.hwdecDesc': '디코딩을 GPU에 맡깁니다. 문제가 있으면 "사용 안 함"으로 두세요.',
      'video-decode.hwdec.autoSafe': '자동 (권장)',
      'video-decode.hwdec.auto': '자동 (모두 허용)',
      'video-decode.hwdec.d3d11va': 'D3D11VA',
      'video-decode.hwdec.no': '사용 안 함',
      'video-decode.vo': '비디오 출력',
      'video-decode.voDesc': 'gpu-next는 HDR을 지원합니다. 화면이 이상하면 gpu로 내려보세요.',
      'video-decode.vo.gpuNext': 'gpu-next (권장, HDR 지원)',
      'video-decode.vo.gpu': 'gpu (구형 하드웨어 대체용)',
      'video-decode.stats': '디코더',
      'video-decode.statsHwdec': '하드웨어 가속',
      'video-decode.statsCurrent': '사용 중',
      'video-decode.statsVo': '비디오 출력',
      'video-decode.statsCodec': '코덱',
      'video-decode.statsSize': '해상도'
    })
    ctx.i18n.register('en', {
      'video-decode.setHwdec': 'Hardware decoding',
      'video-decode.setVo': 'Video output',
      'video-decode.hwdec': 'Hardware decoding',
      'video-decode.hwdecDesc': 'Let the GPU decode. Set to "off" if you see artefacts.',
      'video-decode.hwdec.autoSafe': 'Automatic (recommended)',
      'video-decode.hwdec.auto': 'Automatic (allow everything)',
      'video-decode.hwdec.d3d11va': 'D3D11VA',
      'video-decode.hwdec.no': 'Off',
      'video-decode.vo': 'Video output',
      'video-decode.voDesc': 'gpu-next supports HDR. Drop to gpu on older hardware.',
      'video-decode.vo.gpuNext': 'gpu-next (recommended, HDR)',
      'video-decode.vo.gpu': 'gpu (fallback for old hardware)',
      'video-decode.stats': 'Decoder',
      'video-decode.statsHwdec': 'Hardware decoding',
      'video-decode.statsCurrent': 'In use',
      'video-decode.statsVo': 'Video output',
      'video-decode.statsCodec': 'Codec',
      'video-decode.statsSize': 'Resolution'
    })

    // The stats overlay needs these on the wire; `peek` only sees what someone
    // observed. Reads are unrestricted, so observing costs nothing but the one
    // refcounted observe_property the bus already dedupes.
    for (const p of ['hwdec-current', 'video-codec', 'width', 'height', 'current-vo']) {
      ctx.mpv.observe(p, () => {})
    }
    ctx.ipc.handle('video-decode:stats', () => ({
      hwdec: ctx.settings.get<string>('video-decode.hwdec'),
      hwdecCurrent: String(ctx.mpv.peek('hwdec-current') ?? '-'),
      vo: String(ctx.mpv.peek('current-vo') ?? ctx.settings.get<string>('video-decode.vo')),
      codec: String(ctx.mpv.peek('video-codec') ?? '-'),
      width: Number(ctx.mpv.peek('width') ?? 0),
      height: Number(ctx.mpv.peek('height') ?? 0)
    }))
  }
}

export default mod
