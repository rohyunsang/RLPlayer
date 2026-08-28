import fs from 'node:fs'
import path from 'node:path'
import { app, clipboard, ClipboardItem, nativeImage, shell } from 'electron'
import type {
  CommandDescriptor,
  FeatureContext,
  FeatureModule,
  ProgressHandle,
  Unsubscribe
} from '@shared/feature-api'
import { loadConfig, saveConfig } from '../../services/config.ts'
import {
  COMMAND_VERBS,
  EN,
  KO,
  MENU_ENTRIES,
  MENU_ORDER,
  commandId,
  commandMeta,
  descriptors
} from './manifest.ts'
import {
  burstFraction,
  burstGapMs,
  burstStep,
  capturePlan,
  clampBurst,
  looksLikePng,
  normalizeFormat,
  normalizeTemplate,
  clampResizeWidth,
  popRecent,
  pushRecent,
  replyFilename,
  resizeDecision,
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

function resizeWidth(): number {
  return clampResizeWidth(ctx.settings.get<number>('capture-still.resizeWidth'))
}

function format(): string {
  return normalizeFormat(ctx.settings.get<string>('capture-still.format'))
}

/**
 * C07: rewrite a capture narrower, AFTER mpv wrote it.
 *
 * There is no mpv option for this and the spec forbids the obvious shortcut: a
 * `scale` in the live `vf` would change what the user is watching, and this
 * module does not hold `vf` in any case. So the file mpv chose is re-encoded in
 * place through `nativeImage`, which is also why the format matters — there are
 * exactly two encoders (`toPNG`, `toJPEG`), so a `webp`/`jxl`/`avif` capture is
 * REFUSED rather than silently rewritten as a PNG under a .webp name.
 *
 * Returns true when the file was rewritten. A failure is never fatal: the
 * full-size capture mpv already wrote is a perfectly good outcome, so this
 * warns and leaves it alone.
 */
async function resizeInPlace(file: string): Promise<boolean> {
  const fmt = format()
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    ctx.log.warn('C07 resize: could not read back', file)
    return false
  }
  const decision = resizeDecision(resizeWidth(), img.getSize().width, fmt)
  if (decision.action === 'skip') {
    if (decision.reason === 'not-encodable') {
      ctx.log.warn(
        `C07 resize skipped: '${fmt}' has no nativeImage encoder, so honouring the ` +
          'width would mean writing a different format than the user chose'
      )
      ctx.osd.toast({ kind: 'error', message: t('capture-still.resizeUnsupported') })
    }
    return false
  }
  try {
    const out = img.resize({ width: decision.width, quality: 'best' })
    const bytes =
      fmt === 'jpg'
        ? out.toJPEG(Math.max(1, ctx.settings.get<number>('capture-still.jpegQuality')))
        : out.toPNG()
    await fs.promises.writeFile(file, bytes)
    return true
  } catch (e) {
    ctx.log.warn('C07 resize failed, keeping the full-size capture:', (e as Error).message)
    return false
  }
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
  return [
    `--screenshot-directory=${dir}`,
    `--screenshot-template=${template()}`,
    `--screenshot-format=${format()}`,
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
  await set('screenshot-format', format())
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

function noteSaved(file: string, fellBack: boolean, resized = false): void {
  recent = pushRecent(recent, file)
  const name = path.basename(file)
  const message = fellBack
    ? t('capture-still.savedFallback', { name })
    : resized
      ? t('capture-still.savedResized', { name, w: resizeWidth() })
      : t('capture-still.saved', { name })
  ctx.osd.toast({
    kind: 'info',
    message,
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
       *
       * This branch is reached ONLY for a real string that is not a path.
       * `{filename: 42}` gets `'malformed'` instead, because accusing
       * `screenshot-directory` there would be a confident false statement about
       * the one setting a reader would then go and check.
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
    if (out.reason === 'malformed') {
      ctx.log.error(
        'screenshot reply had a non-string filename — mpv’s reply shape is not what ' +
          'this build expects. This is NOT the C01 screenshot-directory precondition. Reply:',
        reply
      )
    } else {
      ctx.log.error('screenshot produced no filename; reply was', reply)
    }
    ctx.osd.toast({ kind: 'error', message: t('capture-still.failed') })
    return null
  }

  // C07, after the fact: mpv wrote the frame at source or display size and this
  // narrows it. Deliberately after `replyFilename`, because the only path we may
  // touch is the one mpv reported.
  const resized = await resizeInPlace(out.filename)
  noteSaved(out.filename, fellBack, resized)
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
    /**
     * C07 on the clipboard path too. The temp file is always a PNG whatever
     * `screenshot-format` says, so the format argument is `'png'` and not
     * `format()` — the encodability question is about THIS file, not about the
     * user's archive format, and passing `format()` here would refuse the resize
     * for a user whose saved captures are WebP while the clipboard PNG in hand
     * is perfectly re-encodable.
     */
    let payload = new Uint8Array(bytes)
    const img = nativeImage.createFromBuffer(bytes)
    const decision = resizeDecision(resizeWidth(), img.getSize().width, 'png')
    if (decision.action === 'resize' && !img.isEmpty()) {
      payload = new Uint8Array(img.resize({ width: decision.width, quality: 'best' }).toPNG())
    }
    const blob = new Blob([payload], { type: 'image/png' })
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
  if (file !== null) {
    b.saved++
    await resizeInPlace(file)
  }
  b.state.done++
  b.job?.update({ fraction: burstFraction(b.state), detail: `${b.saved}/${b.state.config.count}` })
  /**
   * The renderer's badge is driven by this channel and by nothing else, and the
   * draft pushed only on start and stop — so the transport button read `0/50`
   * for the whole of a fifty-frame burst and then vanished. The progress handle
   * was being updated one line above, which is exactly why the gap was easy to
   * miss: the OSD looked right.
   */
  pushState()

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

    /**
     * C22. The five user-facing capture actions plus the two housekeeping ones.
     * The static half of every descriptor — id, labelKey, category and the
     * per-preset bindings — comes from `manifest.ts` so it can be asserted
     * without Electron; only `run`/`enabledWhen`, which close over ctx, live
     * here. A verb with no handler is a boot error rather than a command that
     * silently does nothing.
     */
    const handlers: Record<string, Omit<CommandDescriptor, 'id' | 'labelKey' | 'category' | 'defaults'>> = {
      save: {
        enabledWhen: () => playing(),
        run: () =>
          captureFile(
            ctx.settings.get<boolean>('capture-still.useDisplayResolution') ? 'display' : 'source',
            includeSubs()
          )
      },
      // C02: unconditional, ignoring the current `sub-visibility` state — which
      // is what you want from a key called "without subtitles".
      saveNoSubs: { enabledWhen: () => playing(), run: () => captureFile('source', false) },
      toClipboard: {
        enabledWhen: () => playing(),
        run: () => captureClipboard('source', includeSubs())
      },
      // C04: greyed out where `scaled` was measured to fail. The runtime
      // fallback in captureFile() covers the states this guard cannot see.
      saveDisplay: {
        enabledWhen: () => hasVideoSurface(),
        run: () => captureFile('display', includeSubs())
      },
      displayToClipboard: {
        enabledWhen: () => hasVideoSurface(),
        run: () => captureClipboard('display', includeSubs())
      },
      burstToggle: { enabledWhen: () => playing(), run: () => startBurstCapture() },
      deleteLast: { enabledWhen: () => recent.length > 0, run: () => deleteLast() },
      openFolder: { run: () => openCaptureFolder() }
    }
    ctx.commands.register(
      COMMAND_VERBS.map((verb) => {
        const handler = handlers[verb]
        if (!handler) throw new Error(`capture-still: no handler for command verb '${verb}'`)
        return { ...commandMeta(verb), ...handler }
      })
    )

    /**
     * C23: one capture submenu.
     *
     * A titled SUBMENU rather than eight items flattened into the root: a
     * contributed section's own `labelKey` is never rendered by
     * `core/menu.ts#buildTemplate`, so the title has to be an item that owns the
     * submenu. `replaces` is deliberately empty — the legacy menu's loose
     * `screenshot` / `screenshotClipboard` entries C23 warns about are gone; what
     * survives of them is `LEGACY_ACTIONS` in `core/legacy-bridge.ts`, which
     * routes the old binding strings to `capture-still.save` /
     * `capture-still.toClipboard` rather than drawing menu items of its own.
     */
    ctx.menu.contribute({
      id: 'capture-still.menu',
      labelKey: 'capture-still.menuTitle',
      order: MENU_ORDER,
      items: [
        {
          labelKey: 'capture-still.menuTitle',
          submenu: MENU_ENTRIES.map((e) =>
            'separator' in e ? { type: 'separator' as const } : { commandId: commandId(e.verb) }
          )
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

    ctx.i18n.register('ko', KO)
    ctx.i18n.register('en', EN)
  },

  dispose(): void {
    if (burst?.timer) clearTimeout(burst.timer)
    burst?.job?.done()
    burst = null
    for (const off of offs.splice(0)) off()
  }
}

export default mod
