import fs from 'node:fs'
import path from 'node:path'
import { app, clipboard, ClipboardItem, shell } from 'electron'
import type {
  FeatureContext,
  FeatureModule,
  ProgressHandle,
  SettingDescriptor,
  Unsubscribe
} from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'
import {
  BURST_MAX_COUNT,
  BURST_MAX_INTERVAL_MS,
  BURST_MIN_COUNT,
  BURST_MIN_INTERVAL_MS,
  CAPTURE_FORMATS,
  DEFAULT_TEMPLATE,
  burstFraction,
  burstGapMs,
  burstStep,
  capturePlan,
  clampBurst,
  looksLikePng,
  normalizeFormat,
  normalizeTemplate,
  popRecent,
  pushRecent,
  replyFilename,
  startBurst,
  tempCaptureName,
  templateWarnings,
  type BurstMode,
  type BurstState,
  type CaptureScope
} from './capture.ts'

/**
 * M22 capture-still — C01–C08, C20–C24, P59.
 *
 * Screenshots to file and to the clipboard, with and without subtitles, at
 * source or display resolution, burst capture, and the folder/template/format
 * settings behind all of it.
 *
 * THE PRECONDITION THAT SHAPES THIS WHOLE FILE (C01). `screenshot` replies with
 * a BARE RELATIVE FILENAME — `mpv-shot0002.jpg`, resolved against MPV's cwd, not
 * ours — unless `screenshot-directory` is already set. Every consumer of that
 * reply (the toast, `shell.showItemInFolder`, the C24 delete stack) breaks on a
 * relative path, so the directory is written three ways:
 *
 *   1. as a SPAWN ARG, so it is true before the first frame and after every
 *      respawn — `contributeArgs` is re-read on each spawn (§4);
 *   2. on every `settings.onChange`, so a folder the user picks mid-session
 *      applies immediately;
 *   3. on `afterFileLoaded`, as belt and braces.
 *
 * ...and the reply is still validated, because a precondition you cannot see is
 * a precondition you cannot trust: `replyFilename()` refuses a relative reply
 * and this module logs it loudly rather than handing a broken path to `shell`.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. `screenshot-raw` kills mpv over
 * JSON IPC (verified twice, vo=null and vo=gpu-next: mpv exits code 1, taking
 * playback with it) because `MPV_FORMAT_BYTE_ARRAY` has no JSON representation.
 * The clipboard path therefore goes through a temp file and Electron's
 * `nativeImage`. `screenshot-raw` is banned in the bus as well; this comment is
 * here so nobody re-adds it as an "optimisation".
 */

let ctx: FeatureContext

/** Unsubscribes taken in setup(), released in dispose(). */
const offs: Unsubscribe[] = []

/** C24: absolute paths this session reported writing, newest first. */
let recent: string[] = []

interface Burst {
  state: BurstState
  timer: ReturnType<typeof setTimeout> | null
  job: ProgressHandle | null
  scope: CaptureScope
  subs: boolean
  saved: number
}
let burst: Burst | null = null

/** Mirrors of the two properties the C04 guard needs. `peek` is only populated
 *  for names somebody observes, and these are ours to observe. */
let vid: unknown
let dwidth: unknown
let idleActive: unknown
let paused: unknown

let clipSeq = 0

// ---------------------------------------------------------------------------
// Settings-derived values
// ---------------------------------------------------------------------------

function targetDir(): string {
  const chosen = ctx.settings.get<string>('capture-still.directory')
  if (chosen && chosen.trim().length > 0) return chosen.trim()
  // D-10: portable mode keeps captures beside the exe, matching the
  // leave-no-trace promise (and PotPlayer's own habit).
  if (ctx.paths.isPortable()) return path.join(path.dirname(app.getPath('exe')), 'Capture')
  return path.join(app.getPath('pictures'), 'RLPlayer')
}

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (e) {
    ctx.log.error('capture directory is not writable:', dir, (e as Error).message)
    return false
  }
}

function includeSubs(): boolean {
  return ctx.settings.get<boolean>('capture-still.includeSubs') !== false
}

function template(): string {
  return normalizeTemplate(ctx.settings.get<string>('capture-still.template'))
}

function burstConfig(): { count: number; intervalMs: number; mode: BurstMode } {
  return clampBurst({
    count: ctx.settings.get<number>('capture-still.burstCount'),
    intervalMs: ctx.settings.get<number>('capture-still.burstIntervalMs'),
    mode: ctx.settings.get<BurstMode>('capture-still.burstMode')
  })
}

/**
 * mpv options for the spawn, re-read on every respawn.
 *
 * These are the same properties `applyProperties()` writes live; both paths
 * exist because a property write cannot happen before mpv is up and a spawn arg
 * cannot happen after. Every name here is under `screenshot-*`, which this
 * module owns, so the §4 arg-owner check passes by construction.
 */
function spawnArgs(): string[] {
  const dir = targetDir()
  ensureDir(dir)
  const format = normalizeFormat(ctx.settings.get<string>('capture-still.format'))
  return [
    `--screenshot-directory=${dir}`,
    `--screenshot-template=${template()}`,
    `--screenshot-format=${format}`,
    `--screenshot-jpeg-quality=${ctx.settings.get<number>('capture-still.jpegQuality')}`,
    `--screenshot-png-compression=${ctx.settings.get<number>('capture-still.pngCompression')}`,
    // C06, measured: the default is `yes`, so every PNG from an 8-bit H.264
    // source came out 16-bit — 5.37 MB for one 1280x720 frame.
    `--screenshot-high-bit-depth=${
      ctx.settings.get<boolean>('capture-still.highBitDepth') ? 'yes' : 'no'
    }`,
    '--screenshot-tag-colorspace=yes',
    // GPU readback, not a software decode of the frame: `sw=yes` would ignore
    // the render pipeline the user is actually watching.
    '--screenshot-sw=no'
  ]
}

/** The live half of `spawnArgs()`. Everything here is owned by this module. */
async function applyProperties(): Promise<void> {
  const dir = targetDir()
  ensureDir(dir)
  const set = async (name: string, value: unknown): Promise<void> => {
    try {
      await ctx.mpv.set(name, value)
    } catch (e) {
      ctx.log.warn(`could not set ${name}:`, (e as Error).message)
    }
  }
  await set('screenshot-directory', dir)
  await set('screenshot-template', template())
  await set('screenshot-format', normalizeFormat(ctx.settings.get<string>('capture-still.format')))
  await set('screenshot-jpeg-quality', ctx.settings.get<number>('capture-still.jpegQuality'))
  await set('screenshot-png-compression', ctx.settings.get<number>('capture-still.pngCompression'))
  await set('screenshot-high-bit-depth', ctx.settings.get<boolean>('capture-still.highBitDepth'))
}

// ---------------------------------------------------------------------------
// State guards
// ---------------------------------------------------------------------------

function playing(): boolean {
  return idleActive !== true
}

/**
 * C04's precondition, best-effort.
 *
 * `scaled` and `window` were measured returning `error running command` with no
 * window-backed VO. There is no single property that says "there is a window
 * surface", so this is a conjunction of the two that are observable: a selected
 * video track and a decoded display width. It greys the menu items out in the
 * obvious cases; the *authoritative* handling is the fallback in `captureFile`,
 * because a guard that guesses must not be the only thing between a keypress and
 * a silent error (C04 forbids exactly that).
 */
function hasVideoSurface(): boolean {
  if (!playing()) return false
  if (vid === false || vid === 'no') return false
  return typeof dwidth === 'number' && dwidth > 0
}

// ---------------------------------------------------------------------------
// Capture (C01, C02, C04, C20)
// ---------------------------------------------------------------------------

function t(key: string, params?: Record<string, string | number>): string {
  return ctx.i18n.t(key, params)
}

function noteSaved(file: string, fellBack: boolean): void {
  recent = pushRecent(recent, file)
  ctx.osd.toast({
    kind: 'info',
    message: fellBack
      ? t('capture-still.savedFallback', { name: path.basename(file) })
      : t('capture-still.saved', { name: path.basename(file) }),
    actionLabel: t('capture-still.openFolder'),
    onAction: () => shell.showItemInFolder(file)
  })
}

/**
 * One capture through the `screenshot` command, honouring the template.
 *
 * Prefer this over `screenshot-to-file` for anything the user keeps:
 * `screenshot-to-file` ignores `screenshot-template`, replies `null` (so there
 * is nothing to show in a toast or open in Explorer) and refuses `scaled`.
 *
 * Returns the absolute filename mpv chose, or null. Never returns a relative
 * path: a relative reply means the precondition failed and is logged as a bug.
 */
async function captureFile(scope: CaptureScope, withSubs: boolean): Promise<string | null> {
  if (!playing()) return null
  const plan = capturePlan({ sink: 'template', scope, subs: withSubs })
  let fellBack = false

  let reply: unknown
  try {
    reply = await ctx.mpv.command(['screenshot', plan.flags])
  } catch (e) {
    // C04: `scaled`/`window` fail outright where `video` succeeds. Falling back
    // and SAYING SO is one of the two sanctioned outcomes; a silent error is
    // not one of them.
    if (plan.fallbackFlags === null) {
      ctx.log.error('screenshot failed:', (e as Error).message)
      ctx.osd.toast({ kind: 'error', message: t('capture-still.failed') })
      return null
    }
    ctx.log.warn(
      `screenshot '${plan.flags}' refused (${(e as Error).message}); ` +
        `falling back to '${plan.fallbackFlags}' — no window-backed VO (C04)`
    )
    try {
      reply = await ctx.mpv.command(['screenshot', plan.fallbackFlags])
      fellBack = true
    } catch (e2) {
      ctx.log.error('screenshot fallback failed too:', (e2 as Error).message)
      ctx.osd.toast({ kind: 'error', message: t('capture-still.failed') })
      return null
    }
  }

  const out = replyFilename(reply)
  if (!out.ok) {
    if (out.reason === 'relative') {
      /**
       * The loud log C01 asks for. If this ever fires, `screenshot-directory`
       * was not set when mpv took the shot, and the file is somewhere in mpv's
       * cwd. We deliberately do NOT hand this path to `shell` or to the C24
       * delete stack.
       */
      ctx.log.error(
        'screenshot replied with a RELATIVE filename:',
        reply,
        '— screenshot-directory was not in effect (C01). The file is in mpv’s cwd, ' +
          'not the capture folder, and this path is not usable.'
      )
      ctx.osd.toast({ kind: 'error', message: t('capture-still.relativeReply') })
      return null
    }
    ctx.log.error('screenshot produced no filename; reply was', reply)
    ctx.osd.toast({ kind: 'error', message: t('capture-still.failed') })
    return null
  }

  noteSaved(out.filename, fellBack)
  return out.filename
}

/**
 * C03: the current frame on the clipboard.
 *
 * `screenshot-to-file` into a temp PNG, then Electron's clipboard. Two things
 * about this shape are not preference:
 *
 *  - `screenshot-raw` is NEVER used. Verified twice (vo=null and vo=gpu-next):
 *    sending it over the JSON pipe makes mpv exit with code 1, killing playback,
 *    because `MPV_FORMAT_BYTE_ARRAY` has no JSON representation. The bus bans it
 *    outright; this is why.
 *  - `clipboard.write([new ClipboardItem({...})])`, NOT `clipboard.writeImage`.
 *    §2.4 C03 prescribes `clipboard.writeImage(nativeImage.createFromPath(tmp))`
 *    and that method DOES NOT EXIST in the pinned Electron: the module's
 *    interface is `clear/has/read/readText/write/writeText/selection` only (see
 *    the finding in this module's report). Following the spec literally here
 *    would have been a runtime "writeImage is not a function" on the first
 *    Ctrl+C, past both typecheck-by-eyeball and any test that mocks Electron.
 */
async function captureClipboard(scope: CaptureScope, withSubs: boolean): Promise<void> {
  if (!playing()) return
  const dir = ctx.paths.tempJobDir('capture-still')
  if (!ensureDir(dir)) return
  const tmp = path.join(dir, tempCaptureName(++clipSeq, Date.now()))
  // The temp file is always a .png whatever `screenshot-format` says: mpv picks
  // the writer from the extension, and the clipboard wants a lossless RGB image,
  // not the user's chosen archive format.
  const plan = capturePlan({ sink: 'exact', scope, subs: withSubs })
  try {
    try {
      await ctx.mpv.command(['screenshot-to-file', tmp, plan.flags])
    } catch (e) {
      if (plan.fallbackFlags === null) throw e
      ctx.log.warn(
        `screenshot-to-file '${plan.flags}' refused (${(e as Error).message}); ` +
          `falling back to '${plan.fallbackFlags}' — no window-backed VO (C04)`
      )
      await ctx.mpv.command(['screenshot-to-file', tmp, plan.fallbackFlags])
    }
    const bytes = await fs.promises.readFile(tmp)
    if (!looksLikePng(bytes)) throw new Error(`mpv wrote no usable PNG (${bytes.length} bytes)`)
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    ctx.osd.toast({ kind: 'info', message: t('capture-still.copied') })
  } catch (e) {
    ctx.log.error('clipboard capture failed:', (e as Error).message)
    ctx.osd.toast({ kind: 'error', message: t('capture-still.failed') })
  } finally {
    fs.promises.rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Burst capture (C08)
// ---------------------------------------------------------------------------

function pushState(): void {
  ctx.ipc.send('capture-still:state', {
    burst: burst !== null,
    done: burst?.saved ?? 0,
    total: burst?.state.config.count ?? 0
  })
}

function stopBurst(reason: 'complete' | 'cancelled' | 'idle'): void {
  const b = burst
  if (!b) return
  if (b.timer) clearTimeout(b.timer)
  b.job?.done()
  burst = null
  pushState()
  const last = recent[0]
  ctx.osd.toast({
    kind: reason === 'complete' ? 'info' : 'error',
    message: t(reason === 'complete' ? 'capture-still.burstDone' : 'capture-still.burstStopped', {
      n: b.saved
    }),
    ...(last !== undefined
      ? { actionLabel: t('capture-still.openFolder'), onAction: () => shell.showItemInFolder(last) }
      : {})
  })
}

/**
 * One burst tick.
 *
 * Chained `setTimeout`, not `setInterval`: screenshot encoding is asynchronous
 * and a 5-MB PNG at a 100 ms interval otherwise queues faster than mpv drains
 * it. The next tick is scheduled only after the previous capture resolved, so
 * the interval is a floor rather than a promise.
 *
 * Frame mode steps through M24's command, not through a raw `frame-step`:
 * `frame-step` is `nav-seek`'s (it writes core's `pause`, which is exactly why it
 * has an owner), and this module may not issue it.
 */
async function burstTick(): Promise<void> {
  const b = burst
  if (!b) return
  if (!playing()) {
    stopBurst('idle')
    return
  }
  if (b.job?.cancelled === true) b.state.stopping = true

  const step = burstStep(b.state)
  if (step.action === 'finish') {
    stopBurst(step.reason)
    return
  }

  const file = await captureFileQuiet(b.scope, b.subs)
  if (file !== null) b.saved++
  b.state.done++
  b.job?.update({ fraction: burstFraction(b.state), detail: `${b.saved}/${b.state.config.count}` })

  if (b.state.config.mode === 'frame' && ctx.commands.has('nav-seek.frameForward')) {
    await ctx.commands.invoke('nav-seek.frameForward').catch(() => undefined)
  }

  if (burstStep(b.state).action === 'finish') {
    stopBurst(b.state.stopping ? 'cancelled' : 'complete')
    return
  }
  b.timer = setTimeout(() => void burstTick(), burstGapMs(b.state.config))
}

/**
 * A burst capture, without a toast per frame.
 *
 * A hundred toasts is not a feature; the progress handle is the feedback, and
 * one toast at the end carries the count and the folder action.
 */
async function captureFileQuiet(scope: CaptureScope, withSubs: boolean): Promise<string | null> {
  const plan = capturePlan({ sink: 'template', scope, subs: withSubs })
  try {
    let reply: unknown
    try {
      reply = await ctx.mpv.command(['screenshot', plan.flags])
    } catch (e) {
      if (plan.fallbackFlags === null) throw e
      reply = await ctx.mpv.command(['screenshot', plan.fallbackFlags])
    }
    const out = replyFilename(reply)
    if (!out.ok) {
      if (out.reason === 'relative') {
        ctx.log.error('burst capture replied with a RELATIVE filename (C01):', reply)
      }
      return null
    }
    recent = pushRecent(recent, out.filename)
    return out.filename
  } catch (e) {
    ctx.log.warn('burst capture failed:', (e as Error).message)
    return null
  }
}

function startBurstCapture(): void {
  if (burst !== null) {
    stopBurst('cancelled')
    return
  }
  if (!playing()) return
  const config = burstConfig()
  if (config.mode === 'frame' && paused !== true) {
    // C08's frame mode advances the file one frame per shot; doing that during
    // playback fights the player instead of the user.
    ctx.osd.toast({ kind: 'error', message: t('capture-still.burstNeedsPause') })
    return
  }
  burst = {
    state: startBurst(config),
    timer: null,
    job: ctx.osd.progress({
      id: 'capture-still.burst',
      labelKey: 'capture-still.burstProgress',
      cancellable: true
    }),
    scope: ctx.settings.get<boolean>('capture-still.useDisplayResolution') ? 'display' : 'source',
    subs: includeSubs(),
    saved: 0
  }
  pushState()
  ctx.osd.show({ kind: 'info', text: t('capture-still.burstStarted', { n: config.count }) })
  void burstTick()
}

// ---------------------------------------------------------------------------
// C24 — delete the last capture
// ---------------------------------------------------------------------------

async function deleteLast(): Promise<void> {
  const { file, rest } = popRecent(recent)
  if (file === null) {
    ctx.osd.show({ kind: 'info', text: t('capture-still.nothingToDelete') })
    return
  }
  try {
    // `shell.trashItem`, never `fs.unlinkSync`: this is recoverable by the user
    // from the Recycle Bin, and it only ever names a file THIS session reported
    // writing (C24).
    await shell.trashItem(file)
    recent = rest
    ctx.osd.show({ kind: 'info', text: t('capture-still.deleted', { name: path.basename(file) }) })
  } catch (e) {
    ctx.log.warn('could not trash', file, (e as Error).message)
    ctx.osd.toast({ kind: 'error', message: t('capture-still.deleteFailed') })
  }
}

function openCaptureFolder(): void {
  const last = recent[0]
  if (last !== undefined) {
    shell.showItemInFolder(last)
    return
  }
  const dir = targetDir()
  if (ensureDir(dir)) void shell.openPath(dir)
}

// ---------------------------------------------------------------------------
// Settings (C05, C06, C21, P59)
// ---------------------------------------------------------------------------

function descriptors(): SettingDescriptor[] {
  const formats = CAPTURE_FORMATS.map((f) => ({
    value: f,
    labelKey: `capture-still.format.${f}`
  }))
  return [
    {
      id: 'capture-still.directory',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.directoryLabel',
      descriptionKey: 'capture-still.directoryDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      mpvOption: 'screenshot-directory',
      keywords: ['스크린샷', '캡처', 'screenshot', 'capture', 'folder', '폴더'],
      order: 30
    },
    {
      id: 'capture-still.template',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.templateLabel',
      descriptionKey: 'capture-still.templateDesc',
      type: { kind: 'string' },
      default: DEFAULT_TEMPLATE,
      mpvOption: 'screenshot-template',
      keywords: ['파일명', '템플릿', 'template', 'filename'],
      order: 31
    },
    {
      id: 'capture-still.format',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.formatLabel',
      // C06: mpv has no BMP writer. PNG is the lossless offer instead.
      type: { kind: 'enum', options: formats },
      default: 'png',
      mpvOption: 'screenshot-format',
      keywords: ['형식', 'format', 'png', 'jpg', 'webp'],
      order: 32
    },
    {
      id: 'capture-still.jpegQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.jpegQualityLabel',
      type: { kind: 'int', min: 0, max: 100, step: 1 },
      default: 90,
      mpvOption: 'screenshot-jpeg-quality',
      keywords: ['품질', 'quality', 'jpeg'],
      order: 33,
      visibleWhen: (get) => get<string>('capture-still.format') === 'jpg'
    },
    {
      id: 'capture-still.pngCompression',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.pngCompressionLabel',
      type: { kind: 'int', min: 0, max: 9, step: 1 },
      default: 7,
      mpvOption: 'screenshot-png-compression',
      keywords: ['압축', 'compression', 'png'],
      order: 34,
      visibleWhen: (get) => get<string>('capture-still.format') === 'png'
    },
    {
      id: 'capture-still.highBitDepth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.highBitDepthLabel',
      descriptionKey: 'capture-still.highBitDepthDesc',
      type: { kind: 'bool' },
      // C06, MEASURED: mpv defaults this to `yes`, which turned every PNG from
      // an 8-bit H.264 source into a 16-bit 5.37 MB file.
      default: false,
      mpvOption: 'screenshot-high-bit-depth',
      keywords: ['비트', 'bit depth', 'hdr'],
      advanced: true,
      order: 35
    },
    {
      id: 'capture-still.includeSubs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.includeSubsLabel',
      type: { kind: 'bool' },
      default: true,
      keywords: ['자막', 'subtitles'],
      order: 36
    },
    {
      id: 'capture-still.useDisplayResolution',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.useDisplayResolutionLabel',
      descriptionKey: 'capture-still.useDisplayResolutionDesc',
      type: { kind: 'bool' },
      default: false,
      keywords: ['해상도', 'resolution', 'display', 'scaled'],
      order: 37
    },
    {
      id: 'capture-still.burstCount',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstCountLabel',
      type: { kind: 'int', min: BURST_MIN_COUNT, max: BURST_MAX_COUNT, step: 1 },
      default: 10,
      keywords: ['연속', 'burst', 'consecutive', '장수'],
      order: 38
    },
    {
      id: 'capture-still.burstIntervalMs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstIntervalLabel',
      type: {
        kind: 'int',
        min: BURST_MIN_INTERVAL_MS,
        max: BURST_MAX_INTERVAL_MS,
        step: 100
      },
      default: 1000,
      keywords: ['간격', 'interval', 'burst'],
      order: 39
    },
    {
      id: 'capture-still.burstMode',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-still.burstModeLabel',
      descriptionKey: 'capture-still.burstModeDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'time', labelKey: 'capture-still.burstMode.time' },
          { value: 'frame', labelKey: 'capture-still.burstMode.frame' }
        ]
      },
      default: 'time',
      keywords: ['연속', 'burst', 'frame', '프레임'],
      order: 40
    }
  ]
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const mod: FeatureModule = {
  id: 'capture-still',
  // Copied verbatim from this module's row in docs/parity/modules.json, which
  // §1 of the API guide says is the same namespace as the code half.
  dependsOn: ['core-mpv-bus'],
  /**
   * The whole `screenshot-*` family: directory, template, format, the four
   * quality knobs, high-bit-depth, tag-colorspace and sw. One owner, because
   * the reply path of every capture row depends on `screenshot-directory` being
   * whatever this module last decided it is.
   */
  ownsProperties: ['screenshot-*'],
  /**
   * `screenshot` and `screenshot-to-file` — traps 3, 4 and 5b are this module's
   * to get right once rather than everyone's to rediscover. `screenshot-raw` is
   * banned for everybody, including us.
   */
  ownsCommands: ['screenshot', 'screenshot-to-file'],

  setup(c): void {
    ctx = c

    ctx.settings.define(descriptors())

    /**
     * C21: v0.1 stored the capture folder as `AppConfig.screenshotDir` and the
     * settings window edited it directly. Migrate it ONCE, and only into an
     * untouched descriptor: seeding on every boot (which is what the Wave-0 seed
     * did) means a user who clears the new setting gets the stale legacy value
     * pushed back on the next launch, for ever. Clearing the legacy key after
     * the move is what makes this idempotent without a marker of its own.
     */
    const legacyDir = loadConfig().screenshotDir
    if (legacyDir && ctx.settings.get<string>('capture-still.directory') === '') {
      ctx.settings.set('capture-still.directory', legacyDir)
      saveConfig({ screenshotDir: '' })
      ctx.log.info('migrated AppConfig.screenshotDir into capture-still.directory')
    }

    for (const id of [
      'capture-still.directory',
      'capture-still.template',
      'capture-still.format',
      'capture-still.jpegQuality',
      'capture-still.pngCompression',
      'capture-still.highBitDepth'
    ]) {
      offs.push(ctx.settings.onChange(id, () => void applyProperties()))
    }
    offs.push(
      ctx.settings.onChange<string>('capture-still.template', (v) => {
        // The template is the one setting whose mistakes are silent: mpv will
        // not overwrite an existing file, so a template with no disambiguator
        // simply stops producing captures (C05).
        for (const w of templateWarnings(v)) {
          ctx.log.warn(`screenshot-template '${v}': ${w}`)
          ctx.osd.toast({ kind: 'error', message: t(`capture-still.warn.${w}`) })
        }
      })
    )

    ctx.mpv.contributeArgs(10, spawnArgs)

    offs.push(
      ctx.mpv.observe('vid', (v) => {
        vid = v
      }),
      ctx.mpv.observe('dwidth', (v) => {
        dwidth = v
      }),
      ctx.mpv.observe('idle-active', (v) => {
        idleActive = v
        if (v === true && burst !== null) stopBurst('idle')
      }),
      ctx.mpv.observe('pause', (v) => {
        paused = v
      }),
      // Belt and braces on the C01 precondition: a respawn re-reads the spawn
      // args, but a `loadfile` into a fresh instance is the cheapest place to be
      // sure of it.
      ctx.mpv.afterFileLoaded(() => void applyProperties())
    )

    ctx.commands.register([
      {
        id: 'capture-still.save',
        labelKey: 'capture-still.save',
        category: 'capture',
        // PotPlayer: Ctrl+E is "Save Current Source Frame", verified 8/8 against
        // its own English.ini [MenuString] table (C22). Its `S` is the Pixel
        // Shaders menu, which is why the seed's potplayer binding moved.
        defaults: { default: ['KeyS'], potplayer: ['Ctrl+KeyE'], mpv: ['KeyS'] },
        enabledWhen: () => playing(),
        run: () =>
          captureFile(
            ctx.settings.get<boolean>('capture-still.useDisplayResolution') ? 'display' : 'source',
            includeSubs()
          )
      },
      {
        id: 'capture-still.saveNoSubs',
        labelKey: 'capture-still.saveNoSubs',
        category: 'capture',
        // C02: unconditional, ignoring the current `sub-visibility` state, which
        // is what you want from a key called "without subtitles".
        defaults: { default: ['Shift+KeyS'], mpv: ['Shift+KeyS'] },
        enabledWhen: () => playing(),
        run: () => captureFile('source', false)
      },
      {
        id: 'capture-still.toClipboard',
        labelKey: 'capture-still.toClipboard',
        category: 'capture',
        defaults: { default: ['Ctrl+KeyS'], potplayer: ['Ctrl+KeyC'], mpv: ['Ctrl+KeyS'] },
        enabledWhen: () => playing(),
        run: () => captureClipboard('source', includeSubs())
      },
      {
        id: 'capture-still.saveDisplay',
        labelKey: 'capture-still.saveDisplay',
        category: 'capture',
        defaults: { default: ['Ctrl+Shift+KeyS'], potplayer: ['Ctrl+Alt+KeyE'] },
        // C04: greyed out where `scaled` was measured to fail. The runtime
        // fallback in captureFile() is what covers the cases this cannot see.
        enabledWhen: () => hasVideoSurface(),
        run: () => captureFile('display', includeSubs())
      },
      {
        id: 'capture-still.displayToClipboard',
        labelKey: 'capture-still.displayToClipboard',
        category: 'capture',
        defaults: { default: ['Ctrl+Alt+KeyC'], potplayer: ['Ctrl+Alt+KeyC'] },
        enabledWhen: () => hasVideoSurface(),
        run: () => captureClipboard('display', includeSubs())
      },
      {
        id: 'capture-still.burstToggle',
        labelKey: 'capture-still.burstToggle',
        category: 'capture',
        defaults: { default: ['Ctrl+KeyG'], potplayer: ['Ctrl+KeyG'] },
        enabledWhen: () => playing(),
        run: () => startBurstCapture()
      },
      {
        id: 'capture-still.deleteLast',
        labelKey: 'capture-still.deleteLast',
        category: 'capture',
        defaults: { default: ['Ctrl+Shift+Delete'] },
        enabledWhen: () => recent.length > 0,
        run: () => deleteLast()
      },
      {
        id: 'capture-still.openFolder',
        labelKey: 'capture-still.openFolder',
        category: 'capture',
        run: () => openCaptureFolder()
      }
    ])

    /**
     * C23: one capture submenu, replacing the legacy menu's two loose
     * screenshot entries.
     *
     * A titled SUBMENU rather than eight items flattened into the root: a
     * contributed section's own `labelKey` is not rendered as a title (see the
     * findings in this module's report), so the title has to be an item that
     * owns the submenu.
     */
    ctx.menu.contribute({
      id: 'capture-still.menu',
      labelKey: 'capture-still.menuTitle',
      order: 60,
      items: [
        {
          labelKey: 'capture-still.menuTitle',
          submenu: [
            { commandId: 'capture-still.save' },
            { commandId: 'capture-still.saveNoSubs' },
            { commandId: 'capture-still.toClipboard' },
            { type: 'separator' },
            { commandId: 'capture-still.saveDisplay' },
            { commandId: 'capture-still.displayToClipboard' },
            { type: 'separator' },
            { commandId: 'capture-still.burstToggle' },
            { type: 'separator' },
            { commandId: 'capture-still.openFolder' },
            { commandId: 'capture-still.deleteLast' }
          ]
        }
      ]
    })

    // The renderer half's transport button. Nothing here writes a property:
    // every gesture ends in a command this module owns.
    ctx.ipc.on('capture-still:save', () => {
      void ctx.commands.invoke('capture-still.save')
    })
    ctx.ipc.on('capture-still:clipboard', () => {
      void ctx.commands.invoke('capture-still.toClipboard')
    })
    ctx.ipc.on('capture-still:burst', () => {
      void ctx.commands.invoke('capture-still.burstToggle')
    })
    ctx.ipc.handle('capture-still:getState', () => ({
      burst: burst !== null,
      done: burst?.saved ?? 0,
      total: burst?.state.config.count ?? 0
    }))

    ctx.i18n.register('ko', {
      'capture-still.menuTitle': '캡처',
      'capture-still.save': '현재 프레임 저장',
      'capture-still.saveNoSubs': '자막 없이 프레임 저장',
      'capture-still.toClipboard': '현재 프레임 클립보드 복사',
      'capture-still.saveDisplay': '화면 해상도로 저장',
      'capture-still.displayToClipboard': '화면 해상도로 클립보드 복사',
      'capture-still.burstToggle': '연속 캡처 시작/중지',
      'capture-still.burstProgress': '연속 캡처',
      'capture-still.deleteLast': '마지막 캡처 삭제',
      'capture-still.openFolder': '폴더 열기',
      'capture-still.saved': '{name}{을/를} 저장했습니다',
      'capture-still.savedFallback': '{name}{을/를} 저장했습니다 (화면 해상도를 쓸 수 없어 원본 해상도로 저장)',
      'capture-still.copied': '현재 프레임을 클립보드에 복사했습니다',
      'capture-still.failed': '캡처에 실패했습니다',
      'capture-still.relativeReply':
        '캡처 파일 경로를 확인할 수 없습니다. 저장 폴더 설정을 확인하세요.',
      'capture-still.burstStarted': '연속 캡처 {n}장 시작',
      'capture-still.burstDone': '연속 캡처 {n}장 완료',
      'capture-still.burstStopped': '연속 캡처 중지 ({n}장 저장)',
      'capture-still.burstNeedsPause': '프레임 단위 연속 캡처는 일시정지 상태에서만 됩니다',
      'capture-still.deleted': '{name}{을/를} 휴지통으로 보냈습니다',
      'capture-still.deleteFailed': '삭제하지 못했습니다',
      'capture-still.nothingToDelete': '삭제할 캡처가 없습니다',
      'capture-still.directoryLabel': '캡처 저장 폴더',
      'capture-still.directoryDesc':
        '비워 두면 사진 폴더의 RLPlayer (휴대용 모드에서는 exe 옆의 Capture) 를 씁니다.',
      'capture-still.templateLabel': '파일명 템플릿',
      'capture-still.templateDesc':
        '%F 파일명 · %wH.%wM.%wS.%wT 재생 위치(ms) · %#02n 일련번호. %p 와 %P 는 콜론을 포함해 밑줄로 바뀝니다.',
      'capture-still.formatLabel': '이미지 형식',
      'capture-still.format.png': 'PNG (무손실)',
      'capture-still.format.jpg': 'JPEG',
      'capture-still.format.webp': 'WebP',
      'capture-still.format.jxl': 'JPEG XL',
      'capture-still.format.avif': 'AVIF',
      'capture-still.jpegQualityLabel': 'JPEG 품질',
      'capture-still.pngCompressionLabel': 'PNG 압축 수준',
      'capture-still.highBitDepthLabel': '고비트 심도로 저장',
      'capture-still.highBitDepthDesc':
        '8비트 영상에서도 16비트 PNG를 만들어 파일이 5배 커집니다. 10비트/HDR 원본에만 켜세요.',
      'capture-still.includeSubsLabel': '자막 포함',
      'capture-still.useDisplayResolutionLabel': '화면 해상도로 캡처',
      'capture-still.useDisplayResolutionDesc':
        '원본 대신 지금 보이는 크기로 저장합니다. 영상 창이 없으면 원본 해상도로 대체됩니다.',
      'capture-still.burstCountLabel': '연속 캡처 장수',
      'capture-still.burstIntervalLabel': '연속 캡처 간격 (ms)',
      'capture-still.burstModeLabel': '연속 캡처 방식',
      'capture-still.burstModeDesc': '프레임 단위는 일시정지 상태에서만 동작합니다.',
      'capture-still.burstMode.time': '시간 간격',
      'capture-still.burstMode.frame': '프레임 단위',
      'capture-still.warn.colon-specifier': '%p / %P 는 콜론을 포함해 밑줄로 바뀝니다',
      'capture-still.warn.illegal-literal': '파일명에 쓸 수 없는 문자가 있습니다',
      'capture-still.warn.no-disambiguator':
        '%n 이나 %wT 가 없어 같은 초에 찍은 캡처가 저장되지 않습니다 — 일련번호를 붙였습니다',
      'capture-still.transportButton': '캡처 (Shift 클릭: 클립보드, Ctrl 클릭: 연속)',
      'capture-still.templateHelp': '파일명 템플릿 지시자',
      'capture-still.legend.F': '확장자 없는 파일명',
      'capture-still.legend.f': '확장자를 포함한 파일명',
      'capture-still.legend.pos': '재생 위치 — 시/분/초/밀리초',
      'capture-still.legend.n': '일련번호 (두 자리, 0 채움)',
      'capture-still.legend.date': '오늘 날짜',
      'capture-still.legend.prop': 'mpv 속성 값 (예: 제목)',
      'capture-still.legend.percent': '% 문자 그대로',
      'capture-still.legend.note':
        '%p 와 %P 는 콜론을 포함하므로 Windows 에서 밑줄로 바뀝니다. %n 이나 %wT 가 없으면 같은 이름의 파일을 덮어쓰지 않고 저장이 조용히 실패하므로, 자동으로 일련번호를 붙입니다.'
    })
    ctx.i18n.register('en', {
      'capture-still.menuTitle': 'Capture',
      'capture-still.save': 'Save current frame',
      'capture-still.saveNoSubs': 'Save frame without subtitles',
      'capture-still.toClipboard': 'Copy current frame',
      'capture-still.saveDisplay': 'Save at display resolution',
      'capture-still.displayToClipboard': 'Copy at display resolution',
      'capture-still.burstToggle': 'Start/stop consecutive capture',
      'capture-still.burstProgress': 'Consecutive capture',
      'capture-still.deleteLast': 'Delete last capture',
      'capture-still.openFolder': 'Open folder',
      'capture-still.saved': 'Saved {name}',
      'capture-still.savedFallback': 'Saved {name} (no display surface — used source resolution)',
      'capture-still.copied': 'Frame copied to the clipboard',
      'capture-still.failed': 'Capture failed',
      'capture-still.relativeReply':
        'mpv reported a relative capture path; check the capture folder setting.',
      'capture-still.burstStarted': 'Consecutive capture: {n} frames',
      'capture-still.burstDone': 'Consecutive capture finished ({n} frames)',
      'capture-still.burstStopped': 'Consecutive capture stopped ({n} frames saved)',
      'capture-still.burstNeedsPause': 'Frame-by-frame capture needs the player paused',
      'capture-still.deleted': 'Moved {name} to the Recycle Bin',
      'capture-still.deleteFailed': 'Could not delete the file',
      'capture-still.nothingToDelete': 'No capture from this session to delete',
      'capture-still.directoryLabel': 'Capture folder',
      'capture-still.directoryDesc':
        'Leave empty for Pictures\\RLPlayer (or Capture beside the exe in portable mode).',
      'capture-still.templateLabel': 'Filename template',
      'capture-still.templateDesc':
        '%F filename · %wH.%wM.%wS.%wT position with ms · %#02n counter. %p and %P expand with colons, which Windows turns into underscores.',
      'capture-still.formatLabel': 'Image format',
      'capture-still.format.png': 'PNG (lossless)',
      'capture-still.format.jpg': 'JPEG',
      'capture-still.format.webp': 'WebP',
      'capture-still.format.jxl': 'JPEG XL',
      'capture-still.format.avif': 'AVIF',
      'capture-still.jpegQualityLabel': 'JPEG quality',
      'capture-still.pngCompressionLabel': 'PNG compression',
      'capture-still.highBitDepthLabel': 'Save at high bit depth',
      'capture-still.highBitDepthDesc':
        'Writes 16-bit PNGs even from 8-bit video, roughly 5x the file size. Only for 10-bit/HDR sources.',
      'capture-still.includeSubsLabel': 'Include subtitles',
      'capture-still.useDisplayResolutionLabel': 'Capture at display resolution',
      'capture-still.useDisplayResolutionDesc':
        'Saves what is on screen instead of the source frame. Falls back to source resolution when there is no video window.',
      'capture-still.burstCountLabel': 'Consecutive capture: frames',
      'capture-still.burstIntervalLabel': 'Consecutive capture: interval (ms)',
      'capture-still.burstModeLabel': 'Consecutive capture mode',
      'capture-still.burstModeDesc': 'Frame-by-frame only works while paused.',
      'capture-still.burstMode.time': 'Time interval',
      'capture-still.burstMode.frame': 'Frame by frame',
      'capture-still.warn.colon-specifier': '%p / %P expand with colons and become underscores',
      'capture-still.warn.illegal-literal': 'The template contains characters Windows rejects',
      'capture-still.warn.no-disambiguator':
        'No %n or %wT: mpv will not overwrite, so a second capture in the same second would be lost — a counter was appended',
      'capture-still.transportButton': 'Capture (Shift-click: clipboard, Ctrl-click: burst)',
      'capture-still.templateHelp': 'Filename template specifiers',
      'capture-still.legend.F': 'Filename without extension',
      'capture-still.legend.f': 'Filename with extension',
      'capture-still.legend.pos': 'Playback position — h/m/s/ms',
      'capture-still.legend.n': 'Counter (two digits, zero padded)',
      'capture-still.legend.date': 'Today’s date',
      'capture-still.legend.prop': 'An mpv property, e.g. the title',
      'capture-still.legend.percent': 'A literal percent sign',
      'capture-still.legend.note':
        '%p and %P expand with colons, which Windows turns into underscores. Without %n or %wT mpv refuses to overwrite and the capture silently does not happen, so a counter is appended for you.'
    })
  },

  dispose(): void {
    if (burst?.timer) clearTimeout(burst.timer)
    burst?.job?.done()
    burst = null
    for (const off of offs.splice(0)) off()
  }
}

export default mod
