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

    ctx.mpv.contributeArgs(10, () => [
      `--sub-scale=${loadConfig().subScale}`,
      // Render release-group styling as authored. Forcing our own font is
      // available in settings but must not be the default.
      `--sub-ass-override=${loadConfig().subAssOverride ? 'force' : 'no'}`
    ])
    void cfg

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
