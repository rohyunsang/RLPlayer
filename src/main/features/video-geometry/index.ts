import type { FeatureContext, FeatureModule, MenuNode } from '@shared/feature-api'

/**
 * M02 video-geometry — aspect, rotation, zoom, pan, crop and margins.
 *
 * WAVE 0 SEED: aspect override and rotation, which is what v0.1 shipped.
 *
 * V22: mpv's "no override" value for `video-aspect-override` is the STRING
 * 'no'. v0.1 wrote '-1', which mpv accepts as a ratio of -1 rather than as
 * "off" — the menu's 자동 entry therefore never quite matched what mpv
 * reported back.
 *
 * `video-geometry.setFitMode` is the mediator M31 (U46) and M09 must use:
 * `keepaspect` and `panscan` move together with the zoom/pan reset that V23
 * requires, and a raw write would skip that half.
 */

const ASPECTS: Array<[string, string]> = [
  ['자동', 'no'],
  ['16:9', '1.7777'],
  ['4:3', '1.3333'],
  ['1:1', '1.0'],
  ['16:10', '1.6'],
  ['2.35:1', '2.35']
]

let ctx: FeatureContext

const aspect = (): string => {
  const v = ctx.mpv.peek<unknown>('video-aspect-override')
  return v === undefined || v === null ? 'no' : String(v)
}

const mod: FeatureModule = {
  id: 'video-geometry',
  ownsProperties: [
    'video-aspect-override',
    'video-aspect-method',
    'keepaspect',
    'panscan',
    'video-unscaled',
    'video-zoom',
    'video-pan-x',
    'video-pan-y',
    'video-scale-x',
    'video-scale-y',
    'video-align-x',
    'video-align-y',
    'video-crop',
    'video-rotate',
    'video-margin-ratio-top',
    'video-margin-ratio-bottom',
    'video-margin-ratio-left',
    'video-margin-ratio-right'
  ],

  setup(c): void {
    ctx = c

    ctx.perFile.slice({
      key: 'video-geometry',
      capture: () => ({
        aspect: aspect(),
        rotate: ctx.mpv.peek<number>('video-rotate') ?? 0
      }),
      apply: async (v) => {
        if (typeof v.aspect === 'string') await ctx.mpv.set('video-aspect-override', v.aspect)
        if (typeof v.rotate === 'number') await ctx.mpv.set('video-rotate', v.rotate)
      },
      rememberDefaults: { aspect: true, rotate: true }
    })

    ctx.commands.register([
      {
        id: 'video-geometry.setAspect',
        labelKey: 'video-geometry.setAspect',
        category: 'video',
        internal: true,
        run: async (arg) => {
          const value = String(arg ?? 'no')
          await ctx.mpv.set('video-aspect-override', value)
          const name = ASPECTS.find(([, v]) => v === value)?.[0] ?? value
          ctx.osd.show({ kind: 'aspect', text: `화면 비율 ${name}` })
        }
      },
      {
        id: 'video-geometry.rotate',
        labelKey: 'video-geometry.rotate',
        category: 'video',
        internal: true,
        run: async (arg) => {
          const deg = ((Number(arg) % 360) + 360) % 360
          await ctx.mpv.set('video-rotate', deg)
          ctx.osd.show({ kind: 'aspect', text: `회전 ${deg}°` })
        }
      },
      {
        id: 'video-geometry.rotateCw',
        labelKey: 'video-geometry.rotateCw',
        category: 'video',
        run: async () => {
          const deg = (((ctx.mpv.peek<number>('video-rotate') ?? 0) + 90) % 360 + 360) % 360
          await ctx.mpv.set('video-rotate', deg)
          ctx.osd.show({ kind: 'aspect', text: `회전 ${deg}°` })
        }
      },
      {
        /** Mediator (§3.7.3). The ONLY way to move keepaspect/panscan. */
        id: 'video-geometry.setFitMode',
        labelKey: 'video-geometry.setFitMode',
        category: 'video',
        internal: true,
        run: async (arg) => {
          const mode = String(arg ?? 'keep')
          // V23: a fit-mode change resets zoom and pan. A raw keepaspect write
          // would leave the previous zoom applied on top of the new fit.
          await ctx.mpv.set('video-zoom', 0)
          await ctx.mpv.set('video-pan-x', 0)
          await ctx.mpv.set('video-pan-y', 0)
          if (mode === 'stretch') {
            await ctx.mpv.set('keepaspect', false)
            await ctx.mpv.set('panscan', 0)
          } else if (mode === 'crop') {
            await ctx.mpv.set('keepaspect', true)
            await ctx.mpv.set('panscan', 1)
          } else {
            await ctx.mpv.set('keepaspect', true)
            await ctx.mpv.set('panscan', 0)
          }
        }
      }
    ])

    ctx.menu.contribute({
      id: 'video-geometry.menu',
      labelKey: 'video-geometry.menuTitle',
      order: 50,
      items: [
        {
          labelKey: 'video-geometry.aspectTitle',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const current = aspect()
                return ASPECTS.map(([name, value]) => ({
                  label: name,
                  commandId: 'video-geometry.setAspect',
                  arg: value,
                  radio: true,
                  checked:
                    current === value ||
                    (value === 'no' && (current === 'no' || Number(current) <= 0))
                }))
              }
            }
          ]
        },
        {
          labelKey: 'video-geometry.rotateTitle',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const current = ctx.mpv.peek<number>('video-rotate') ?? 0
                return [0, 90, 180, 270].map((deg) => ({
                  label: `${deg}°`,
                  commandId: 'video-geometry.rotate',
                  arg: deg,
                  radio: true,
                  checked: current === deg
                }))
              }
            }
          ]
        }
      ]
    })

    ctx.i18n.register('ko', {
      'video-geometry.setAspect': '화면 비율',
      'video-geometry.rotate': '회전',
      'video-geometry.rotateCw': '시계 방향으로 회전',
      'video-geometry.setFitMode': '화면 맞춤 방식',
      'video-geometry.menuTitle': '화면',
      'video-geometry.aspectTitle': '화면 비율',
      'video-geometry.rotateTitle': '회전'
    })
    ctx.i18n.register('en', {
      'video-geometry.setAspect': 'Aspect ratio',
      'video-geometry.rotate': 'Rotate',
      'video-geometry.rotateCw': 'Rotate clockwise',
      'video-geometry.setFitMode': 'Fit mode',
      'video-geometry.menuTitle': 'Video',
      'video-geometry.aspectTitle': 'Aspect ratio',
      'video-geometry.rotateTitle': 'Rotate'
    })
  }
}

export default mod
