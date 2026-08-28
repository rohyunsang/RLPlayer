import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppConfig } from '@shared/types'
import {
  DEFAULT_CONFIG,
  configFilePath,
  configReadOnly,
  dataDir,
  flushConfig,
  isPortable,
  loadConfig,
  saveConfig
} from './services/config'
import { resolveMpvPath } from './mpv/manager'
import { setVideoRegion } from './core/window/windows'
import { notifyVideoRegion } from './core/window/index.ts'
import { commandRegistry, resolvedKeybinds, setBinding, setPreset } from './core/input/index.ts'
import { messageCatalog, t } from './core/i18n/index.ts'
import type { SettingsRegistry } from './core/settings/registry.ts'
import type { FileFilter, SettingDescriptor, SettingSection, SettingType } from '@shared/feature-api'
import type { LegacyBridge } from './core/legacy-bridge.ts'
import type { MenuRegistry } from './core/menu.ts'
import type { OsdBus } from './core/osd/index.ts'
import { getUiWindow, getVideoWindow } from './core/window/windows'

/**
 * The CORE ipc surface, and nothing else.
 *
 * The 22-action dispatch table and the `Player` class it drove are gone
 * (§5.10): `player:action` and `player:binding` now forward through
 * `core/legacy-bridge` to command ids, and every feature-owned channel
 * (`playlist:*`, `shell-window:*`, `subs-tracks:*`, `audio-devices:*`) is
 * registered by the module that owns it, through `ctx.ipc`.
 *
 * What is left here is genuinely core: config, the settings window, the app
 * menu, system integration and the keybind table.
 */

let settingsWindow: BrowserWindow | null = null

export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 620,
    height: 700,
    minWidth: 520,
    minHeight: 480,
    title: 'RLPlayer 설정',
    backgroundColor: '#16181d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // THIS window is the one that made the leak real: it is the only page in
      // the app with text inputs, and Wave 0 added them. Chromium's
      // spellchecker then downloads a dictionary from redirector.gvt1.com.
      // NOTE: this flag alone was measured NOT to stop it — the session call in
      // core/no-network.ts is what does. Kept as defence in depth.
      spellcheck: false
    }
  })
  settingsWindow.setMenu(null)
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    void settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'))
  }
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null
}

export function broadcastKeybinds(): void {
  getUiWindow()?.webContents.send('ui:keybinds', resolvedKeybinds())
}

export interface CoreIpcDeps {
  /** §3.5 rule 5: dropped foreign writes, for the stats overlay. */
  refusals(): Array<{ moduleId: string; count: number }>
  legacy: LegacyBridge
  menu: MenuRegistry
  osd: OsdBus
  settings: SettingsRegistry
  pushState(): void
}

/**
 * One row of the generated settings form.
 *
 * Labels are resolved HERE, in main, where the catalogs live — the settings
 * window gets finished strings and never has to know which module contributed
 * which key. `component` carries a `custom` descriptor's renderer component
 * name so the form can look it up in `settingsComponents`.
 */
export interface SettingRow {
  id: string
  section: SettingSection
  group?: string
  label: string
  description?: string
  type: SettingType
  value: unknown
  default: unknown
  mpvOption?: string
  requiresRestart?: boolean
  advanced?: boolean
  order?: number
  keywords?: readonly string[]
}

function toRow(d: SettingDescriptor, value: unknown): SettingRow {
  const row: SettingRow = {
    id: d.id,
    section: d.section,
    label: t(d.labelKey),
    type: d.type,
    value,
    default: d.default
  }
  if (d.group !== undefined) row.group = d.group
  if (d.descriptionKey !== undefined) row.description = t(d.descriptionKey)
  if (d.mpvOption !== undefined) row.mpvOption = d.mpvOption
  if (d.requiresRestart !== undefined) row.requiresRestart = d.requiresRestart
  if (d.advanced !== undefined) row.advanced = d.advanced
  if (d.order !== undefined) row.order = d.order
  if (d.keywords !== undefined) row.keywords = d.keywords
  return row
}

export function registerCoreIpc(deps: CoreIpcDeps): void {
  const invoke = (id: string, arg?: unknown): void => {
    void commandRegistry.invoke(id, arg).catch((e: Error) => {
      console.error(`[ipc] ${id} failed:`, e.message)
    })
  }

  // --- the transitional surface (§5.10) ---
  ipcMain.on('player:action', (_e, action) => void deps.legacy.dispatch(action))
  ipcMain.on('player:binding', (_e, binding: string) => {
    if (typeof binding === 'string') void deps.legacy.run(binding)
  })
  ipcMain.on('player:restart', () => invoke('playlist.restartCurrent'))

  // --- commands, the way the renderer speaks now ---
  ipcMain.on('core-input:invoke', (_e, msg: { id: string; arg?: unknown }) => {
    if (msg && typeof msg.id === 'string') invoke(msg.id, msg.arg)
  })
  ipcMain.handle('core-input:keybinds', () => resolvedKeybinds())
  ipcMain.handle('core-input:commands', () =>
    commandRegistry
      .all()
      .filter((c) => !c.internal)
      .map((c) => ({ id: c.id, labelKey: c.labelKey, category: c.category }))
  )
  ipcMain.handle('core-input:conflicts', () => commandRegistry.conflicts())
  ipcMain.on('core-input:setPreset', (_e, preset) => {
    setPreset(preset)
    broadcastKeybinds()
  })
  ipcMain.on('core-input:setBinding', (_e, msg: { id: string; accels: string[] }) => {
    if (!msg || typeof msg.id !== 'string') return
    setBinding(msg.id, Array.isArray(msg.accels) ? msg.accels : [])
    broadcastKeybinds()
  })

  // --- files ---
  ipcMain.on('file:openDialog', () => invoke('playlist.open'))
  ipcMain.on('file:openPaths', (_e, paths: string[]) => {
    if (Array.isArray(paths)) invoke('playlist.openPaths', paths)
  })

  // --- window plumbing that belongs to the layout, not to a module ---
  ipcMain.on('window:videoRegion', (_e, r: Electron.Rectangle) => {
    if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return
    setVideoRegion(r)
    notifyVideoRegion(r)
  })

  // --- overlay services ---
  ipcMain.on('ui:popupMenu', (_e, { x, y }: { x?: number; y?: number }) => deps.menu.popup(x, y))
  ipcMain.on('ui:toastAction', (_e, id: number) => deps.osd.runToastAction(Number(id)))
  ipcMain.on('ui:progressCancel', (_e, id: string) => deps.osd.cancelProgress(String(id)))

  // --- config ---
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<AppConfig>) => {
    const before = loadConfig()
    const next = saveConfig(patch)
    await applyConfigChanges(before, next)
    return next
  })
  ipcMain.handle('config:reset', async () => {
    const before = loadConfig()
    const next = saveConfig({ ...DEFAULT_CONFIG, window: before.window })
    await applyConfigChanges(before, next)
    return next
  })

  ipcMain.on('settings:open', () => openSettingsWindow())
  ipcMain.on('settings:close', () => settingsWindow?.close())

  // --- the generated settings form (§3.3.2) ---
  //
  // The settings window renders whatever `ctx.settings.define()` registered and
  // knows nothing else. Every row below is a module's descriptor; adding a
  // setting means adding a descriptor in your own directory, and touching
  // neither this file nor `settings.html`.
  ipcMain.handle('core-settings:list', () =>
    deps.settings.snapshot().map(({ descriptor, value }) => toRow(descriptor, value))
  )
  ipcMain.handle('core-settings:set', (_e, msg: { id: string; value: unknown }) => {
    if (!msg || typeof msg.id !== 'string' || !deps.settings.has(msg.id)) return null
    deps.settings.set(msg.id, msg.value)
    return deps.settings.get(msg.id)
  })
  ipcMain.handle('core-settings:reset', () => {
    // P51 again: writing the default REMOVES the stored value, so a reset
    // leaves an empty bag rather than a bag full of today's defaults.
    for (const { descriptor } of deps.settings.snapshot()) {
      deps.settings.set(descriptor.id, descriptor.default)
    }
    return deps.settings.snapshot().map(({ descriptor, value }) => toRow(descriptor, value))
  })
  ipcMain.handle(
    'core-settings:browse',
    async (_e, msg: { mode: 'file' | 'directory'; filters?: FileFilter[] }) => {
      const win = getSettingsWindow() ?? getVideoWindow()
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        properties:
          msg?.mode === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
        filters: msg?.filters ?? []
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    }
  )

  // Ownership refusals, for the stats overlay. Empty in a dev build, because
  // there a foreign write throws instead.
  ipcMain.handle('core-mpv:refusals', () => deps.refusals())

  // The catalog, flattened. Both renderer windows fetch it once at boot so
  // `ctx.t()` is synchronous by the time a module builds its DOM.
  ipcMain.handle('core-i18n:messages', () => messageCatalog())

  // --- system ---
  ipcMain.on('system:openDefaultApps', () => {
    // Windows deliberately blocks apps from claiming default-handler status;
    // the honest path is to send the user to the Settings page. We never write
    // a UserChoice hash, and CI greps for it.
    void shell.openExternal('ms-settings:defaultapps')
  })
  ipcMain.on('system:openConfigFolder', () => void shell.openPath(dataDir()))
  ipcMain.on('system:relaunch', () => {
    flushConfig()
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('system:chooseScreenshotDir', async () => {
    const win = getSettingsWindow() ?? getVideoWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '스크린샷 저장 폴더',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('system:info', () => ({
    version: app.getVersion(),
    portable: isPortable(),
    configPath: configFilePath(),
    readOnly: configReadOnly(),
    mpv: resolveMpvPath()
  }))

  void deps.pushState
}

/** Push settings changes that mpv or the windows must act on immediately. */
async function applyConfigChanges(before: AppConfig, next: AppConfig): Promise<void> {
  const run = async (id: string, arg?: unknown): Promise<void> => {
    if (commandRegistry.has(id)) await commandRegistry.invoke(id, arg).catch(() => undefined)
  }
  if (next.subScale !== before.subScale) await run('subs-style.setScale', next.subScale)
  if (next.subAssOverride !== before.subAssOverride) {
    await run('subs-style.setAssOverride', next.subAssOverride)
  }
  if (next.audioDevice !== before.audioDevice) await run('audio-devices.select', next.audioDevice)
  if (next.hwdec !== before.hwdec) await run('video-decode.setHwdec', next.hwdec)
  if (next.vo !== before.vo) await run('video-decode.setVo', next.vo)
  if (next.keybindPreset !== before.keybindPreset) broadcastKeybinds()
}
