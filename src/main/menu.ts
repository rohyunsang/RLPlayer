import { app, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { Player } from './player'
import { loadConfig, saveConfig } from './services/config'
import { getVideoWindow, getUiWindow } from './windows'
import { openFileDialog, openSettingsWindow, RELEASES_URL, runBinding } from './ipc'

const ASPECTS: [string, string][] = [
  ['자동', '-1'],
  ['16:9', '1.7777'],
  ['4:3', '1.3333'],
  ['1:1', '1.0'],
  ['16:10', '1.6'],
  ['2.35:1', '2.35']
]

/**
 * Built fresh on every popup so track lists and toggles reflect current state.
 * A native menu is used rather than an HTML one because it renders above mpv's
 * child HWND without any of the overlay's z-order caveats.
 */
export function popupMainMenu(player: Player, x?: number, y?: number): void {
  const win = getVideoWindow()
  if (!win) return
  const s = player.mpv.state
  const cfg = loadConfig()

  const audioTracks = s.tracks.filter((t) => t.type === 'audio')
  const subTracks = s.tracks.filter((t) => t.type === 'sub')

  const trackItems = (
    kind: 'aid' | 'sid',
    tracks: typeof s.tracks,
    current: number | false,
    allowOff: boolean
  ): MenuItemConstructorOptions[] => {
    const items: MenuItemConstructorOptions[] = tracks.map((t) => ({
      label: trackLabel(t),
      type: 'radio',
      checked: current === t.id,
      click: () => void player.dispatch({ type: 'setTrack', kind, id: t.id })
    }))
    if (allowOff) {
      items.push({ type: 'separator' })
      items.push({
        label: '사용 안 함',
        type: 'radio',
        checked: current === false,
        click: () => void player.dispatch({ type: 'setTrack', kind, id: false })
      })
    }
    if (items.length === 0) items.push({ label: '(트랙 없음)', enabled: false })
    return items
  }

  const template: MenuItemConstructorOptions[] = [
    { label: '열기...', accelerator: 'Ctrl+O', click: () => void openFileDialog(player) },
    { label: '자막 파일 열기...', click: () => void player.dispatch({ type: 'loadSubtitle' }) },
    { type: 'separator' },
    {
      label: s.paused ? '재생' : '일시정지',
      enabled: !s.idle,
      click: () => void player.dispatch({ type: 'playPause' })
    },
    { label: '정지', enabled: !s.idle, click: () => void player.dispatch({ type: 'stop' }) },
    { type: 'separator' },
    {
      label: '재생목록',
      type: 'checkbox',
      checked: cfg.playlistPanelOpen,
      click: () => {
        saveConfig({ playlistPanelOpen: !cfg.playlistPanelOpen })
        player.pushPlaylist()
      }
    },
    {
      label: '반복',
      submenu: (['off', 'one', 'all'] as const).map((m) => ({
        label: { off: '반복 없음', one: '한 파일 반복', all: '전체 반복' }[m],
        type: 'radio' as const,
        checked: cfg.repeat === m,
        click: () => player.setRepeat(m)
      }))
    },
    {
      label: '무작위 재생',
      type: 'checkbox',
      checked: cfg.shuffle,
      click: () => player.setShuffle(!cfg.shuffle)
    },
    { type: 'separator' },
    { label: '오디오 트랙', submenu: trackItems('aid', audioTracks, s.aid, false) },
    { label: '자막 트랙', submenu: trackItems('sid', subTracks, s.sid, true) },
    {
      label: '화면 비율',
      submenu: ASPECTS.map(([label, value]) => ({
        label,
        type: 'radio' as const,
        checked: s.aspect === value || (value === '-1' && Number(s.aspect) <= 0),
        click: () => void player.dispatch({ type: 'setAspect', value })
      }))
    },
    {
      label: '회전',
      submenu: [0, 90, 180, 270].map((deg) => ({
        label: `${deg}°`,
        type: 'radio' as const,
        checked: s.rotate === deg,
        click: () => void player.dispatch({ type: 'rotate', value: deg })
      }))
    },
    { type: 'separator' },
    {
      label: '스크린샷 저장',
      accelerator: 'S',
      enabled: !s.idle,
      click: () => void player.dispatch({ type: 'screenshot', target: 'file' })
    },
    {
      label: '스크린샷 클립보드 복사',
      accelerator: 'Ctrl+S',
      enabled: !s.idle,
      click: () => void player.dispatch({ type: 'screenshot', target: 'clipboard' })
    },
    { type: 'separator' },
    {
      label: '항상 위에 표시',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: () => player.toggleAlwaysOnTop()
    },
    {
      label: '전체화면',
      type: 'checkbox',
      checked: win.isFullScreen(),
      click: () => player.toggleFullscreen()
    },
    { type: 'separator' },
    { label: '설정...', accelerator: 'Ctrl+,', click: () => openSettingsWindow() },
    {
      label: '도움말',
      submenu: [
        // No auto-update anywhere in this app: checking is a link the user
        // clicks, never a background network call.
        { label: '업데이트 확인', click: () => void shell.openExternal(RELEASES_URL) },
        { label: 'GitHub 저장소', click: () => void shell.openExternal(RELEASES_URL.replace(/\/releases$/, '')) },
        { type: 'separator' },
        { label: '단축키 목록', click: () => getUiWindow()?.webContents.send('ui:command', 'showShortcuts') },
        { label: 'RLPlayer 정보', click: () => showAbout(player) }
      ]
    },
    { type: 'separator' },
    { label: '종료', accelerator: 'Ctrl+Q', click: () => void runBinding(player, 'quit') }
  ]

  const menu = Menu.buildFromTemplate(template)
  menu.popup({ window: win, ...(x !== undefined && y !== undefined ? { x, y } : {}) })
}

function trackLabel(t: { id: number; title?: string; lang?: string; external?: boolean }): string {
  const bits = [`${t.id}`]
  if (t.lang) bits.push(t.lang)
  if (t.title) bits.push(t.title)
  if (t.external) bits.push('(외부)')
  return bits.join(' · ')
}

function showAbout(player: Player): void {
  const win = getVideoWindow()
  if (!win) return
  void dialog.showMessageBox(win, {
    type: 'info',
    title: 'RLPlayer 정보',
    message: `RLPlayer ${app.getVersion()}`,
    detail: [
      '광고 없음 · 업데이트 알림 없음 · 텔레메트리 없음',
      '',
      `재생 엔진: mpv (${player.mpv.state.idle ? '대기 중' : '재생 중'})`,
      'RLPlayer는 MIT 라이선스로 배포됩니다.',
      'mpv는 GPLv2+ 라이선스이며 별도 프로세스로 실행됩니다.',
      '자세한 내용은 THIRD-PARTY-NOTICES.md를 참고하세요.'
    ].join('\n'),
    buttons: ['확인']
  })
}
