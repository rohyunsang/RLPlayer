import type { Chapter } from '@shared/types'
import type { FeatureContext, FeatureModule, MenuNode } from '@shared/feature-api'

/**
 * M25 nav-chapters — chapter navigation.
 *
 * WAVE 0 SEED: the new owner of `chapterNext` / `chapterPrev`.
 *
 * N03: these are `add chapter ±1`, not a hand-rolled "find the chapter whose
 * time is nearest" loop. v0.1 reimplemented mpv's own seek threshold and got a
 * different answer from mpv, so pressing "previous chapter" one second into a
 * chapter jumped back two.
 */

let ctx: FeatureContext

const chapters = (): Chapter[] => ctx.mpv.peek<Chapter[]>('chapter-list') ?? []

async function step(delta: number): Promise<void> {
  if (chapters().length === 0) return
  await ctx.mpv.command(['add', 'chapter', delta]).catch(() => {})
  announce()
}

function announce(): void {
  const list = chapters()
  const index = ctx.mpv.peek<number>('chapter') ?? -1
  const title = index >= 0 ? list[index]?.title : undefined
  if (title) ctx.osd.show({ kind: 'chapter', text: `${index + 1}/${list.length} ${title}` })
}

const mod: FeatureModule = {
  id: 'nav-chapters',
  ownsProperties: [
    'chapter',
    'edition',
    'chapter-seek-threshold',
    'chapter-merge-threshold',
    'ordered-chapters'
  ],

  setup(c): void {
    ctx = c

    // The renderer half's chapter-tick layer sends here. It never writes an
    // mpv property itself; `chapter` is this module's (§3.7).
    ctx.ipc.on<{ index: number }>('nav-chapters:goto', (req) => {
      void ctx.commands.invoke('nav-chapters.goto', req?.index)
    })

    ctx.commands.register([
      {
        id: 'nav-chapters.next',
        labelKey: 'nav-chapters.next',
        category: 'navigation',
        defaults: { default: ['PageDown'], mpv: ['PageDown'] },
        enabledWhen: () => chapters().length > 0,
        run: () => step(1)
      },
      {
        id: 'nav-chapters.prev',
        labelKey: 'nav-chapters.prev',
        category: 'navigation',
        defaults: { default: ['PageUp'], mpv: ['PageUp'] },
        enabledWhen: () => chapters().length > 0,
        run: () => step(-1)
      },
      {
        id: 'nav-chapters.goto',
        labelKey: 'nav-chapters.goto',
        category: 'navigation',
        internal: true,
        run: async (arg) => {
          const index = Number(arg)
          if (!Number.isFinite(index)) return
          await ctx.mpv.set('chapter', index).catch(() => {})
          announce()
        }
      }
    ])

    ctx.menu.contribute({
      id: 'nav-chapters.menu',
      labelKey: 'nav-chapters.menuTitle',
      order: 45,
      items: [
        {
          labelKey: 'nav-chapters.menuTitle',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const list = chapters()
                if (list.length === 0) {
                  return [{ labelKey: 'nav-chapters.none', enabled: false }]
                }
                const current = ctx.mpv.peek<number>('chapter') ?? -1
                return list.map((ch, i) => ({
                  label: `${i + 1}. ${ch.title}`,
                  commandId: 'nav-chapters.goto',
                  arg: i,
                  radio: true,
                  checked: i === current
                }))
              }
            }
          ]
        }
      ]
    })

    ctx.i18n.register('ko', {
      'nav-chapters.next': '다음 챕터',
      'nav-chapters.prev': '이전 챕터',
      'nav-chapters.goto': '챕터로 이동',
      'nav-chapters.menuTitle': '챕터',
      'nav-chapters.none': '(챕터 없음)'
    })
    ctx.i18n.register('en', {
      'nav-chapters.next': 'Next chapter',
      'nav-chapters.prev': 'Previous chapter',
      'nav-chapters.goto': 'Go to chapter',
      'nav-chapters.menuTitle': 'Chapters',
      'nav-chapters.none': '(no chapters)'
    })
  }
}

export default mod
