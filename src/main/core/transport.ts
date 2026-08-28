import { app, dialog, shell } from 'electron'
import { mpvBus } from './mpv/bus.ts'
import { t } from './i18n/index.ts'
import { getUiWindow, getVideoWindow } from './window/windows'
import type { CommandRegistry } from './input/registry.ts'
import type { MenuRegistry } from './menu.ts'
import type { OsdBus } from './osd/index.ts'

/**
 * The core transport commands.
 *
 * §5.10 is explicit that play/pause and the core PlayerState push are NOT
 * migrated to a feature module: they stay in core/mpv/bus as the transport,
 * which is exactly why `pause` is a core-owned property in §3.7. A module that
 * needs playback started calls `core.play` rather than writing `pause`.
 *
 * These are registered under the owner id 'core', so they live in the same
 * command registry, appear in the same cheat sheet, and are rebindable like
 * everything else — but no feature module can register a `core.*` id.
 */

export const RELEASES_URL = 'https://github.com/rohyunsang/RLPlayer/releases'

export interface TransportDeps {
  commands: CommandRegistry
  menu: MenuRegistry
  osd: OsdBus
  openSettings(): void
  quit(): void
}

export function registerCoreCommands(deps: TransportDeps): void {
  // Privileged: core owns `pause` and the rest of the transport (§3.7).
  const mpv = mpvBus.createService('core/mpv/bus', { privileged: true })

  deps.commands.register('core', [
    {
      id: 'core.playPause',
      labelKey: 'core.playPause',
      category: 'playback',
      defaults: {
        default: ['Space', 'KeyK'],
        potplayer: ['Space'],
        mpv: ['Space', 'KeyP']
      },
      run: async () => {
        if (mpv.peek<boolean>('idle-active') === true) return
        await mpv.set('pause', mpv.peek<boolean>('pause') !== true)
      }
    },
    {
      id: 'core.play',
      labelKey: 'core.play',
      category: 'playback',
      internal: true,
      run: () => mpv.set('pause', false)
    },
    {
      id: 'core.pause',
      labelKey: 'core.pause',
      category: 'playback',
      internal: true,
      run: () => mpv.set('pause', true)
    },
    {
      id: 'core.settings',
      labelKey: 'core.settings',
      category: 'app',
      defaults: { default: ['Ctrl+Comma'] },
      run: () => deps.openSettings()
    },
    {
      id: 'core.quit',
      labelKey: 'core.quit',
      category: 'app',
      // No bare-key quit in the RLPlayer preset: losing your place because you
      // brushed Q is the kind of thing that makes people distrust a player. The
      // mpv preset is opt-in, so it honours mpv's habit.
      defaults: { default: ['Ctrl+KeyQ'], potplayer: ['Ctrl+KeyQ'], mpv: ['KeyQ'] },
      run: () => deps.quit()
    },
    {
      id: 'core.showShortcuts',
      labelKey: 'core.showShortcuts',
      category: 'app',
      run: () => {
        getUiWindow()?.webContents.send('ui:command', 'showShortcuts')
      }
    },
    {
      id: 'core.toggleStats',
      labelKey: 'core.toggleStats',
      category: 'app',
      // mpv's own `i` panel, rebuilt as an overlay host so every module can add
      // a row to it through ctx.statsSection() instead of editing main.ts.
      defaults: { default: ['KeyI'], potplayer: ['Ctrl+F1'], mpv: ['KeyI'] },
      run: () => {
        getUiWindow()?.webContents.send('ui:command', 'toggleStats')
      }
    },
    {
      id: 'core.openReleases',
      labelKey: 'core.openReleases',
      category: 'app',
      // A link the user clicks. There is no updater and no background check;
      // the absence is the feature.
      run: () => void shell.openExternal(RELEASES_URL)
    },
    {
      id: 'core.openRepo',
      labelKey: 'core.openRepo',
      category: 'app',
      run: () => void shell.openExternal(RELEASES_URL.replace(/\/releases$/, ''))
    },
    {
      id: 'core.about',
      labelKey: 'core.about',
      category: 'app',
      run: () => {
        const win = getVideoWindow()
        if (!win) return
        void dialog.showMessageBox(win, {
          type: 'info',
          title: t('core.aboutTitle'),
          message: `RLPlayer ${app.getVersion()}`,
          detail: [
            '광고 없음 · 업데이트 알림 없음 · 텔레메트리 없음',
            '',
            `재생 엔진: mpv (${mpv.peek<boolean>('idle-active') === true ? '대기 중' : '재생 중'})`,
            'RLPlayer는 MIT 라이선스로 배포됩니다.',
            'mpv는 GPLv2+ 라이선스이며 별도 프로세스로 실행됩니다.',
            '자세한 내용은 THIRD-PARTY-NOTICES.md를 참고하세요.'
          ].join('\n'),
          buttons: ['확인']
        })
      }
    }
  ])

  deps.menu.contribute('core', {
    id: 'core.playback',
    labelKey: 'core.playbackMenu',
    order: 20,
    items: [{ commandId: 'core.playPause' }]
  })
  deps.menu.contribute('core', {
    id: 'core.app',
    labelKey: 'core.appMenu',
    order: 90,
    items: [
      { commandId: 'core.settings' },
      {
        labelKey: 'core.helpMenu',
        submenu: [
          { commandId: 'core.openReleases' },
          { commandId: 'core.openRepo' },
          { type: 'separator' },
          { commandId: 'core.showShortcuts' },
          { commandId: 'core.about' }
        ]
      },
      { type: 'separator' },
      { commandId: 'core.quit' }
    ]
  })
}
