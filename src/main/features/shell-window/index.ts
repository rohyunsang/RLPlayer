import { loadConfig, saveConfig } from '../../services/config.ts'
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
  dependsOn: ['core-osd', 'core-window', 'video-geometry'],
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

    // U40, and the settings window's layout control. This was
    // `<select id="layoutMode">` plus a five-line explanation of Electron
    // #40515 hardcoded in the shared settings.html; the select is a descriptor
    // now and the prose is a contributed section, because prose is exactly what
    // a descriptor cannot carry.
    ctx.settings.define([
      {
        id: 'shell-window.layoutMode',
        section: 'video',
        labelKey: 'shell-window.layoutMode',
        type: {
          kind: 'enum',
          options: [
            { value: 'overlay', labelKey: 'shell-window.layout.overlay' },
            { value: 'compat', labelKey: 'shell-window.layout.compat' }
          ]
        },
        default: 'overlay',
        requiresRestart: true,
        keywords: ['화면 구성', '호환', 'layout', 'black', '검은'],
        order: 5
      }
    ])
    const legacyLayout = loadConfig().layoutMode
    if (legacyLayout) ctx.settings.set('shell-window.layoutMode', legacyLayout)
    ctx.settings.onChange<'overlay' | 'compat'>('shell-window.layoutMode', (v) => {
      // Window topology is fixed at creation, so this one really does need a
      // relaunch rather than a respawn of mpv.
      saveConfig({ layoutMode: v })
    })

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
      'shell-window.layoutMode': '화면 구성',
      'shell-window.layout.overlay': '기본 (조작부가 영상 위에 겹침)',
      'shell-window.layout.compat': '호환 모드 (조작부를 영상 밖에 배치)',
      'shell-window.layoutHelp': '화면 구성 도움말',
      'shell-window.layoutHint':
        '화면이 검게 나오나요? 일부 그래픽 드라이버에서 투명 창이 검은색으로 렌더링되는 문제가 있습니다 (Electron #40515). 호환 모드는 투명 창을 전혀 쓰지 않고 조작부를 영상 바깥쪽에 배치하므로 이 문제를 피할 수 있습니다. 대신 전체화면에서 조작부가 자동으로 숨겨지지 않고, 영상 부분을 클릭해도 반응하지 않습니다.',
      'shell-window.relaunch': 'RLPlayer 다시 시작',
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
      'shell-window.layoutMode': 'Layout',
      'shell-window.layout.overlay': 'Default (controls float over the video)',
      'shell-window.layout.compat': 'Compatibility (controls sit outside the video)',
      'shell-window.layoutHelp': 'About the layout modes',
      'shell-window.layoutHint':
        'Black screen? Some graphics drivers render a transparent window as solid black (Electron #40515). Compatibility mode uses no transparent window at all and puts the controls outside the video, which avoids it — at the cost of controls that never auto-hide in fullscreen and a video area that does not respond to clicks.',
      'shell-window.relaunch': 'Restart RLPlayer',
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
