import type { FeatureContext, FeatureModule } from '@shared/feature-api'

/**
 * M24 nav-seek — seeking and frame stepping.
 *
 * WAVE 0 SEED: the new owner of `seek`, `frameBack` and `frameForward` from the
 * legacy 22-action table. Seeking is a COMMAND, not a property, so this module
 * owns no properties at all (§3.7) — command ownership is treated the same way.
 *
 * N29: every absolute seek is `absolute+exact`. A keyframe seek can land tens of
 * seconds from where the user aimed, which is the difference between "the seek
 * bar works" and "the seek bar is approximate".
 */

let ctx: FeatureContext

const idle = (): boolean => ctx.mpv.peek<boolean>('idle-active') === true
const timePos = (): number => ctx.mpv.peek<number>('time-pos') ?? 0
const duration = (): number => ctx.mpv.peek<number>('duration') ?? 0

async function relative(seconds: number): Promise<void> {
  if (idle()) return
  await ctx.mpv.command(['seek', seconds, 'relative']).catch(() => {})
  ctx.osd.show({
    kind: 'seek',
    text: `${seconds > 0 ? '▶▶' : '◀◀'} ${Math.abs(seconds)}초`
  })
}

async function absolute(seconds: number, quiet = false): Promise<void> {
  if (idle()) return
  await ctx.mpv.command(['seek', seconds, 'absolute+exact']).catch(() => {})
  if (!quiet) ctx.osd.show({ kind: 'seek', text: format(seconds) })
}

function format(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

const mod: FeatureModule = {
  id: 'nav-seek',
  ownsProperties: [],

  setup(c): void {
    ctx = c

    // Drag-scrub. commandNoReply because this fires many times a second and a
    // reply per frame would queue behind the pipe.
    ctx.ipc.on<{ seconds: number; absolute?: boolean; exact?: boolean }>(
      'nav-seek:scrub',
      (req) => {
        if (idle()) return
        ctx.mpv.commandNoReply([
          'seek',
          req.seconds,
          req.absolute ? (req.exact === false ? 'absolute' : 'absolute+exact') : 'relative'
        ])
      }
    )

    ctx.commands.register([
      {
        id: 'nav-seek.seek',
        labelKey: 'nav-seek.seek',
        category: 'navigation',
        internal: true,
        run: (arg) => {
          const a = (arg ?? {}) as { seconds?: number; absolute?: boolean }
          return a.absolute ? absolute(a.seconds ?? 0) : relative(a.seconds ?? 0)
        }
      },
      {
        id: 'nav-seek.forward5',
        labelKey: 'nav-seek.forward5',
        category: 'navigation',
        defaults: {
          default: ['ArrowRight'],
          potplayer: ['ArrowRight'],
          mpv: ['ArrowRight']
        },
        run: () => relative(5)
      },
      {
        id: 'nav-seek.back5',
        labelKey: 'nav-seek.back5',
        category: 'navigation',
        defaults: { default: ['ArrowLeft'], potplayer: ['ArrowLeft'], mpv: ['ArrowLeft'] },
        run: () => relative(-5)
      },
      {
        id: 'nav-seek.forward30',
        labelKey: 'nav-seek.forward30',
        category: 'navigation',
        defaults: { potplayer: ['Shift+ArrowRight'] },
        run: () => relative(30)
      },
      {
        id: 'nav-seek.back30',
        labelKey: 'nav-seek.back30',
        category: 'navigation',
        defaults: { potplayer: ['Shift+ArrowLeft'] },
        run: () => relative(-30)
      },
      {
        id: 'nav-seek.forward60',
        labelKey: 'nav-seek.forward60',
        category: 'navigation',
        defaults: {
          default: ['Shift+ArrowRight'],
          potplayer: ['Ctrl+ArrowRight'],
          mpv: ['ArrowUp']
        },
        run: () => relative(60)
      },
      {
        id: 'nav-seek.back60',
        labelKey: 'nav-seek.back60',
        category: 'navigation',
        defaults: {
          default: ['Shift+ArrowLeft'],
          potplayer: ['Ctrl+ArrowLeft'],
          mpv: ['ArrowDown']
        },
        run: () => relative(-60)
      },
      {
        id: 'nav-seek.toStart',
        labelKey: 'nav-seek.toStart',
        category: 'navigation',
        defaults: { default: ['Home'], potplayer: ['Home'] },
        run: () => absolute(0)
      },
      {
        id: 'nav-seek.toEnd',
        labelKey: 'nav-seek.toEnd',
        category: 'navigation',
        defaults: { default: ['End'], potplayer: ['End'] },
        run: () => absolute(Math.max(0, duration() - 3))
      },
      {
        id: 'nav-seek.frameForward',
        labelKey: 'nav-seek.frameForward',
        category: 'navigation',
        defaults: {
          default: ['Period'],
          potplayer: ['Period', 'KeyD'],
          mpv: ['Period']
        },
        // §7.7 trap 3: frame-step replies BEFORE it moves. The UI is driven by
        // the time-pos observer, never by this reply.
        run: () => ctx.mpv.command(['frame-step']).then(() => undefined, () => undefined)
      },
      {
        id: 'nav-seek.frameBack',
        labelKey: 'nav-seek.frameBack',
        category: 'navigation',
        defaults: { default: ['Comma'], potplayer: ['Comma'], mpv: ['Comma'] },
        run: () => ctx.mpv.command(['frame-back-step']).then(() => undefined, () => undefined)
      },
      {
        id: 'nav-seek.currentTime',
        labelKey: 'nav-seek.currentTime',
        category: 'navigation',
        internal: true,
        run: () => {
          ctx.osd.show({ kind: 'info', text: `${format(timePos())} / ${format(duration())}` })
        }
      }
    ])

    ctx.i18n.register('ko', {
      'nav-seek.seek': '탐색',
      'nav-seek.forward5': '5초 앞으로',
      'nav-seek.back5': '5초 뒤로',
      'nav-seek.forward30': '30초 앞으로',
      'nav-seek.back30': '30초 뒤로',
      'nav-seek.forward60': '1분 앞으로',
      'nav-seek.back60': '1분 뒤로',
      'nav-seek.toStart': '처음으로',
      'nav-seek.toEnd': '끝으로',
      'nav-seek.frameForward': '다음 프레임',
      'nav-seek.frameBack': '이전 프레임',
      'nav-seek.currentTime': '현재 시간 표시'
    })
    ctx.i18n.register('en', {
      'nav-seek.seek': 'Seek',
      'nav-seek.forward5': 'Forward 5s',
      'nav-seek.back5': 'Back 5s',
      'nav-seek.forward30': 'Forward 30s',
      'nav-seek.back30': 'Back 30s',
      'nav-seek.forward60': 'Forward 1m',
      'nav-seek.back60': 'Back 1m',
      'nav-seek.toStart': 'Go to start',
      'nav-seek.toEnd': 'Go to end',
      'nav-seek.frameForward': 'Next frame',
      'nav-seek.frameBack': 'Previous frame',
      'nav-seek.currentTime': 'Show current time'
    })
  }
}

export default mod
