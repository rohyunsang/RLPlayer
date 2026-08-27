import path from 'node:path'
import { SUB_EXTENSIONS } from '@shared/media-types'
import type { Track } from '@shared/types'
import type { FeatureContext, FeatureModule, MenuNode } from '@shared/feature-api'

/**
 * M17 subs-tracks — subtitle track selection and external subtitle loading.
 *
 * WAVE 0 SEED: the new owner of `toggleSubs` and `cycleSub`, and the SOLE owner
 * of `sid` and `sub-reload` (§3.7.1). `sub-reload` had three claimants across
 * two pages of the spec; it is M17's, and M18/M19 call `subs-tracks.reload`.
 *
 * S09 is fixed here: v0.1 shipped
 *   --sub-file-paths=subs:Subs:subtitles:Subtitles:SUBS
 * which on Windows is ONE path with colons in it (the separator is ';'), so it
 * scanned nothing, and the case variants would have created duplicate tracks on
 * NTFS if it had.
 */

let ctx: FeatureContext
let reloadTimer: NodeJS.Timeout | null = null

const tracks = (): Track[] => ctx.mpv.peek<Track[]>('track-list') ?? []
const subTracks = (): Track[] => tracks().filter((t) => t.type === 'sub')

function label(t: Track): string {
  const bits = [String(t.id)]
  if (t.lang) bits.push(t.lang)
  if (t.title) bits.push(t.title)
  if (t.external) bits.push('(외부)')
  return bits.join(' · ')
}

const mod: FeatureModule = {
  id: 'subs-tracks',
  ownsProperties: [
    'sid',
    'secondary-sid',
    'slang',
    'sub-visibility',
    'secondary-sub-visibility',
    'sub-auto',
    'sub-auto-exts',
    'sub-file-paths',
    'subs-fallback',
    'subs-fallback-forced',
    'subs-match-os-language',
    'sub-create-cc-track',
    'sub-reload'
  ],

  setup(c): void {
    ctx = c

    ctx.mpv.contributeArgs(10, () => [
      // Subtitle auto-loading is mpv's job: `fuzzy` matches Show.S01E02.en.srt
      // against Show.S01E02.mkv.
      '--sub-auto=fuzzy',
      // ';' on Windows, and ONE case per name: NTFS is case-insensitive, so
      // 'subs' and 'Subs' both match the same directory and mpv adds the file
      // twice.
      '--sub-file-paths=sub;subs;subtitles;자막'
    ])

    ctx.perFile.slice({
      key: 'subs-tracks',
      capture: () => ({
        sid: ctx.mpv.peek<number | false>('sid') ?? false,
        visible: ctx.mpv.peek<boolean>('sub-visibility') !== false
      }),
      apply: async (v) => {
        if (typeof v.sid === 'number') await ctx.mpv.set('sid', v.sid)
        if (typeof v.visible === 'boolean') await ctx.mpv.set('sub-visibility', v.visible)
      },
      rememberDefaults: { sid: true, visible: true }
    })

    ctx.ipc.handle<{ file: string }, boolean>('subs-tracks:add', async (req) => {
      if (!req?.file) return false
      return addSubtitle(req.file)
    })

    ctx.commands.register([
      {
        id: 'subs-tracks.toggleVisibility',
        labelKey: 'subs-tracks.toggleVisibility',
        category: 'subtitles',
        menuPath: 'subtitles',
        defaults: { default: ['KeyV'], mpv: ['KeyV'] },
        run: async () => {
          const next = ctx.mpv.peek<boolean>('sub-visibility') === false
          await ctx.mpv.set('sub-visibility', next)
          ctx.osd.show({ kind: 'track', text: next ? '자막 켜짐' : '자막 꺼짐' })
        }
      },
      {
        id: 'subs-tracks.cycle',
        labelKey: 'subs-tracks.cycle',
        category: 'subtitles',
        defaults: { default: ['KeyJ'], mpv: ['KeyJ'] },
        run: async () => {
          await ctx.mpv.command(['cycle', 'sid']).catch(() => {})
          const now = ctx.mpv.peek<number | false>('sid')
          const t = subTracks().find((x) => x.id === now)
          ctx.osd.show({ kind: 'track', text: t ? `자막 ${label(t)}` : '자막 없음' })
        }
      },
      {
        id: 'subs-tracks.select',
        labelKey: 'subs-tracks.select',
        category: 'subtitles',
        internal: true,
        run: async (arg) => {
          const id = arg === false || arg === 'no' ? 'no' : Number(arg)
          await ctx.mpv.set('sid', id)
        }
      },
      {
        /** Mediator: M28 routes dropped .srt files here rather than issuing
         *  `sub-add` itself, because M17 owns the external-track set. */
        id: 'subs-tracks.addFile',
        labelKey: 'subs-tracks.addFile',
        category: 'subtitles',
        internal: true,
        run: (arg) => addSubtitle(String(arg ?? ''))
      },
      {
        id: 'subs-tracks.open',
        labelKey: 'subs-tracks.open',
        category: 'subtitles',
        run: async () => {
          const files = await ctx.dialog.openFiles({
            titleKey: 'subs-tracks.openTitle',
            filters: [
              { name: '자막', extensions: SUB_EXTENSIONS },
              { name: '모든 파일', extensions: ['*'] }
            ]
          })
          for (const f of files) await addSubtitle(f)
        }
      },
      {
        /** Mediator (§3.7.3). M18 (S34) and M19 (S22) call this; neither may
         *  write `sub-reload`. Debounced, because S12's fs.watch loop fires
         *  several times for one save. */
        id: 'subs-tracks.reload',
        labelKey: 'subs-tracks.reload',
        category: 'subtitles',
        internal: true,
        run: () => {
          if (reloadTimer) clearTimeout(reloadTimer)
          reloadTimer = setTimeout(() => {
            reloadTimer = null
            const sid = ctx.mpv.peek<number | false>('sid')
            const track = subTracks().find((t) => t.id === sid)
            // No-op for embedded tracks: sub-reload only re-reads external ones.
            if (!track?.external) return
            void ctx.mpv
              .command(['sub-reload'])
              .then(() => ctx.mpv.set('sid', sid as number))
              .catch(() => undefined)
          }, 300)
        }
      }
    ])

    ctx.menu.contribute({
      id: 'subs-tracks.menu',
      labelKey: 'subs-tracks.menuTitle',
      order: 41,
      items: [
        {
          labelKey: 'subs-tracks.menuTitle',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const list = subTracks()
                const current = ctx.mpv.peek<number | false>('sid')
                const items: MenuNode[] = list.map((t) => ({
                  label: label(t),
                  commandId: 'subs-tracks.select',
                  arg: t.id,
                  radio: true,
                  checked: current === t.id
                }))
                if (items.length === 0) items.push({ labelKey: 'subs-tracks.none', enabled: false })
                items.push({ type: 'separator' })
                items.push({
                  labelKey: 'subs-tracks.off',
                  commandId: 'subs-tracks.select',
                  arg: false,
                  radio: true,
                  checked: current === false
                })
                return items
              }
            }
          ]
        },
        { commandId: 'subs-tracks.open' }
      ]
    })

    ctx.i18n.register('ko', {
      'subs-tracks.toggleVisibility': '자막 켜기/끄기',
      'subs-tracks.cycle': '자막 트랙 전환',
      'subs-tracks.select': '자막 트랙 선택',
      'subs-tracks.addFile': '자막 파일 추가',
      'subs-tracks.open': '자막 파일 열기...',
      'subs-tracks.openTitle': '자막 파일 열기',
      'subs-tracks.reload': '자막 다시 읽기',
      'subs-tracks.menuTitle': '자막 트랙',
      'subs-tracks.none': '(트랙 없음)',
      'subs-tracks.off': '사용 안 함',
      'subs-tracks.needVideo': '먼저 동영상을 재생해 주세요',
      'subs-tracks.added': '자막 추가됨: {name}'
    })
    ctx.i18n.register('en', {
      'subs-tracks.toggleVisibility': 'Toggle subtitles',
      'subs-tracks.cycle': 'Cycle subtitle track',
      'subs-tracks.select': 'Select subtitle track',
      'subs-tracks.addFile': 'Add subtitle file',
      'subs-tracks.open': 'Open subtitle file...',
      'subs-tracks.openTitle': 'Open subtitle file',
      'subs-tracks.reload': 'Reload subtitles',
      'subs-tracks.menuTitle': 'Subtitle track',
      'subs-tracks.none': '(no tracks)',
      'subs-tracks.off': 'Off',
      'subs-tracks.needVideo': 'Start a video first',
      'subs-tracks.added': 'Subtitle added: {name}'
    })
  }
}

async function addSubtitle(file: string): Promise<boolean> {
  if (ctx.mpv.peek<boolean>('idle-active') === true) {
    ctx.osd.toast({ kind: 'error', message: ctx.i18n.t('subs-tracks.needVideo') })
    return false
  }
  try {
    await ctx.mpv.command(['sub-add', file, 'select'])
    ctx.osd.toast({
      kind: 'info',
      message: ctx.i18n.t('subs-tracks.added', { name: path.basename(file) })
    })
    return true
  } catch (e) {
    ctx.osd.toast({ kind: 'error', message: `자막을 불러올 수 없습니다: ${(e as Error).message}` })
    return false
  }
}

export default mod
