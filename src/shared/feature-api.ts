/**
 * The plugin API. Every interface a feature module is allowed to see lives here.
 *
 * WAVE 0 — FROZEN. Feature modules import from this file and never edit it.
 * See docs/parity/02-wave0-api.md for the module author's guide.
 *
 * This file is compiled under BOTH tsconfigs (node and web), and the web config
 * has `types: []`, so nothing here may reference the `Electron` global
 * namespace. Geometry and file-filter shapes are declared locally instead; they
 * are structurally identical to Electron's and pass straight through.
 */

export type FeatureId = string // kebab-case, globally unique, e.g. 'video-color'
export type CommandId = string // `${FeatureId}.${verb}`
export type SettingId = string // `${FeatureId}.${key}`
export type IpcChannel = string // `${FeatureId}:${verb}`
export type PanelId = string
/** Physical-key accelerator: 'Ctrl+Shift+KeyS', 'WHEEL_UP', 'MBTN_LEFT_DBL'. */
export type Accel = string

export type Unsubscribe = () => void

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

// ---------------------------------------------------------------------------
// §3.2 The module interface
// ---------------------------------------------------------------------------

export interface FeatureModule {
  /** Must equal the directory name. Enforced at load time. */
  readonly id: FeatureId
  /** Other feature modules that must be set up first. Cycles throw at boot. */
  readonly dependsOn?: readonly FeatureId[]

  /**
   * Every mpv property this module is allowed to WRITE. Exact names, or a
   * single trailing '*' glob, which must still not overlap another claim.
   * The registry folds these into one Map<property, FeatureId> at boot and
   * throws — naming both modules and the property — on any collision.
   * Reads are unrestricted: ownership is about writes only.
   */
  readonly ownsProperties?: readonly string[]

  /**
   * mpv COMMANDS only this module may issue. Same syntax, same duplicate
   * detection and same runtime guard as `ownsProperties`.
   *
   * This exists because `sub-reload` was declared in M17's `ownsProperties`,
   * where it did precisely nothing: it is not a property (mpv answers
   * "property not found"), it is a command, and nothing stopped M18 or M19
   * from calling `ctx.mpv.command(['sub-reload'])` straight past the owner map.
   * A command that reloads another module's tracks needs an owner exactly as
   * much as the property behind it does.
   */
  readonly ownsCommands?: readonly string[]

  /** Properties this module may touch only via `ctx.mpv.requestSet()`. */
  readonly requestsProperties?: readonly string[]

  /** Reserved vf/af labels (§5.5). Same duplicate detection as properties. */
  readonly ownsFilterLabels?: readonly string[]

  /** Grants `ctx.vf` / `ctx.af`. Without these the fields are undefined. */
  readonly usesVideoFilters?: boolean
  readonly usesAudioFilters?: boolean

  /** Called once, in dependency order, before the first window is shown. */
  setup(ctx: FeatureContext): void | Promise<void>
  /** Called on quit. Release timers, watchers, processes. */
  dispose?(): void | Promise<void>
}

// ---------------------------------------------------------------------------
// §3.3 FeatureContext
// ---------------------------------------------------------------------------

export interface FeatureContext {
  readonly id: FeatureId
  readonly log: Logger
  readonly paths: PathService
  readonly mpv: MpvService
  readonly settings: SettingsService
  readonly commands: CommandService
  readonly ipc: IpcService
  readonly osd: OsdService
  readonly perFile: PerFileService
  readonly menu: MenuService
  readonly i18n: I18nService
  readonly lifecycle: LifecycleService
  readonly window: WindowService
  readonly dialog: DialogService
  /**
   * The network allowlist (§1.3). RLPlayer reaches ZERO hosts by default, and
   * this service is how a module that genuinely needs one — R05's yt-dlp,
   * M21's subtitle providers — finds out whether it may, without being able to
   * grant itself permission. See src/main/core/no-network.ts.
   */
  readonly network: NetworkService
  /**
   * A second mpv process, spawned and reaped for you (§5.3). Use this rather
   * than `ctx.paths.mpvBinary()` + child_process: an untracked child is how
   * "no orphan mpv on quit" stops being true.
   */
  readonly engine: EngineService
  /** Only granted to modules declaring `usesVideoFilters` / `usesAudioFilters`. */
  readonly vf?: FilterChainService
  readonly af?: FilterChainService
}

/**
 * §1.3: "no network at rest" is the product. A module never opens a socket on
 * a whim; it asks, and the answer comes from a static table in a core file that
 * a reviewer can read in one screen.
 */
/**
 * §5.3: ONE way to run a second mpv.
 *
 * N36 (seek thumbnails, M27), L22 (the headless metadata probe, M29) and
 * C09/C16 (clip export and cache dump, M23) all need one, and §2.6 L30 already
 * carried an explicit "**Overlap warning:** build ONE shared engine, not two".
 * They have the same lifecycle problem, so they get the same lifecycle: every
 * engine is tracked, reaped on quit whether or not its owner closed it, covered
 * by one synchronous `process.on('exit')` fallback, and optionally idle-killed
 * (§6.3's M27 row: "the thumbnailer process dies 60 s after the last hover").
 */
export interface SecondaryEngineOptions {
  /**
   * A short lowercase name for what this instance is FOR: 'thumbnail', 'probe',
   * 'encode'. It appears in the log and in the pipe name, so "which mpv is
   * that?" has an answer during a support call.
   */
  purpose: string
  /**
   * Extra mpv arguments. `--no-config`, `--idle=yes`, `--terminal=no`,
   * `--msg-level=all=no`, `--load-scripts=no` and `--ytdl=no` are core's and are
   * always applied; `--input-ipc-server` is core's and gets a random pipe name
   * per instance, because mpv's IPC is documented as "explicitly insecure" and
   * exposes the `run` command.
   */
  args?: readonly string[]
  /** Kill the process this long after the last call. 0 (default) never does. */
  idleTimeoutMs?: number
}

export interface SecondaryEngine {
  /** null once it has been closed or has exited. */
  readonly pid: number | null
  readonly running: boolean
  /**
   * Raw JSON IPC to THIS process. Not ownership-checked, and it does not need to
   * be: nothing else can observe or write this instance, so there is no other
   * module's state to corrupt. The ownership map governs the PLAYING mpv.
   */
  command<T = unknown>(args: unknown[]): Promise<T>
  getProperty<T = unknown>(name: string): Promise<T>
  onEvent(event: string, cb: (msg: Record<string, unknown>) => void): Unsubscribe
  /** Idempotent, and never required: the quit path reaps whatever is left. */
  close(): Promise<void>
}

export interface EngineService {
  spawn(opts: SecondaryEngineOptions): Promise<SecondaryEngine>
  /** The bundled mpv.exe, for the cases that need the path and not a process. */
  binaryPath(): string
}

export interface NetworkService {
  /** True when this module declared this exact host. Cheap; use it to grey a
   *  provider out rather than throwing at the user. */
  allowed(host: string): boolean
  /** Throws, naming the file to edit, unless this module declared `host`. */
  assertAllowed(host: string, reason: string): void
}

export interface PathService {
  /**
   * The bundled mpv.exe.
   *
   * Exposed because four Wave-1 features need a second mpv (N36 seek
   * thumbnails, L22 the headless probe, C09/C16 clip export and cache dump) and
   * the only resolver was `resolveMpvPath()` inside `src/main/mpv/manager.ts` --
   * a file in the `mustNotTouch` list of 40 of the 55 rows. Without this, M23
   * and M27 would each have edited this file AND `core/paths.ts` to get at it.
   *
   * To RUN it, use `ctx.engine.spawn()` instead. A process started from this
   * path is tracked by nobody, and "no orphan mpv on quit" is a v0.1 guarantee
   * this app keeps with a process registry and a synchronous exit reaper. This
   * accessor is for the cases that only need the path: a version string in a bug
   * report, `--input-cmdlist` in a test.
   */
  mpvBinary(): string
  dataDir(): string
  cacheDir(): string
  subCacheDir(): string
  thumbCacheDir(): string
  sceneCacheDir(): string
  /**
   * Album art and poster frames.
   *
   * It existed in `core/paths.ts` and was promised to modules by
   * `02-wave0-api.md` section 12, and it was in NEITHER this interface NOR the
   * `pathService` object, so `ctx.paths.artCacheDir()` was `undefined` and every
   * module that followed the guide would have crashed on
   * "artCacheDir is not a function". M27's poster frames and M30's
   * continue-watching thumbnails are both named users. The gap survived because
   * nothing compared the promised surface against the implemented one; the
   * `paths.ts` test does now.
   */
  artCacheDir(): string
  logsDir(): string
  /** A per-job scratch directory. lavfi cannot take Windows absolute paths;
   *  stage assets here and spawn with `cwd` set (§7.7 trap 1). */
  tempJobDir(jobId: string): string
  isPortable(): boolean
  /** True when portable mode was requested but the folder is not writable (P39). */
  readonly portableFallback: boolean
}

// ---------------------------------------------------------------------------
// §3.3.1 MpvService
// ---------------------------------------------------------------------------

export interface MpvService {
  /** Refcounted observation. One `observe_property` on the wire per name. */
  observe<T = unknown>(name: string, cb: (value: T | undefined) => void): Unsubscribe
  /** Last value the bus saw. `undefined` is a legitimate value. */
  peek<T = unknown>(name: string): T | undefined
  get<T = unknown>(name: string): Promise<T>

  /**
   * Write a property this module OWNS. Rejects with OwnershipError naming the
   * real owner otherwise. Thrown in dev; logged, dropped and counted in
   * production so one bad module cannot black-screen the player.
   */
  set(name: string, value: unknown): Promise<void>

  /** The mediated path for a property another module owns. */
  requestSet(
    name: string,
    value: unknown,
    reason: string
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Owners register an arbiter once, in setup(). */
  arbitrate(
    name: string,
    fn: (
      value: unknown,
      req: { from: FeatureId; reason: string }
    ) => Promise<{ ok: true } | { ok: false; reason: string }>
  ): void

  /** Ownership-checked: property-writing commands go through the same map,
   *  and raw `vf`/`af` commands are refused for every feature module. */
  command<T = unknown>(args: unknown[]): Promise<T>
  /** Fire-and-forget. For drag-scrub only. */
  commandNoReply(args: unknown[]): void

  onEvent(event: string, cb: (msg: Record<string, unknown>) => void): Unsubscribe

  /** Runs after `playback-restart` for each newly loaded file. Writes made
   *  before this point are dropped by mpv — every per-file restore uses this. */
  afterFileLoaded(cb: (path: string) => void | Promise<void>): Unsubscribe

  /**
   * Contribute mpv spawn arguments. Called before every spawn/respawn.
   * `priority` 0 is core's; 1000 is reserved. Duplicate option names across
   * ANY two contributors throw at boot, except the additive `*-append`
   * allowlist in core/mpv/reserved.ts.
   */
  contributeArgs(priority: number, fn: () => string[]): void

  /** Ask for a respawn (VO change, exclusive-mode change). Debounced. */
  requestRestart(reason: string): void

  /** True while a network source is playing. */
  readonly isNetworkSource: boolean
}

// ---------------------------------------------------------------------------
// §3.3.2 SettingsService
// ---------------------------------------------------------------------------

export type SettingType =
  | { kind: 'bool' }
  | { kind: 'int'; min?: number; max?: number; step?: number }
  | { kind: 'float'; min?: number; max?: number; step?: number }
  | { kind: 'string'; multiline?: boolean }
  | { kind: 'enum'; options: ReadonlyArray<{ value: string; labelKey: string }> }
  | { kind: 'path'; mode: 'file' | 'directory'; filters?: FileFilter[] }
  | { kind: 'list'; of: 'string' }
  | { kind: 'custom'; rendererComponent: string }

export type SettingSection =
  | 'general'
  | 'playback'
  | 'video'
  | 'audio'
  | 'subtitles'
  | 'keys'
  | 'filetypes'
  | 'advanced'

export interface SettingDescriptor<T = unknown> {
  readonly id: SettingId
  readonly section: SettingSection
  readonly group?: string
  readonly labelKey: string
  readonly descriptionKey?: string
  readonly type: SettingType
  readonly default: T
  readonly keywords?: readonly string[]
  readonly mpvOption?: string
  readonly requiresRestart?: boolean
  readonly advanced?: boolean
  readonly order?: number
  readonly visibleWhen?: (get: <V>(id: SettingId) => V) => boolean
}

export interface SettingsMigration {
  from: number
  to: number
  up(data: Record<string, unknown>): Record<string, unknown>
}

export interface SettingsService {
  define(descriptors: readonly SettingDescriptor[]): void
  get<T>(id: SettingId): T
  set<T>(id: SettingId, value: T): void
  onChange<T>(id: SettingId, cb: (v: T, prev: T) => void): Unsubscribe
  migrate(m: SettingsMigration): void
}

// ---------------------------------------------------------------------------
// §3.3.3 CommandService
// ---------------------------------------------------------------------------

export type CommandScope = 'player' | 'playlist' | 'settings' | 'global'
export type PresetName = 'default' | 'potplayer' | 'mpv'

export interface CommandDescriptor {
  readonly id: CommandId
  readonly labelKey: string
  readonly category: string
  readonly scope?: CommandScope
  /** Per-preset defaults. Presets are DERIVED by folding these. */
  readonly defaults?: Partial<Record<PresetName, readonly Accel[]>>
  /** Menu location, e.g. 'video/capture'. Omit for no menu entry. */
  readonly menuPath?: string
  readonly menuOrder?: number
  readonly enabledWhen?: () => boolean
  /** Internal mediator commands are hidden from the keybind editor. */
  readonly internal?: boolean
  run(arg?: unknown): unknown
}

export interface CommandService {
  register(commands: readonly CommandDescriptor[]): void
  /** Invoke another module's command by id. Throws if unknown. */
  invoke(id: CommandId, arg?: unknown): Promise<void>
  /**
   * Same as invoke(), but returns what the command returned.
   *
   * DEVIATION from 3.3.3, documented in docs/parity/02-wave0-api.md: 3.7.3
   * sanctions `playlist.seriesPrefix(path)` as a mediator, and a mediator that
   * computes a value cannot be expressed by a `run()` typed `void`. Rather than
   * let M25 re-derive the prefix (which is precisely the duplication L50 exists
   * to prevent), commands may return a value and callers may ask for it.
   */
  query<T>(id: CommandId, arg?: unknown): Promise<T>
  has(id: CommandId): boolean
}

// ---------------------------------------------------------------------------
// §3.3.4 IpcService
// ---------------------------------------------------------------------------

export interface IpcService {
  handle<Req, Res>(channel: IpcChannel, fn: (req: Req) => Res | Promise<Res>): void
  on<Req>(channel: IpcChannel, fn: (req: Req) => void): void
  send<T>(channel: IpcChannel, payload: T, target?: 'ui' | 'settings' | 'all'): void
}

// ---------------------------------------------------------------------------
// §3.3.5 Osd / PerFile / Menu / I18n / Lifecycle
// ---------------------------------------------------------------------------

export type OsdKind =
  | 'volume'
  | 'seek'
  | 'speed'
  | 'track'
  | 'subdelay'
  | 'audiodelay'
  | 'aspect'
  | 'zoom'
  | 'chapter'
  | 'bookmark'
  | 'abloop'
  | 'frame'
  | 'info'
  | 'error'

export interface ProgressHandle {
  update(p: { fraction?: number; labelKey?: string; detail?: string }): void
  done(): void
  readonly cancelled: boolean
}

export interface OsdService {
  show(msg: { kind: OsdKind; text: string; value?: number; durationMs?: number }): void
  toast(t: {
    kind: 'info' | 'error' | 'resume'
    message: string
    actionLabel?: string
    onAction?: () => void
  }): void
  progress(p: { id: string; labelKey: string; cancellable?: boolean }): ProgressHandle
}

export interface PerFileSlice<T extends Record<string, unknown>> {
  key: string
  capture(): T
  apply(value: Partial<T>): void | Promise<void>
  rememberDefaults: Partial<Record<keyof T, boolean>>
}

export interface PerFileService {
  slice<T extends Record<string, unknown>>(s: PerFileSlice<T>): void
  /** Stable identity for the current file. */
  currentKey(): string | null
  currentPath(): string | null
  forget(file: string): void
  /**
   * The stored resume position for a file, or null when there is nothing worth
   * offering (under 60s in, or already finished).
   *
   * DEVIATION from §3.3.5, documented in docs/parity/02-wave0-api.md: the
   * declared PerFileService had no way to READ a resume position, yet M28 needs
   * one at `loadfile` time and M30 needs one for the continue-watching list.
   * Both would otherwise have re-implemented resume.json.
   */
  resumeFor(file: string): { position: number; duration: number } | null
  /** Record the current position for a file. Also a deviation: the module that
   *  owns the queue is the only one that knows which file is playing and when
   *  it is about to be replaced. */
  recordPosition(file: string, position: number, duration: number): void
  /**
   * Flush the current file's slices and position NOW, before switching away.
   * Also a deviation: mpv's `end-file` arrives with some properties already
   * reset, so the module that is about to issue `loadfile` has to be able to
   * say "capture first".
   */
  captureNow(): void
  /**
   * Capture AND fsync. For state that must survive a CRASH, not just a clean
   * quit: `captureNow()` reaches the store, whose write is debounced 300 ms and
   * whose flush otherwise happens on quit, so a module that captured a bookmark
   * and then lost the process lost the bookmark. Also a deviation from §3.3.5,
   * reported by the pilots.
   */
  persistNow(): void
  /** Batch watched-state lookup for the playlist's badges (L39). */
  lookupMany(paths: readonly string[]): Record<string, { position: number; finished: boolean }>
  /**
   * The stored slices for ANY file, not only the one playing, or null when
   * nothing is stored for it.
   *
   * Reported by the pilots: the service could read nothing but the current
   * file, which makes N11's all-files bookmark mode and N16's playlist badges
   * inexpressible — both ask about files that are not open — and left a module
   * with no option but to re-implement per-file.json beside it.
   */
  slicesFor(file: string): Record<string, Record<string, unknown>> | null
  sliceFor(file: string, sliceKey: string): Record<string, unknown> | null
  /**
   * Every file with stored slices, newest first. Enumeration is the other half
   * of the same defect: `resumeKey()` is a one-way hash of path+size, so
   * without this a caller could only ever ask about a path it already had.
   */
  storedFiles(): { key: string; path: string; updatedAt: number; sliceKeys: string[] }[]
}

export type MenuNode =
  | { type: 'separator' }
  /**
   * DEVIATION from §3.3.5, documented in docs/parity/02-wave0-api.md: a track
   * list or an aspect-ratio radio group cannot be expressed as a fixed array of
   * command ids, and every one of the legacy menu's dynamic groups needs one.
   * The provider runs at popup time and returns ordinary nodes.
   */
  | { dynamic(): readonly MenuNode[] }
  | {
      label?: string
      labelKey?: string
      commandId?: CommandId
      arg?: unknown
      checked?: boolean
      radio?: boolean
      enabled?: boolean
      submenu?: readonly MenuNode[]
    }

export interface MenuService {
  contribute(section: {
    id: string
    parent?: string
    labelKey: string
    order: number
    items: readonly MenuNode[]
    replaces?: readonly string[]
  }): void
}

export interface I18nService {
  /** Keys must start with `${ctx.id}.` — enforced. */
  register(lang: 'ko' | 'en', messages: Record<string, string>): void
  t(key: string, params?: Record<string, string | number>): string
}

export interface LifecycleService {
  onReady(cb: () => void): void
  onQuit(cb: () => void | Promise<void>): void
  /** Register a child process so the registry kills it on quit/crash. */
  trackProcess(p: { pid?: number | undefined; kill(signal?: string): boolean }): void
}

// ---------------------------------------------------------------------------
// §3.3.6 FilterChainService
// ---------------------------------------------------------------------------

export interface FilterChainService {
  /** Add or replace this module's labelled slot. Label must be pre-declared. */
  set(label: string, spec: string): void
  remove(label: string): void
  toggle(label: string, enabled: boolean): void
  /**
   * Live parameter update, emitted in the VERIFIED FOUR-ARGUMENT form
   * `['vf-command', label, option, value, lavfiFilterName]`. Falls back to a
   * full rebuild for the measured refusers and reports which path it took.
   *
   * `spec` IS REQUIRED. It is the whole filter spec the slot must hold AFTER
   * this change, and the chain both stores it and CHECKS that it expresses the
   * change (see `specReflects` in core/mpv/chain.ts). It was optional for one
   * release, with zero production adopters, and the chain's model of the filter
   * therefore diverged from mpv's on every live update in the shipped app:
   *
   *  - On the REBUILD path (`unsharp`, `pan`, `loudnorm`, `superequalizer` --
   *    the four measured refusers, one of them V08's) the rebuild re-serialises
   *    the spec the slot ALREADY holds, i.e. the pre-change value. Measured:
   *    `command('rl-sharpen','luma_amount','1.2','unsharp')` sent mpv
   *    `unsharp=5:5:1.0`. The slider did nothing.
   *  - On the COMMAND path mpv changes and the slot does not, so the next
   *    whole-chain rebuild -- another module's `set()`, an mpv respawn, the next
   *    file -- silently reverts it. Measured:
   *    `command('rl-sharpen','strength','0.55','cas')` left `serialise()`
   *    returning `@rl-sharpen:lavfi=[cas=strength=0.4]`.
   *
   * Being optional cost M03 a whole compensating file (`chain-sync.ts`, 201
   * lines + 247 of test) that every `ctx.vf`/`ctx.af` author would have written
   * again, and which did not fix it either -- it kept a SECOND model of the
   * chain's state. With `spec` required, the slot and mpv agree on both paths,
   * there is nothing left for a module to mirror, and the compiler refuses the
   * call shape that used to desynchronise them.
   */
  command(
    label: string,
    option: string,
    value: string,
    lavfiFilterName: string,
    spec: string
  ): Promise<{ path: 'command' | 'rebuild' }>
  /**
   * Whether this module's slot exists, and whether it is enabled.
   *
   * Here because without them a module cannot tell a first `set()` from a live
   * `command()` without keeping its own copy of the chain's state -- and a
   * second model of one piece of state is how the two come to disagree. Both are
   * ownership-checked: asking about ANOTHER module's label throws, because a
   * layer of Wave-1 modules able to observe each other's slots is the coupling
   * §5 exists to prevent.
   */
  has(label: string): boolean
  isEnabled(label: string): boolean
  /** What the chain currently holds for this label. Reads, for a stats row. */
  specOf(label: string): string | undefined
  readonly hasCpuFilter: boolean
}

// ---------------------------------------------------------------------------
// §3.3.7 WindowService
// ---------------------------------------------------------------------------

export type OnTopMode = 'never' | 'always' | 'while-playing' | 'fullscreen-only'

export interface DisplayInfo {
  id: number
  label: string
  bounds: Rect
  workArea: Rect
  scaleFactor: number
}

export interface SleepBlock {
  release(): void
}

export interface WindowService {
  isFullScreen(): boolean
  setFullScreen(on: boolean): void
  toggleFullScreen(): void
  /** Moves first, then goes fullscreen; restores the PRE-fullscreen bounds. */
  setFullScreenOnDisplay(displayId: number): void
  onFullScreenChange(cb: (on: boolean) => void): Unsubscribe

  /** Sets BOTH windows with the correct relative levels. Modules never choose
   *  the level: main 'floating', overlay 'pop-up-menu'. */
  setAlwaysOnTop(mode: OnTopMode): void
  getAlwaysOnTop(): OnTopMode

  /** DIP, always. `video-out-params/dw|dh` are real pixels; the service does
   *  the conversion so the mistake is made once, here. */
  getContentSize(): { width: number; height: number }
  setContentSize(width: number, height: number, opts?: { anchor?: 'center' | 'topleft' }): void
  getBounds(): Rect
  setBounds(b: Partial<Rect>, opts?: { clamp?: boolean }): void
  setAspectRatio(ratio: number, extraSize?: { width: number; height: number }): void
  center(): void
  maximize(): void
  unmaximize(): void
  isMaximized(): boolean
  minimize(): void
  restore(): void
  showInactive(): void
  focusInput(): void
  /** Manual move/resize for the frameless overlay. */
  beginDrag(mode: 'move' | 'resize', edge?: string): void
  endDrag(): void
  close(): void

  displays(): readonly DisplayInfo[]
  currentDisplay(): { id: number; label: string }
  persistBounds(): void
  restoreBounds(): void
  onDisplayChange(cb: () => void): Unsubscribe

  /** Mutates the EXISTING window — no new window, no mpv respawn. */
  enterMiniPlayer(opts?: { width?: number; corner?: 'tl' | 'tr' | 'bl' | 'br' }): void
  exitMiniPlayer(): void
  isMiniPlayer(): boolean

  setChrome(mode: 'full' | 'minimal' | 'none'): void
  readonly layoutMode: 'overlay' | 'compat'
  onVideoRegionChange(cb: (r: Rect) => void): Unsubscribe

  /** M32 only; the registry grants it by module id. */
  taskbar?: TaskbarSurface

  /** Refcounted, like the property bus. Releasing is mandatory and is also
   *  done automatically on dispose(). */
  blockSleep(kind: 'display' | 'app-suspension', reason: string): SleepBlock
}

export interface TaskbarSurface {
  setThumbarButtons(buttons: unknown[]): boolean
  setProgressBar(
    value: number,
    opts?: { mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused' }
  ): void
  setOverlayIcon(icon: unknown, description: string): void
  setThumbnailClip(r: Rect): void
  setThumbnailToolTip(s: string): void
}

// ---------------------------------------------------------------------------
// §3.3.8 DialogService
// ---------------------------------------------------------------------------

export interface DialogService {
  openFiles(o: {
    titleKey: string
    filters?: FileFilter[]
    multi?: boolean
    defaultPath?: string
  }): Promise<string[]>
  openDirectory(o: { titleKey: string; multi?: boolean; defaultPath?: string }): Promise<string[]>
  saveFile(o: {
    titleKey: string
    defaultPath?: string
    filters?: FileFilter[]
  }): Promise<string | null>
  confirm(o: {
    titleKey: string
    messageKey: string
    params?: Record<string, string | number>
    confirmKey: string
    destructive?: boolean
  }): Promise<boolean>
}
