// core/paths MUST be first: Electron caches `userData` the moment anything asks
// for it, and Chromium picks its disk-cache directory during startup. Redirect
// either one late and a "portable" build has already written to %APPDATA%.
import { initPaths, filePath, portableFallback } from './core/paths.ts'
initPaths()

// Second, and for the same reason: Chromium reads its command line during
// startup, so every background-networking switch has to be appended before
// anything touches `app.whenReady()`. See core/no-network.ts for why an
// absence we do not switch off is an absence we are only guessing about.
import {
  applySessionPolicy,
  describeNoNetwork,
  disableBackgroundNetworking
} from './core/no-network.ts'
const networkPolicy = disableBackgroundNetworking()

import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Menu } from 'electron'
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
import { createMpvBus } from './core/mpv/bus.ts'
import { disposeEngines } from './core/mpv/engine.ts'
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
// One line in the log, every launch, naming what was switched off. A promise
// nobody can see the enforcement of is a promise nobody can check.
console.log(
  `[no-network] ${networkPolicy.switches.length} switches, ` +
    `${networkPolicy.features.length} features disabled, spellchecker off, proxy direct, ` +
    `${networkPolicy.allowedHosts.length} host(s) allowlisted`
)
if (process.argv.includes('--print-network-policy')) {
  console.log(describeNoNetwork())
  app.exit(0)
}
// The custom titlebar in the overlay replaces it; a native menu bar would sit
// behind mpv's child HWND anyway.
Menu.setApplicationMenu(null)

/**
 * THE mpv bus, created here and nowhere else.
 *
 * `createMpvBus()` throws on a second call, so a feature module that reaches
 * for `await import('./core/mpv/bus.ts')` finds a factory that refuses rather
 * than a singleton it can mint privileged services from. Everything a module
 * touches arrives on `FeatureContext`; see docs/parity/02-wave0-api.md.
 */
const mpvBus = createMpvBus()

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
  // The per-session half of the policy, and it must be the first thing after
  // ready: the spellchecker picks its dictionary when the first window with a
  // text input loads, and `webRequest.onBeforeRequest` has to be installed
  // before anything can issue a request under it.
  applySessionPolicy()

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
    // Core owns `pause` and the rest of the transport (§3.7), so this is one of
    // the three ids allowed a privileged service.
    mpv: mpvBus.createService('core/mpv/bus', { privileged: true }),
    commands: commandRegistry,
    menu,
    osd,
    openSettings: openSettingsWindow,
    quit: () => app.quit()
  })

  registry = new Registry({
    mpv: mpvBus,
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
  registerCoreIpc({ legacy, menu, osd, settings, pushState, refusals: () => mpvBus.refusals() })

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
  await registry.loadAll(await collectFeatureModules())

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

  /**
   * PROOF OF LIFE, on stdout, once, at the point the app is genuinely up.
   *
   * `scripts/check-network.mjs` asserts on the ABSENCE of network events, and a
   * netlog with zero events is the PASSING shape -- so a launch that died before
   * it opened a window sailed through as a clean run. Its only liveness gate was
   * `/\[no-network\]/`, which `console.log` prints at MODULE SCOPE, before
   * `app.whenReady()`, before any window exists and before a single line of this
   * function has run. It proved that the process started, which was never the
   * question. Seven of 36 observed netlogs were header-only and two of those
   * exited cleanly, including the decisive `--no-blackhole` step.
   *
   * This line runs after the windows are shown and the modules are loaded, so a
   * harness that requires it is requiring a session that actually happened.
   */
  console.log(
    `[ready] windows shown, ${registry.modules().filter((m) => m.ok).length}/` +
      `${registry.modules().length} modules loaded, engine ${mpvBus.playerState.idle ? 'idle' : 'playing'}`
  )

  /**
   * The settings window, opened on demand by a harness.
   *
   * It is the app's ONLY page with text inputs, which is the exact surface the
   * gvt1.com spellchecker leak lived on -- and `check-network.mjs` only ever
   * opened a sample video, so the one page that caused the 0.1.0 defect was
   * never exercised by the check written to prevent it. An env var rather than a
   * command-line flag, and named for what it is, so it cannot be reached by a
   * user and shows up in a support log if it ever is. Same shape as the DNS
   * blackhole override in core/no-network.ts, and for the same reason.
   */
  if (process.env['RLPLAYER_E2E_OPEN_SETTINGS'] === '1') {
    openSettingsWindow()
    console.log('[e2e] settings window opened')
  }

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

/**
 * The quit path, and why it takes control of `before-quit` rather than doing its
 * work inside it.
 *
 * MEASURED FAILURE 1: closing the player with the SETTINGS window open never
 * quit — 0 s to exit without it, still running after 16 s with it, 2 out of 2.
 * `window-all-closed` fires only when EVERY window is gone, and the settings
 * window is a top-level BrowserWindow nobody closed. `closeAuxiliaryWindows()`
 * below is the fix; the player is the app, so closing it closes them.
 *
 * MEASURED FAILURE 2: the old handler was synchronous and its only hard kill
 * was `setTimeout(() => proc.kill(), 300)` in `MpvManager.dispose()`, inside
 * this very event. Electron tears the loop down first, so that timer almost
 * never fired and the IPC `quit` was the only thing killing mpv — 2 silent
 * exits orphaned mpv and 1 orphan survived a graceful quit in ~50 launches.
 *
 * So: preventDefault once, run the shutdown to completion, then `app.exit()`.
 * A watchdog guarantees the process leaves even if a hook hangs, and mpv's own
 * `process.on('exit')` reaper runs on the way out either way.
 */
const QUIT_WATCHDOG_MS = 6000

app.on('before-quit', (event) => {
  // A second `before-quit` while the first shutdown is still running must NOT
  // fall through to Electron's default quit: that is how a half-finished
  // shutdown ends the process before mpv has been reaped. Only the `finally`
  // below, or the watchdog, ever ends this process.
  if (disposed) {
    event.preventDefault()
    return
  }
  disposed = true
  event.preventDefault()

  // Unskippable. If a quit hook hangs, the app still leaves — and mpv's
  // synchronous exit hook still reaps the child on the way out.
  const watchdog = setTimeout(() => {
    console.error('[quit] shutdown did not finish in time; exiting anyway')
    app.exit(0)
  }, QUIT_WATCHDOG_MS)
  watchdog.unref?.()

  const quitStart = Date.now()
  void shutdown()
    .catch((e: Error) => console.error('[quit] shutdown threw:', e.stack ?? e.message))
    .finally(() => {
      clearTimeout(watchdog)
      // The other half of the proof. A harness that force-kills the app writes
      // no netlog events at all and no quit line, so "0 events" and "clean quit"
      // stop being the same sentence: this one is only printed by the path that
      // actually ran the shutdown hooks and reaped mpv.
      console.log(`[quit] clean exit in ${Date.now() - quitStart} ms`)
      app.exit(0)
    })
})

async function shutdown(): Promise<void> {
  persistBounds()
  closeAuxiliaryWindows()
  // Flush the resume position before mpv goes away, or the last few seconds of
  // playback are lost on every exit.
  await registry?.dispose()
  perFile?.flush()
  flushConfig()
  flushKeybinds()
  // Secondary mpv processes (thumbnails, probes, encodes) BEFORE the playing
  // one: they are children of this process too, and "no orphan mpv on quit" has
  // to mean all of them, not just the one with a window on it. A module never
  // has to be trusted to close its own -- see core/mpv/engine.ts.
  const engines = await disposeEngines()
  if (engines.orphaned > 0) {
    console.error(`[quit] ${engines.orphaned} secondary mpv process(es) could not be killed`)
  }
  const { orphaned } = await mpvBus.shutdown()
  if (orphaned) console.error('[quit] mpv could not be killed; see the log above')
}

/**
 * Every window that is not the player. The settings window is created on demand
 * by `openSettingsWindow()` and outlives the player's own close, which is the
 * whole of measured failure 1 above.
 */
function closeAuxiliaryWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (win === getVideoWindow() || win === getUiWindow()) continue
    try {
      win.destroy()
    } catch {
      /* already going away */
    }
  }
}
