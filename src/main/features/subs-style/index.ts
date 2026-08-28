import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'

/**
 * M19 subs-style — subtitle appearance.
 *
 * WAVE 0 SEED: only what v0.1 shipped (scale, position, ASS override). The
 * Wave-1 implementer owns the other fifty-odd `sub-*` styling properties listed
 * in §3.7, including MF-3 embedded fonts and MF-5 VSFilter colour compat.
 */

let ctx: FeatureContext

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const mod: FeatureModule = {
  id: 'subs-style',
  dependsOn: ['core-mpv-bus', 'subs-tracks'],
  ownsProperties: [
    'sub-font',
    'sub-font-size',
    'sub-bold',
    'sub-italic',
    'sub-color',
    'sub-outline-color',
    'sub-outline-size',
    'sub-back-color',
    'sub-shadow-offset',
    'sub-border-style',
    'sub-pos',
    'sub-margin-x',
    'sub-margin-y',
    'sub-align-x',
    'sub-align-y',
    'sub-justify',
    'sub-spacing',
    'sub-line-spacing',
    'sub-margin-y-offset',
    'sub-scale-signs',
    'sub-ass-style-overrides',
    'sub-ass-styles',
    'sub-ass-force-margins',
    'stretch-dvd-subs',
    'stretch-image-subs-to-screen',
    'image-subs-video-resolution',
    'sub-forced-events-only',
    'image-subs-hdr-peak',
    'sub-hdr-peak',
    'sub-filter-sdh',
    'sub-filter-sdh-harder',
    'sub-filter-sdh-enclosures',
    'sub-filter-regex',
    'sub-filter-regex-enable',
    'sub-filter-regex-plain',
    'sub-filter-regex-warn',
    'secondary-sub-ass-override',
    'sub-blur',
    'sub-scale',
    'sub-scale-by-window',
    'sub-scale-with-window',
    'sub-ass-override',
    'sub-ass-scale-with-window',
    'sub-ass-vsfilter-color-compat',
    'sub-use-margins',
    'sub-gauss',
    'embeddedfonts',
    'sub-fonts-dir',
    'secondary-sub-scale',
    'secondary-sub-pos'
  ],

  setup(c): void {
    ctx = c
    const cfg = loadConfig()

    // S24/S26. Both of these were hardcoded controls in the shared
    // settings.html (`#subScale`, `#subAssOverride`) — the M38 <-> M19
    // collision. They are descriptors now, owned by the module that owns
    // `sub-scale` and `sub-ass-override`.
    ctx.settings.define([
      {
        id: 'subs-style.assOverride',
        section: 'subtitles',
        labelKey: 'subs-style.assOverrideLabel',
        descriptionKey: 'subs-style.assOverrideDesc',
        type: { kind: 'bool' },
        default: false,
        mpvOption: 'sub-ass-override',
        keywords: ['ass', '스타일', 'style', 'override'],
        order: 20
      },
      {
        id: 'subs-style.scale',
        section: 'subtitles',
        labelKey: 'subs-style.scaleLabel',
        type: { kind: 'float', min: 0.4, max: 2.5, step: 0.05 },
        default: 1,
        mpvOption: 'sub-scale',
        keywords: ['자막 크기', 'size', 'scale'],
        order: 30
      }
    ])
    if (typeof cfg.subScale === 'number') ctx.settings.set('subs-style.scale', cfg.subScale)
    if (typeof cfg.subAssOverride === 'boolean') {
      ctx.settings.set('subs-style.assOverride', cfg.subAssOverride)
    }
    ctx.settings.onChange<number>('subs-style.scale', (v) => {
      void ctx.commands.invoke('subs-style.setScale', v)
    })
    ctx.settings.onChange<boolean>('subs-style.assOverride', (v) => {
      void ctx.commands.invoke('subs-style.setAssOverride', v)
    })

    ctx.mpv.contributeArgs(10, () => [
      `--sub-scale=${ctx.settings.get<number>('subs-style.scale')}`,
      // Render release-group styling as authored. Forcing our own font is
      // available in settings but must not be the default.
      `--sub-ass-override=${ctx.settings.get<boolean>('subs-style.assOverride') ? 'force' : 'no'}`
    ])

    ctx.commands.register([
      {
        id: 'subs-style.setScale',
        labelKey: 'subs-style.setScale',
        category: 'subtitles',
        internal: true,
        run: async (arg) => {
          const v = clamp(Number(arg), 0.2, 4)
          await ctx.mpv.set('sub-scale', v)
          saveConfig({ subScale: v })
          ctx.osd.show({ kind: 'info', text: `자막 크기 ${v.toFixed(2)}×` })
        }
      },
      {
        id: 'subs-style.setPos',
        labelKey: 'subs-style.setPos',
        category: 'subtitles',
        internal: true,
        run: (arg) => ctx.mpv.set('sub-pos', clamp(Math.round(Number(arg)), 0, 150))
      },
      {
        id: 'subs-style.setAssOverride',
        labelKey: 'subs-style.setAssOverride',
        category: 'subtitles',
        internal: true,
        run: async (arg) => {
          const on = arg === true
          await ctx.mpv.set('sub-ass-override', on ? 'force' : 'no')
          saveConfig({ subAssOverride: on })
        }
      }
    ])

    ctx.i18n.register('ko', {
      'subs-style.scaleLabel': '자막 크기',
      'subs-style.assOverrideLabel': 'ASS 자막 스타일 덮어쓰기',
      'subs-style.assOverrideDesc':
        '기본값은 꺼짐입니다. 켜면 제작자가 지정한 글꼴·위치 대신 아래 크기 설정을 강제합니다.',
      'subs-style.setScale': '자막 크기',
      'subs-style.setPos': '자막 위치',
      'subs-style.setAssOverride': '자막 스타일 강제'
    })
    ctx.i18n.register('en', {
      'subs-style.setScale': 'Subtitle scale',
      'subs-style.setPos': 'Subtitle position',
      'subs-style.setAssOverride': 'Override subtitle styling'
    })
  }
}

export default mod
