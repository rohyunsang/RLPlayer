import type { FeatureContext, FeatureModule } from '@shared/feature-api'

/**
 * M20 subs-sync — subtitle timing. WAVE 0 SEED: the new owner of `subDelay`.
 */

let ctx: FeatureContext

const delay = (): number => ctx.mpv.peek<number>('sub-delay') ?? 0
const round2 = (v: number): number => Math.round(v * 100) / 100

async function setDelay(value: number): Promise<void> {
  const v = round2(value)
  await ctx.mpv.set('sub-delay', v)
  ctx.osd.show({ kind: 'subdelay', text: `자막 ${v > 0 ? '+' : ''}${v.toFixed(2)}초` })
}

const mod: FeatureModule = {
  id: 'subs-sync',
  // §1.5: `sub-step` shifts subtitle TIMING and `sub-seek` seeks VIDEO. The
  // confusable pair has one owner on purpose — that is what stops the bug.
  ownsCommands: ['sub-seek', 'sub-step'],
  ownsProperties: [
    'sub-delay',
    'secondary-sub-delay',
    'sub-speed',
    'sub-fix-timing',
    'sub-fix-timing-threshold',
    'sub-fix-timing-keep',
    'sub-stretch-durations'
  ],

  setup(c): void {
    ctx = c

    ctx.perFile.slice({
      key: 'subs-sync',
      capture: () => ({ subDelay: delay() }),
      apply: async (v) => {
        if (typeof v.subDelay === 'number') await ctx.mpv.set('sub-delay', v.subDelay)
      },
      rememberDefaults: { subDelay: true }
    })

    ctx.commands.register([
      {
        id: 'subs-sync.setDelay',
        labelKey: 'subs-sync.setDelay',
        category: 'subtitles',
        internal: true,
        run: (arg) => setDelay(Number(arg))
      },
      {
        id: 'subs-sync.delayUp',
        labelKey: 'subs-sync.delayUp',
        category: 'subtitles',
        defaults: { default: ['Shift+KeyG'] },
        run: () => setDelay(delay() + 0.1)
      },
      {
        id: 'subs-sync.delayDown',
        labelKey: 'subs-sync.delayDown',
        category: 'subtitles',
        defaults: { default: ['Shift+KeyF'] },
        run: () => setDelay(delay() - 0.1)
      },
      {
        id: 'subs-sync.resetDelay',
        labelKey: 'subs-sync.resetDelay',
        category: 'subtitles',
        run: () => setDelay(0)
      }
    ])

    ctx.i18n.register('ko', {
      'subs-sync.setDelay': '자막 싱크 지정',
      'subs-sync.delayUp': '자막 싱크 +0.1초',
      'subs-sync.delayDown': '자막 싱크 -0.1초',
      'subs-sync.resetDelay': '자막 싱크 초기화'
    })
    ctx.i18n.register('en', {
      'subs-sync.setDelay': 'Set subtitle delay',
      'subs-sync.delayUp': 'Subtitle delay +0.1s',
      'subs-sync.delayDown': 'Subtitle delay -0.1s',
      'subs-sync.resetDelay': 'Reset subtitle delay'
    })
  }
}

export default mod
