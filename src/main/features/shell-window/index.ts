import type { FeatureContext, FeatureModule, OnTopMode } from '@shared/feature-api'

/**
 * M31 shell-window — window chrome, fullscreen and always-on-top.
 *
 * WAVE 0 SEED: the new owner of `fullscreen` and `alwaysOnTop`.
 *
 * This module writes NO mpv properties, and that is not an oversight: every mpv
 * window option is inert under `--wid` (§7.5). `--fullscreen`, `--ontop`,
 * `--geometry`, `--autofit` and twenty more are accepted, report success and do
 * nothing, because mpv is not managing a window. All of it is Electron work,
 * reached through `ctx.window` — and `core/mpv/reserved.ts` throws at boot if
 * any module contributes one of those flags anyway.
 *
 * U07 is a four-mode CYCLE, not a boolean: never / always / while-playing /
 * fullscreen-only.
 */

const ONTOP_ORDER: OnTopMode[] = ['never', 'always', 'while-playing', 'fullscreen-only']
const ONTOP_LABELS: Record<OnTopMode, string> = {
  never: '항상 위 해제',
  always: '항상 위에',
  'while-playing': '재생 중에만 위에',
  'fullscreen-only': '전체화면에서만 위에'
}

let ctx: FeatureContext

const mod: FeatureModule = {
  id: 'shell-window',
  ownsProperties: [],

  setup(c): void {
    ctx = c

    ctx.commands.register([
      {
        id: 'shell-window.toggleFullScreen',
        labelKey: 'shell-window.toggleFullScreen',
        category: 'window',
        defaults: {
          default: ['KeyF', 'Enter'],
          potplayer: ['Enter', 'Alt+Enter', 'KeyF'],
          mpv: ['KeyF']
        },
        run: () => {
          ctx.window.toggleFullScreen()
        }
      },
      {
        id: 'shell-window.exitFullScreen',
        labelKey: 'shell-window.exitFullScreen',
        category: 'window',
        defaults: { default: ['Escape'], potplayer: ['Escape'], mpv: ['Escape'] },
        run: () => {
          if (ctx.window.isMiniPlayer()) ctx.window.exitMiniPlayer()
          else ctx.window.setFullScreen(false)
        }
      },
      {
        id: 'shell-window.setFullScreen',
        labelKey: 'shell-window.setFullScreen',
        category: 'window',
        internal: true,
        run: (arg) => {
          ctx.window.setFullScreen(arg === true)
        }
      },
      {
        id: 'shell-window.cycleAlwaysOnTop',
        labelKey: 'shell-window.cycleAlwaysOnTop',
        category: 'window',
        defaults: { default: ['KeyT'], potplayer: ['KeyT'], mpv: ['KeyT'] },
        run: () => {
          const now = ctx.window.getAlwaysOnTop()
          const next = ONTOP_ORDER[(ONTOP_ORDER.indexOf(now) + 1) % ONTOP_ORDER.length] ?? 'never'
          ctx.window.setAlwaysOnTop(next)
          ctx.osd.show({ kind: 'info', text: ONTOP_LABELS[next] })
        }
      },
      {
        id: 'shell-window.toggleMaximize',
        labelKey: 'shell-window.toggleMaximize',
        category: 'window',
        run: () => {
          if (ctx.window.isMaximized()) ctx.window.unmaximize()
          else ctx.window.maximize()
        }
      },
      {
        id: 'shell-window.minimize',
        labelKey: 'shell-window.minimize',
        category: 'window',
        run: () => ctx.window.minimize()
      },
      {
        id: 'shell-window.close',
        labelKey: 'shell-window.close',
        category: 'window',
        run: () => ctx.window.close()
      },
      {
        id: 'shell-window.toggleMiniPlayer',
        labelKey: 'shell-window.toggleMiniPlayer',
        category: 'window',
        run: () => {
          if (ctx.window.isMiniPlayer()) ctx.window.exitMiniPlayer()
          else ctx.window.enterMiniPlayer()
        }
      }
    ])

    // Window chrome the overlay drives directly. These are `shell-window:*`
    // channels, so nothing outside this module can claim them.
    ctx.ipc.on('shell-window:minimize', () => ctx.window.minimize())
    ctx.ipc.on('shell-window:toggleMaximize', () => {
      if (ctx.window.isMaximized()) ctx.window.unmaximize()
      else ctx.window.maximize()
    })
    ctx.ipc.on('shell-window:close', () => ctx.window.close())
    ctx.ipc.on<{ mode: 'move' | 'resize'; edge?: string }>('shell-window:beginDrag', (req) =>
      ctx.window.beginDrag(req.mode, req.edge)
    )
    ctx.ipc.on('shell-window:endDrag', () => ctx.window.endDrag())
    ctx.ipc.on('shell-window:toggleFullscreen', () => ctx.window.toggleFullScreen())
    ctx.ipc.on<boolean>('shell-window:setFullscreen', (on) => ctx.window.setFullScreen(on === true))
    ctx.ipc.on('shell-window:cycleOnTop', () =>
      ctx.commands.invoke('shell-window.cycleAlwaysOnTop')
    )

    ctx.menu.contribute({
      id: 'shell-window.menu',
      labelKey: 'shell-window.menuTitle',
      order: 70,
      items: [
        {
          commandId: 'shell-window.cycleAlwaysOnTop',
          checked: ctx.window.getAlwaysOnTop() !== 'never'
        },
        { commandId: 'shell-window.toggleFullScreen' },
        { commandId: 'shell-window.toggleMiniPlayer' }
      ]
    })

    ctx.i18n.register('ko', {
      'shell-window.toggleFullScreen': '전체화면',
      'shell-window.exitFullScreen': '전체화면 종료',
      'shell-window.setFullScreen': '전체화면 지정',
      'shell-window.cycleAlwaysOnTop': '항상 위에 표시',
      'shell-window.toggleMaximize': '최대화',
      'shell-window.minimize': '최소화',
      'shell-window.close': '닫기',
      'shell-window.toggleMiniPlayer': '미니 플레이어',
      'shell-window.menuTitle': '창'
    })
    ctx.i18n.register('en', {
      'shell-window.toggleFullScreen': 'Fullscreen',
      'shell-window.exitFullScreen': 'Exit fullscreen',
      'shell-window.setFullScreen': 'Set fullscreen',
      'shell-window.cycleAlwaysOnTop': 'Always on top',
      'shell-window.toggleMaximize': 'Maximize',
      'shell-window.minimize': 'Minimize',
      'shell-window.close': 'Close',
      'shell-window.toggleMiniPlayer': 'Mini player',
      'shell-window.menuTitle': 'Window'
    })
  }
}

export default mod
