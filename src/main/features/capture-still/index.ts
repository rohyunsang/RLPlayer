import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, clipboard, ClipboardItem, shell } from 'electron'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'

/**
 * M22 capture-still — screenshots. WAVE 0 SEED: the new owner of `screenshot`
 * and `screenshotClipboard`.
 *
 * BM-3: `screenshot-directory` is written at setup(), unconditionally, BEFORE
 * any screenshot can be taken. With it unset, the `screenshot` command replies
 * with a BARE RELATIVE FILENAME resolved against mpv's cwd, and every consumer
 * of that reply (the toast, `shell.showItemInFolder`) breaks on first run.
 *
 * §7.7 trap 5c: `screenshot` with `scaled` or `window` fails outright when
 * there is no window-backed VO — audio-only playback with the video window
 * hidden and tray-only mode are both shipped states. `video` succeeds in both,
 * so that is what the fallback uses.
 */

let ctx: FeatureContext

function targetDir(): string {
  const chosen = ctx.settings.get<string>('capture-still.directory')
  if (chosen) return chosen
  // D-10: portable mode keeps captures beside the exe, matching the
  // leave-no-trace promise (and PotPlayer's own habit).
  if (ctx.paths.isPortable()) return path.join(path.dirname(app.getPath('exe')), 'Capture')
  return path.join(app.getPath('pictures'), 'RLPlayer')
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'screenshot'
}

function stem(): string {
  const p = ctx.mpv.peek<string>('path')
  return p ? path.basename(p, path.extname(p)) : 'screenshot'
}

async function saveToFile(): Promise<void> {
  if (ctx.mpv.peek<boolean>('idle-active') === true) return
  const dir = targetDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const out = path.join(dir, `${sanitize(stem())}_${stamp}.png`)
    await ctx.mpv.command(['screenshot-to-file', out, 'subtitles'])
    ctx.osd.toast({
      kind: 'info',
      message: `저장됨: ${path.basename(out)}`,
      actionLabel: '폴더 열기',
      onAction: () => shell.showItemInFolder(out)
    })
  } catch (e) {
    ctx.osd.toast({ kind: 'error', message: `스크린샷 실패: ${(e as Error).message}` })
  }
}

async function saveToClipboard(): Promise<void> {
  if (ctx.mpv.peek<boolean>('idle-active') === true) return
  const tmp = path.join(os.tmpdir(), `rlplayer-shot-${Date.now()}.png`)
  try {
    // mpv has no clipboard output, so render to a temp PNG and hand the bytes
    // to Electron's clipboard.
    await ctx.mpv.command(['screenshot-to-file', tmp, 'subtitles'])
    const png = await fs.promises.readFile(tmp)
    if (png.length === 0) throw new Error('empty image')
    const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    ctx.osd.toast({ kind: 'info', message: '스크린샷을 클립보드에 복사했습니다' })
  } catch (e) {
    ctx.osd.toast({ kind: 'error', message: `스크린샷 실패: ${(e as Error).message}` })
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
}

const mod: FeatureModule = {
  id: 'capture-still',
  ownsProperties: ['screenshot-*'],
  // `screenshot` returns a BARE RELATIVE FILENAME unless screenshot-directory
  // is set first, and fails outright with `scaled`/`window` when there is no
  // window-backed VO (§7.7 traps 3 and 4). Both are M22's problem to get right
  // once, not everyone's to rediscover.
  ownsCommands: ['screenshot', 'screenshot-to-file'],

  setup(c): void {
    ctx = c

    // C05. Hardcoded as `#screenshotDir` plus a bespoke "browse" button in the
    // shared settings.html before this; `{ kind: 'path' }` renders both.
    ctx.settings.define([
      {
        id: 'capture-still.directory',
        section: 'general',
        labelKey: 'capture-still.directoryLabel',
        descriptionKey: 'capture-still.directoryDesc',
        type: { kind: 'path', mode: 'directory' },
        default: '',
        mpvOption: 'screenshot-directory',
        keywords: ['스크린샷', '캡처', 'screenshot', 'capture', 'folder'],
        order: 30
      }
    ])
    const legacyDir = loadConfig().screenshotDir
    if (legacyDir) ctx.settings.set('capture-still.directory', legacyDir)
    ctx.settings.onChange<string>('capture-still.directory', (v) => {
      saveConfig({ screenshotDir: v })
      void ctx.mpv.set('screenshot-directory', targetDir()).catch(() => undefined)
    })

    ctx.mpv.contributeArgs(10, () => [
      '--screenshot-format=png',
      '--screenshot-png-compression=3',
      // C06: the default produces 5 MB 16-bit PNGs from 8-bit sources.
      '--screenshot-high-bit-depth=no'
    ])

    ctx.mpv.afterFileLoaded(() => {
      // BM-3's precondition, re-applied after every respawn.
      void ctx.mpv.set('screenshot-directory', targetDir()).catch(() => undefined)
    })

    ctx.commands.register([
      {
        id: 'capture-still.save',
        labelKey: 'capture-still.save',
        category: 'capture',
        defaults: { default: ['KeyS'], potplayer: ['KeyS'], mpv: ['KeyS'] },
        enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
        run: saveToFile
      },
      {
        id: 'capture-still.toClipboard',
        labelKey: 'capture-still.toClipboard',
        category: 'capture',
        defaults: { default: ['Ctrl+KeyS'], potplayer: ['Ctrl+KeyC'], mpv: ['Ctrl+KeyS'] },
        enabledWhen: () => ctx.mpv.peek<boolean>('idle-active') !== true,
        run: saveToClipboard
      }
    ])

    ctx.menu.contribute({
      id: 'capture-still.menu',
      labelKey: 'capture-still.menuTitle',
      order: 60,
      items: [{ commandId: 'capture-still.save' }, { commandId: 'capture-still.toClipboard' }]
    })

    ctx.i18n.register('ko', {
      'capture-still.directoryLabel': '스크린샷 저장 폴더',
      'capture-still.directoryDesc': '비워 두면 사진\RLPlayer (휴대용 모드에서는 exe 옆의 Capture) 를 씁니다.',
      'capture-still.save': '스크린샷 저장',
      'capture-still.toClipboard': '스크린샷 클립보드 복사',
      'capture-still.menuTitle': '캡처'
    })
    ctx.i18n.register('en', {
      'capture-still.directoryLabel': 'Screenshot folder',
      'capture-still.directoryDesc':
        'Leave empty for Pictures\RLPlayer (or Capture beside the exe in portable mode).',
      'capture-still.save': 'Save screenshot',
      'capture-still.toClipboard': 'Copy screenshot to clipboard',
      'capture-still.menuTitle': 'Capture'
    })
  }
}

export default mod
