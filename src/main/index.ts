// core/paths MUST be first: Electron caches `userData` the moment anything asks
// for it, and Chromium picks its disk-cache directory during startup. Redirect
// either one late and a "portable" build has already written to %APPDATA%.
import { initPaths, filePath, portableFallback } from './core/paths.ts'
initPaths()

import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, Menu } from 'electron'
import {
  createWindows,
  getHwnd,
  getMpvHostWindow,
  getUiWindow,
  getVideoWindow,
  persistBounds,
  showWindows
} from './core/window/windows'
import { initWindowService, setPlaying } from './core/window/index.ts'
import {
  broadcastKeybinds,
  getSettingsWindow,
  openSettingsWindow,
  registerCoreIpc
} from './ipc'
import { flushConfig, loadConfig, onConfigProblem, settingsBacking } from './services/config'
import { createStore } from './core/settings/store.ts'
import { registerCoreMessages, resolveLanguage, setLanguage, t } from './core/i18n/index.ts'
import { mpvBus } from './core/mpv/bus.ts'
import { FeatureIpc } from './core/ipc.ts'
import { MenuRegistry } from './core/menu.ts'
import { OsdBus } from './core/osd/index.ts'
import { Registry } from './core/registry.ts'
import { SettingsRegistry } from './core/settings/registry.ts'
import {
  PerFileManager,
  type HistoryFile,
  type OptsFile,
  type ResumeFile
} from './core/state/per-file.ts'
import { commandRegistry, flushKeybinds } from './core/input/index.ts'
import { LegacyBridge, setLegacyVolumeReader } from './core/legacy-bridge.ts'
import { registerCoreCommands } from './core/transport.ts'
import { collectFeatureModules } from './features/index'
import type { BrowserWindow } from 'electron'
import type { OsdKind } from '@shared/feature-api'

/**
 * RLPlayer main process.
 *
 * Two things this file deliberately does NOT do:
 *   - no auto-updater, and no network request of any kind at startup
 *   - no telemetry
 * Those absences are the whole reason this app exists; see README.
 *
 * WAVE 0: this file wires the core services together and then hands over. It
 * knows about no feature: modules are discovered from the directory listing,
 * and everything they need arrives on `FeatureContext`.
 */

app.setAppUserModelId('com.rohyunsang.rlplayer')
// The custom titlebar in the overlay replaces it; a native menu bar would sit
// behind mpv's child HWND anyway.
Menu.setApplicationMenu(null)

let registry: Registry | null = null
let perFile: PerFileManager | null = null
let disposed = false

/**
 * Pull openable paths out of an argv. U34: a DIRECTORY is a perfectly ordinary
 * thing to open, and v0.1 discarded it because it only accepted files.
 */
function filesFromArgv(argv: string[]): string[] {
  const appPath = path.resolve(app.getAppPath())
  return argv.slice(1).filter((a) => {
    if (typeof a !== 'string' || a.startsWith('-')) return false
    const resolved = path.resolve(a)
    // `electron . movie.mkv` in dev puts the app directory in argv; opening the
    // repository as a playlist is not what anyone meant.
    if (resolved === appPath) return false
    try {
      const st = fs.statSync(resolved)
      return st.isFile() || st.isDirectory()
    } catch {
      return false
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv)
    if (files.length > 0) void commandRegistry.invoke('playlist.openPaths', files)
    const video = getVideoWindow()
    if (video?.isMinimized()) video.restore()
    video?.show()
    getUiWindow()?.focus()
  })

  app.whenReady().then(main).catch((e: Error) => {
    // stderr FIRST. `showErrorBox` is modal and blocks the main process
    // outright, so a boot failure with only a dialog behind it looks exactly
    // like a hang — the window is up, the CDP endpoint stops answering, and
    // there is nothing in any log to say why.
    console.error('[boot] RLPlayer failed to start:', e.stack ?? e.message)
    dialog.showErrorBox(t('core.startFailed'), e.stack ?? e.message)
    app.quit()
  })
}

/**
 * Where `ctx.ipc.send(channel, payload, target)` actually goes.
 *
 * The `'settings'` arm used to be missing, so every push a module aimed at the
 * settings window was silently dropped — `getSettingsWindow()` existed and
 * nothing called it. The only way for a module to reach that window was to edit
 * this file or `ipc.ts`, which is precisely what `ctx.ipc` exists to prevent.
 * The settings window is created on demand, so `null` here is a normal state
 * and not an error: a push with the window closed is a no-op.
 */
function windowsFor(target: 'ui' | 'settings' | 'all'): BrowserWindow[] {
  const out: BrowserWindow[] = []
  const ui = getUiWindow()
  if (ui && (target === 'ui' || target === 'all')) out.push(ui)
  const settings = getSettingsWindow()
  if (settings && (target === 'settings' || target === 'all')) out.push(settings)
  return out
}

function pushState(): void {
  const ui = getUiWindow()
  if (!ui) return
  const video = getVideoWindow()
  const s = mpvBus.playerState
  s.fullscreen = video?.isFullScreen() ?? false
  s.maximized = video?.isMaximized() ?? false
  s.alwaysOnTop = video?.isAlwaysOnTop() ?? false
  s.layoutMode = mpvBus.playerState.layoutMode
  ui.webContents.send('player:state', s)
  setPlaying(!s.paused && !s.idle)
}

function toast(message: string, kind: 'info' | 'error'): void {
  getUiWindow()?.webContents.send('ui:toast', { id: 0, kind, message })
}

async function main(): Promise<void> {
  registerCoreMessages()
  setLanguage(resolveLanguage(app.getLocale()))

  const cfg = loadConfig()
  onConfigProblem((kind) => {
    if (kind === 'corrupt') toast(t('core.configRecovered'), 'error')
    if (kind === 'readonly') toast(t('core.configReadOnly'), 'error')
  })

  createWindows()
  initWindowService()

  // --- core services ---
  const settings = new SettingsRegistry(settingsBacking)
  const featureIpc = new FeatureIpc(windowsFor)
  const osd = new OsdBus(
    (channel, payload) => getUiWindow()?.webContents.send(channel, payload),
    (kind: OsdKind) => loadConfig().osd[kind] !== false
  )
  const menu = new MenuRegistry(commandRegistry)

  perFile = new PerFileManager({
    resume: createStore<ResumeFile>({
      id: 'resume',
      file: filePath('resume.json'),
      version: 1,
      // v0.1 wrote a bare map of hash → entry with no `schema` field, so the
      // 0 → 1 migration has to actually run rather than the whole file being
      // swept into __extra.
      legacyVersion: 0,
      defaults: { entries: {} },
      migrations: [
        {
          from: 0,
          to: 1,
          up: (data) => {
            const entries: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(data)) {
              if (k === 'schema' || k === 'entries') continue
              entries[k] = v
            }
            return { entries: { ...(data.entries as object), ...entries } }
          }
        }
      ]
    }),
    history: createStore<HistoryFile>({
      id: 'history',
      file: filePath('history.json'),
      version: 1,
      defaults: { entries: {} }
    }),
    opts: createStore<OptsFile>({
      id: 'per-file',
      file: filePath('per-file.json'),
      version: 1,
      defaults: { entries: {} }
    })
  })

  const legacy = new LegacyBridge(commandRegistry, osd)
  setLegacyVolumeReader(() => mpvBus.playerState.volume)

  registerCoreCommands({
    commands: commandRegistry,
    menu,
    osd,
    openSettings: openSettingsWindow,
    quit: () => app.quit()
  })

  registry = new Registry({
    settings,
    commands: commandRegistry,
    ipc: featureIpc,
    osd,
    perFile,
    menu,
    toast
  })

  /**
   * The core IPC handlers go up BEFORE the modules load, and long before
   * `showWindows`.
   *
   * `createWindows()` has already told both renderers to load their URL, so the
   * overlay can reach `core-i18n:messages` within a few hundred milliseconds.
   * Registering these at the end of boot -- after `mpvBus.start()`, which waits
   * on a child process and a named pipe -- lost that race every time, and the
   * only symptom was labels rendering as their message keys. Nothing about
   * these handlers needs mpv to be running.
   */
  registerCoreIpc({ legacy, menu, osd, settings, pushState })

  // --- the mpv bus: core args, then every module's contributions ---
  mpvBus.attachHost({
    hwnd: () => {
      const host = getMpvHostWindow()
      if (!host) throw new Error('mpv host window missing')
      return getHwnd(host)
    },
    baseArgs: coreSpawnArgs,
    toast
  })

  // Modules are discovered from the directory listing; adding a feature is
  // adding a directory. Nothing here names one.
  await registry.loadAll(collectFeatureModules())

  mpvBus.onManager('state', pushState)
  mpvBus.onManager('crashed', (code: number, detail: string) => {
    toast(`재생 엔진이 종료되었습니다 (code ${code}). ${detail.split('\n')[0] ?? ''}`.trim(), 'error')
  })
  mpvBus.afterFileLoaded((file) => perFile?.onFileLoaded(file))

  try {
    await mpvBus.start()
  } catch (e) {
    dialog.showErrorBox(t('core.engineFailed'), `${(e as Error).message}\n\n${t('core.engineHint')}`)
    app.quit()
    return
  }

  /**
   * §3.5 rule 5 keeps its leniency: in a SHIPPED build a foreign property write
   * is dropped and counted rather than thrown, because one misbehaving module
   * must not black-screen the player. What changes is that the refusal is no
   * longer invisible. `refusalCount` was never read anywhere in src/, so the
   * "surfaced in stats" comment on the owner map was simply false and a
   * corrupted-state bug looked exactly like a working build.
   *
   * The first refusal now shows a toast the user can quote in a bug report, and
   * every refusal reaches the stats overlay through `core-mpv:refusals`.
   */
  mpvBus.onFirstRefusal((moduleId) => {
    toast(t('core.ownershipRefused', { id: moduleId }), 'error')
  })

  showWindows(cfg.window.maximized)
  registry.fireReady()
  broadcastKeybinds()
  pushState()

  if (portableFallback()) toast(t('core.portableFallback'), 'error')

  const files = filesFromArgv(process.argv)
  if (files.length > 0) {
    // Isolated deliberately. In dev an ownership violation THROWS, and until
    // this catch existed one bad write on the open path escaped all the way to
    // main()'s handler, where `showErrorBox` blocks the main process — so the
    // symptom was a window that came up, painted once, and then answered
    // nothing at all, with no log line anywhere. Opening a file is not part of
    // starting the app.
    await commandRegistry.invoke('playlist.openPaths', files).catch((e: Error) => {
      console.error('[boot] opening the command-line files failed:', e.stack ?? e.message)
      toast(e.message, 'error')
    })
  }
}

/**
 * Core's spawn args, priority 0. Everything else is a module's
 * `contributeArgs()`, and duplicates across any two contributors throw at boot.
 */
function coreSpawnArgs(): string[] {
  const cfg = loadConfig()
  const args: string[] = []

  // P06: the user's own mpv.conf, FIRST, so core's args win. Later args
  // override earlier ones in mpv, which is exactly the precedence we want.
  const userConf = filePath('mpv.conf')
  if (fs.existsSync(userConf)) args.push(`--include=${userConf}`)

  args.push(
    // Never read the user's global mpv config: RLPlayer must behave predictably.
    '--no-config',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    // mpv must not fight the overlay for input; the UI window owns all of it.
    '--input-default-bindings=no',
    '--input-vo-keyboard=no',
    '--input-cursor=no',
    // U24: Electron owns the media keys.
    '--input-media-keys=no',
    '--osc=no',
    '--no-osd-bar',
    '--osd-level=0',
    '--terminal=yes',
    '--msg-level=all=error',
    '--load-scripts=no',
    // Zero network at rest: the yt-dlp hook never runs. R05 will flip the
    // exclude list at runtime rather than needing a restart.
    '--ytdl=no',
    // L09/U32: mpv's default `auto` registers its OWN OLE drop target on the
    // child HWND and replaces its own playlist behind our back.
    '--drag-and-drop=no',
    // U11/U27: inert under --wid on paper, harmless, and belt-and-braces for
    // the cursor and the taskbar if a future mpv changes its mind.
    '--cursor-autohide=no',
    '--taskbar-progress=no',
    // gpu-next + d3d11 is both the most efficient path for a --wid child window
    // and the only one that can do HDR passthrough. `--vo=gpu` is the
    // documented fallback for old hardware; see docs/03-architecture.md.
    `--vo=${cfg.vo || 'gpu-next'}`,
    '--gpu-context=d3d11'
  )
  return args
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (disposed) return
  disposed = true
  persistBounds()
  // Flush the resume position before mpv goes away, or the last few seconds of
  // playback are lost on every exit.
  void registry?.dispose()
  perFile?.flush()
  flushConfig()
  flushKeybinds()
  mpvBus.dispose()
})
