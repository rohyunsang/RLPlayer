import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import type { FeatureContext, FeatureModule, SettingDescriptor } from '@shared/feature-api'
import {
  AUDIO_FORMATS,
  CLIP_PRESETS,
  GIF_DITHERS,
  HARDWARE_FALLBACK,
  audioArgs,
  audioFormat,
  burstArgs,
  clipArgs,
  clipPreset,
  estimateGifBytes,
  gifArgs,
  hardwareProbeArgs,
  sanitizeStem,
  sheetArgs,
  stampSeconds,
  uniqueName,
  webpArgs,
  type ClipPreset
} from './encode-args.ts'
import { JobQueue, type JobKind, type JobRunner } from './job-queue.ts'
import { probeEncoder, runEncode } from './runner.ts'

/**
 * M23 capture-encode — encode jobs, clip export, GIF/WebP, audio extraction,
 * the offline burst, the contact sheet, the cache cut and live stream recording.
 * §2.4 rows C09–C19, plus A46 (audio recording) and R21 (stream recording).
 *
 * NO ffmpeg, and the bundle grows by ZERO bytes. §7.3 R-5, verified: mpv's own
 * encode mode covers every row here. mpv.exe statically links FFmpeg and exposes
 * no CLI, so the engine is the mpv already shipped, spawned through
 * `ctx.engine.spawn()`. It is a separate process exchanging data rather than
 * linked code, so RLPlayer's MIT licence is unaffected (docs/03). The one row
 * that would need an ffmpeg binary is **S43** — extract an embedded subtitle to
 * disk — and §2.4 answers it "we will not": this module registers no S43
 * command. An ffmpeg build is ~80 MB against a §6.4 budget of 80 MB unpacked
 * TOTAL, so it was never a close call.
 *
 * THE STANDING CAVEAT ON EVERY PRESET (§7.3 R-4, still open): the pinned mpv
 * reports a **GPL** build. An LGPL build (`-Dgpl=false`) loses libx264, libx265
 * and libmp3lame outright and this preset table collapses to AAC / Opus / VP9 /
 * AV1. R-4 says that question "must be closed before M23 starts" and it has not
 * been. So the presets are DATA (`CLIP_PRESETS`, `AUDIO_FORMATS`), nothing here
 * asserts that a codec exists, and every failure surfaces mpv's own text.
 *
 * WHAT THIS MODULE OWNS, deliberately almost nothing:
 *  - `stream-record` (C17/R21) — the only property it writes;
 *  - `dump-cache` and `ab-loop-dump-cache` (C13) — §2.1's "capture owns
 *    everything that writes media to disk".
 * Everything else happens inside a second mpv nothing else can observe. The A-B
 * points it exports (`ab-loop-a`/`ab-loop-b`) are M26's and are READ, never
 * written; reads are unrestricted (§3.7).
 */

let ctx: FeatureContext
let queue: JobQueue
/** C19: probe once per session, per encoder, and cache the answer. */
const hardwareProbes = new Map<string, boolean>()

// ---------------------------------------------------------------------------
// Where output goes
// ---------------------------------------------------------------------------

function portableDir(kind: 'video' | 'audio'): string {
  // D-10, matching M22: portable mode keeps its output beside the exe.
  return path.join(path.dirname(app.getPath('exe')), kind === 'video' ? 'Export' : 'Audio')
}

function canWrite(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function isUrl(p: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(p)
}

/**
 * The chosen folder, else the source file's own folder, else the shell library.
 *
 * The source folder is the default on purpose: somebody exporting a clip of an
 * episode almost always wants it beside the episode, and it is the only default
 * that behaves identically in portable mode and on a machine whose libraries are
 * redirected to a network share.
 */
function targetDir(kind: 'video' | 'audio'): string {
  const chosen = ctx.settings.get<string>(
    kind === 'video' ? 'capture-encode.videoDir' : 'capture-encode.audioDir'
  )
  if (chosen) return chosen
  const src = sourceFile()
  if (src && !isUrl(src)) {
    const dir = path.dirname(src)
    if (canWrite(dir)) return dir
  }
  if (ctx.paths.isPortable()) return portableDir(kind)
  try {
    return path.join(app.getPath(kind === 'video' ? 'videos' : 'music'), 'RLPlayer')
  } catch {
    return portableDir(kind)
  }
}

function sourceFile(): string | null {
  const p = ctx.mpv.peek<string>('path')
  return typeof p === 'string' && p.length > 0 ? p : null
}

function sourceStem(): string {
  const p = sourceFile()
  if (!p) return 'clip'
  return sanitizeStem(isUrl(p) ? 'stream' : path.basename(p, path.extname(p)))
}

/** An absolute, collision-free output path. Creates the directory. */
function outputPath(kind: 'video' | 'audio', suffix: string, ext: string): string {
  const dir = targetDir(kind)
  fs.mkdirSync(dir, { recursive: true })
  const base = `${sourceStem()}_${suffix}`
  const name = uniqueName(base, ext, (n) => fs.existsSync(path.join(dir, n)))
  return path.join(dir, name)
}

/**
 * mpv takes forward slashes on Windows and hands them back unchanged.
 *
 * Only for values that travel as an mpv PROPERTY (`stream-record`) or inside an
 * mpv option; the paths this module hands to Electron and to `fs` stay native.
 */
function mpvPath(p: string): string {
  return p.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// The range every job works on
// ---------------------------------------------------------------------------

/**
 * M26's A-B loop points, read.
 *
 * §7.7 trap 6: **clearing an A-B point yields the string `"no"`**, not a number
 * and not `undefined`. Treating the reply as a number gives `NaN`, and
 * `--start=NaN --end=NaN` is accepted by mpv and produces an empty file — a
 * failure that looks like a broken encoder.
 */
function abRange(): { a: number; b: number } | null {
  const a = ctx.mpv.peek<number | string>('ab-loop-a')
  const b = ctx.mpv.peek<number | string>('ab-loop-b')
  if (typeof a !== 'number' || typeof b !== 'number') return null
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null
  return { a, b }
}

function duration(): number {
  const d = ctx.mpv.peek<number>('duration')
  return typeof d === 'number' && Number.isFinite(d) ? d : 0
}

function position(): number {
  const t = ctx.mpv.peek<number>('time-pos')
  return typeof t === 'number' && Number.isFinite(t) ? t : 0
}

/**
 * The range to export: the A-B loop if both points are set, otherwise a
 * fallback.
 *
 * `'short'` is for GIF/WebP/burst, where "the whole file" is never what anybody
 * meant — those start at the current position and run for the capped window.
 */
function exportRange(fallback: 'whole' | 'short'): { start: number; end: number } | null {
  const ab = abRange()
  if (ab) return { start: ab.a, end: ab.b }
  const dur = duration()
  if (fallback === 'whole') {
    if (dur <= 0) return null
    return { start: 0, end: dur }
  }
  const cap = ctx.settings.get<number>('capture-encode.gifMaxSeconds')
  const start = position()
  const end = dur > 0 ? Math.min(dur, start + cap) : start + cap
  return end > start ? { start, end } : null
}

// ---------------------------------------------------------------------------
// Guards and messages
// ---------------------------------------------------------------------------

function ready(): boolean {
  return ctx.mpv.peek<boolean>('idle-active') !== true && sourceFile() !== null
}

/** An encode job re-reads the source from disk, so it is local sources only. */
function localReady(): boolean {
  const f = sourceFile()
  return ready() && f !== null && !isUrl(f)
}

function toast(
  kind: 'info' | 'error',
  key: string,
  params?: Record<string, string | number>
): void {
  ctx.osd.toast({ kind, message: ctx.i18n.t(key, params) })
}

function reveal(file: string): void {
  ctx.osd.toast({
    kind: 'info',
    message: ctx.i18n.t('capture-encode.finished', { name: path.basename(file) }),
    actionLabel: ctx.i18n.t('capture-encode.openFolder'),
    onAction: () => shell.showItemInFolder(file)
  })
}

// ---------------------------------------------------------------------------
// Submitting a job (C18)
// ---------------------------------------------------------------------------

/**
 * TWO CANCEL PATHS, and the second one exists because of a core defect rather
 * than a design preference.
 *
 * §11 documents `ctx.osd.progress({ cancellable: true })` with `if
 * (job.cancelled) abort()`, and C18 is the row that needs it. In the shipped app
 * that handle is INERT, in both directions, and it is measurable:
 *
 *   - `OsdBus.progress()` sends `ui:progress`; `src/preload/index.ts` forwards
 *     it as `onProgress`; **nothing in `src/renderer/**` subscribes.**
 *     `src/renderer/src/main.ts:579-580` calls `api.onToast` and `api.onOsd`;
 *     `api.onProgress` has zero call sites. So a progress handle renders nothing.
 *   - `ProgressHandle.cancelled` reads `OsdBus`'s `progressCancelled` set, whose
 *     only writer is `ipcMain.on('ui:progressCancel')` at `src/main/ipc.ts:158`,
 *     and the preload exposes **no sender for that channel at all**. So no page
 *     can fire it even if one wanted to, and `cancelled` is permanently `false`.
 *
 * Same shape as `ctx.panel()` before the fourth round and
 * `SeekbarHost.tooltips()` before the third: a documented contribution point
 * with no consumer. The handle is still driven here — it costs nothing and
 * starts working the day the wire is connected — but the cancel a user can
 * actually reach is the toast action (`ui:toastAction` IS wired end to end,
 * preload sender included) plus the `capture-encode.cancel` command, which is in
 * the menu and in the keybind editor.
 */
function submit(spec: {
  kind: JobKind
  labelKey: string
  outputFile: string
  detail?: string
  runner: (helpers: {
    jobId: string
    onProgress: (fraction: number) => void
  }) => JobRunner
}): void {
  const id = queue.nextId(spec.kind)
  const label = ctx.i18n.t(spec.labelKey)
  const progress = ctx.osd.progress({
    id: `capture-encode.${id}`,
    labelKey: 'capture-encode.jobRunning',
    cancellable: true
  })
  progress.update({ fraction: 0, detail: spec.detail ?? label })

  ctx.osd.toast({
    kind: 'info',
    message: ctx.i18n.t('capture-encode.started', {
      label,
      detail: spec.detail ?? path.basename(spec.outputFile)
    }),
    actionLabel: ctx.i18n.t('capture-encode.cancel'),
    onAction: () => void queue.cancel(id)
  })

  const onProgress = (fraction: number): void => {
    queue.progress(id, fraction)
    progress.update({ fraction, detail: `${Math.round(fraction * 100)}%` })
  }

  void queue
    .enqueue(
      { id, kind: spec.kind, label, outputFile: spec.outputFile },
      spec.runner({ jobId: id, onProgress })
    )
    .then((result) => {
      progress.done()
      const job = queue.find(id)
      const state = job?.state ?? 'failed'
      if (state === 'done' && result.output) reveal(result.output)
      else if (state === 'cancelled') toast('info', 'capture-encode.cancelled', { label })
      else {
        toast('error', 'capture-encode.failed', {
          label,
          reason: job?.error ?? result.message ?? ''
        })
      }
      queue.prune()
    })
}

/** The runner every encode-mode job shares: one mpv, one output, one range. */
function encodeRunner(spec: {
  purpose: string
  args: readonly string[]
  outputFile: string
  range: { start: number; end: number }
  verify?: () => boolean
}): (h: { jobId: string; onProgress: (f: number) => void }) => JobRunner {
  return (h) =>
    async (_job, signal) => {
      const r = await runEncode(
        { engine: ctx.engine, log: ctx.log },
        {
          purpose: spec.purpose,
          args: spec.args,
          outputFile: spec.outputFile,
          startSec: spec.range.start,
          endSec: spec.range.end,
          signal,
          onProgress: h.onProgress,
          verify: spec.verify
        }
      )
      return { output: r.output }
    }
}

// ---------------------------------------------------------------------------
// C11 / C12 / C19 — clip export
// ---------------------------------------------------------------------------

/**
 * C19: probe, then fall back to libx264 — never a hardware default.
 *
 * The `_nvenc` / `_qsv` / `_amf` / `_mf` encoders are PRESENT in the build;
 * whether they initialise depends on the GPU and the driver, and the `--ovcopts`
 * key names differ per vendor. Quality at equal bitrate is worse than libx264,
 * which is why the UI labels them "Fast (GPU)" and not "Best".
 */
async function resolvePreset(): Promise<{ preset: ClipPreset; fellBack: boolean }> {
  const wanted = clipPreset(ctx.settings.get<string>('capture-encode.clipPreset'))
  if (!wanted.hardware) return { preset: wanted, fellBack: false }

  let ok = hardwareProbes.get(wanted.id)
  if (ok === undefined) {
    const dir = ctx.paths.tempJobDir('capture-encode')
    fs.mkdirSync(dir, { recursive: true })
    const probeOut = path.join(dir, `probe-${wanted.id}.mp4`)
    try {
      ok = await probeEncoder(
        { engine: ctx.engine, log: ctx.log },
        { purpose: 'encode-probe', args: hardwareProbeArgs(wanted, probeOut), outputFile: probeOut }
      )
    } catch (e) {
      ctx.log.warn(`encoder probe ${wanted.id} failed:`, (e as Error).message)
      ok = false
    }
    hardwareProbes.set(wanted.id, ok)
    ctx.log.info(`encoder ${wanted.vcodec}: ${ok ? 'usable' : 'not usable on this machine'}`)
  }
  return ok ? { preset: wanted, fellBack: false } : { preset: clipPreset(HARDWARE_FALLBACK), fellBack: true }
}

/**
 * C12, assembled from the PLAYING instance. Every field is a read.
 *
 * "Muxing subtitles as a soft track is NOT possible" — encode mode has no
 * subtitle muxing at all, so this is burn-in or nothing and the setting's
 * description says so rather than implying a third option exists.
 */
function subtitleCarry(): {
  burn: boolean
  sid: number | false | undefined
  subDelay: number | undefined
  subScale: number | undefined
} {
  const wanted = ctx.settings.get<boolean>('capture-encode.burnSubs')
  return {
    burn: wanted && ctx.mpv.peek<boolean>('sub-visibility') !== false,
    sid: ctx.mpv.peek<number | false>('sid'),
    subDelay: ctx.mpv.peek<number>('sub-delay'),
    subScale: ctx.mpv.peek<number>('sub-scale')
  }
}

async function exportClip(): Promise<void> {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('whole')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const { preset, fellBack } = await resolvePreset()
  if (fellBack) toast('info', 'capture-encode.hwFellBack')

  const out = outputPath('video', `${stampSeconds(range.start)}-${stampSeconds(range.end)}`, preset.ext)
  const width = ctx.settings.get<number>('capture-encode.clipWidth')
  const args = clipArgs({
    file,
    startSec: range.start,
    endSec: range.end,
    outputFile: out,
    preset,
    quality: ctx.settings.get<number>('capture-encode.clipQuality'),
    width: width > 0 ? width : undefined,
    aid: ctx.mpv.peek<number | false>('aid'),
    subs: subtitleCarry()
  })

  submit({
    kind: 'clip',
    labelKey: 'capture-encode.exportClip',
    outputFile: out,
    detail: `${preset.vcodec} · ${stampSeconds(range.end - range.start)}`,
    runner: encodeRunner({ purpose: 'encode-clip', args, outputFile: out, range })
  })
}

// ---------------------------------------------------------------------------
// C16 / A46 — audio extraction
// ---------------------------------------------------------------------------

function extractAudio(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('whole')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const fmt = audioFormat(ctx.settings.get<string>('capture-encode.audioFormat'))
  const out = outputPath('audio', `${stampSeconds(range.start)}-${stampSeconds(range.end)}`, fmt.ext)
  const args = audioArgs({
    file,
    startSec: range.start,
    endSec: range.end,
    outputFile: out,
    format: fmt,
    aid: ctx.mpv.peek<number | false>('aid')
  })
  submit({
    kind: 'audio',
    labelKey: 'capture-encode.extractAudio',
    outputFile: out,
    detail: `${fmt.codec} · ${stampSeconds(range.end - range.start)}`,
    runner: encodeRunner({ purpose: 'encode-audio', args, outputFile: out, range })
  })
}

// ---------------------------------------------------------------------------
// C14 / C15 — GIF and animated WebP
// ---------------------------------------------------------------------------

function exportGif(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('short')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const cap = ctx.settings.get<number>('capture-encode.gifMaxSeconds')
  if (range.end - range.start > cap) {
    // C14: "show an estimate and cap duration". A 30 s GIF at 480 px is ~40 MB,
    // which is not a file anybody can do anything with.
    return void toast('error', 'capture-encode.gifTooLong', { cap })
  }
  const fps = ctx.settings.get<number>('capture-encode.gifFps')
  const width = ctx.settings.get<number>('capture-encode.gifWidth')
  const out = outputPath('video', `${stampSeconds(range.start)}`, 'gif')
  const args = gifArgs({
    file,
    startSec: range.start,
    endSec: range.end,
    outputFile: out,
    fps,
    width,
    maxColors: ctx.settings.get<number>('capture-encode.gifColors'),
    dither: ctx.settings.get<string>('capture-encode.gifDither')
  })
  const mb = (estimateGifBytes(range.end - range.start, fps, width) / (1024 * 1024)).toFixed(1)
  submit({
    kind: 'gif',
    labelKey: 'capture-encode.exportGif',
    outputFile: out,
    detail: ctx.i18n.t('capture-encode.gifEstimate', { mb }),
    runner: encodeRunner({ purpose: 'encode-gif', args, outputFile: out, range })
  })
}

function exportWebp(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('short')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const out = outputPath('video', `${stampSeconds(range.start)}`, 'webp')
  const args = webpArgs({
    file,
    startSec: range.start,
    endSec: range.end,
    outputFile: out,
    fps: ctx.settings.get<number>('capture-encode.gifFps'),
    width: ctx.settings.get<number>('capture-encode.gifWidth'),
    quality: ctx.settings.get<number>('capture-encode.webpQuality'),
    lossless: false
  })
  submit({
    kind: 'webp',
    labelKey: 'capture-encode.exportWebp',
    outputFile: out,
    runner: encodeRunner({ purpose: 'encode-webp', args, outputFile: out, range })
  })
}

// ---------------------------------------------------------------------------
// C09 — offline burst frames
// ---------------------------------------------------------------------------

function burstFrames(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('whole')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const format = ctx.settings.get<string>('capture-encode.burstFormat') === 'jpg' ? 'jpg' : 'png'
  const dir = path.join(targetDir('video'), `${sourceStem()}_frames_${stampSeconds(range.start)}`)
  fs.mkdirSync(dir, { recursive: true })
  // image2 needs the counter in the name; the first frame is what we verify on.
  const pattern = path.join(dir, `frame_%04d.${format}`)
  const firstFrame = path.join(dir, `frame_0001.${format}`)

  const args = burstArgs({
    file,
    startSec: range.start,
    endSec: range.end,
    outputPattern: pattern,
    format,
    intervalSec: ctx.settings.get<number>('capture-encode.burstIntervalSec'),
    width: ctx.settings.get<number>('capture-encode.burstWidth'),
    jpegQscale: ctx.settings.get<number>('capture-encode.burstJpegQscale'),
    burnSubs: ctx.settings.get<boolean>('capture-encode.burnSubs')
  })
  submit({
    kind: 'burst',
    labelKey: 'capture-encode.burstFrames',
    outputFile: firstFrame,
    detail: path.basename(dir),
    runner: encodeRunner({
      purpose: 'encode-burst',
      args,
      outputFile: firstFrame,
      range,
      // The name we passed contains `%04d` and will never exist; the first frame
      // is the honest proof that the job produced something.
      verify: () => {
        try {
          return fs.readdirSync(dir).some((f) => f.endsWith(`.${format}`))
        } catch {
          return false
        }
      }
    })
  })
}

// ---------------------------------------------------------------------------
// C10 — the contact sheet
// ---------------------------------------------------------------------------

/**
 * Ships WITHOUT per-tile timestamps, and that is a blocked feature rather than
 * an omission — see `sheetArgs()` in encode-args.ts. `drawtext` requires
 * `fontfile=`, a lavfi option cannot carry a Windows absolute path, and
 * `ctx.engine.spawn()` has no `cwd` to make a relative one resolvable.
 */
function contactSheet(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const dur = duration()
  if (dur <= 0) return void toast('error', 'capture-encode.needRange')

  const cols = ctx.settings.get<number>('capture-encode.sheetCols')
  const rows = ctx.settings.get<number>('capture-encode.sheetRows')
  const out = outputPath('video', `sheet_${cols}x${rows}`, 'png')
  const args = sheetArgs({
    file,
    outputFile: out,
    durationSec: dur,
    cols,
    rows,
    tileWidth: ctx.settings.get<number>('capture-encode.sheetTileWidth'),
    burnSubs: false
  })
  submit({
    kind: 'sheet',
    labelKey: 'capture-encode.contactSheet',
    outputFile: out,
    detail: `${cols}x${rows}`,
    runner: encodeRunner({
      purpose: 'encode-sheet',
      args,
      outputFile: out,
      range: { start: 0, end: dur }
    })
  })
}

// ---------------------------------------------------------------------------
// C13 — the lossless cut, out of the demuxer cache
// ---------------------------------------------------------------------------

/** A dump can only contain what is in the cache; below this it is pointless. */
const MIN_USEFUL_CACHE_BYTES = 256 * 1024 * 1024

/**
 * C13, and it is labelled "fast lossless cut (approximate edges)" for three
 * measured reasons rather than modesty:
 *
 *  - only what is IN the cache can be dumped — with default cache settings the
 *    command produced a **636-byte empty file**, and with a 1 GiB cache a valid
 *    775 KB MKV instantly;
 *  - cut points land on keyframes and "the end may be slightly damaged";
 *  - a large dump **freezes the player** while it writes. mpv calls the whole
 *    feature experimental.
 *
 * ITS PRECONDITION IS NOT THIS MODULE'S TO SET, and that is a real gap. C13
 * requires the PLAYING mpv to run with `--cache=yes
 * --demuxer-max-bytes=1GiB --demuxer-max-back-bytes=1GiB
 * --demuxer-readahead-secs=600`. All four of those properties belong to **M35
 * stream-open** in `modules.json`, M35 is not implemented in this build, and
 * `capture-encode`'s row lists none of them in `requestsProperties` — so
 * contributing the spawn args would be a boot error ("an option follows its
 * property's owner", §4) and asking for them would need a manifest edit this
 * module may not make. What is left is to READ the cache size and refuse
 * honestly, which is what happens below.
 */
async function losslessCut(): Promise<void> {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const range = exportRange('whole')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const maxBytes = await ctx.mpv.get<number>('demuxer-max-bytes').catch(() => 0)
  if (typeof maxBytes !== 'number' || maxBytes < MIN_USEFUL_CACHE_BYTES) {
    return void toast('error', 'capture-encode.cacheTooSmall', {
      mb: Math.round((typeof maxBytes === 'number' ? maxBytes : 0) / (1024 * 1024))
    })
  }

  const out = outputPath('video', `cut_${stampSeconds(range.start)}`, 'mkv')
  toast('info', 'capture-encode.cutWorking')
  try {
    const ab = abRange()
    if (ab) {
      /**
       * `ab-loop-dump-cache` takes only the filename and reads M26's A-B points
       * itself, which is why it is M23's command but M26's properties.
       *
       * The spec pairs it with `ab-loop-align-cache` to tidy the edges first —
       * and that command is **M26's** in `modules.json` with **no mediator**, so
       * there is no sanctioned way to call it from here. Reported as a finding;
       * the consequence is that the edges are as approximate as `dump-cache`'s
       * own keyframe rounding, which the label already promises.
       */
      await ctx.mpv.command(['ab-loop-dump-cache', mpvPath(out)])
    } else {
      await ctx.mpv.command(['dump-cache', range.start, range.end, mpvPath(out)])
    }
  } catch (e) {
    return void toast('error', 'capture-encode.failed', {
      label: ctx.i18n.t('capture-encode.losslessCut'),
      reason: (e as Error).message
    })
  }

  // The 636-byte empty file is the documented failure, so the size is checked
  // rather than the absence of an error.
  let size = 0
  try {
    size = fs.statSync(out).size
  } catch {
    size = 0
  }
  if (size < 4096) {
    fs.rmSync(out, { force: true })
    return void toast('error', 'capture-encode.cutEmpty')
  }
  reveal(out)
}

/** C13's other half: stop a continuous dump. */
async function stopCacheDump(): Promise<void> {
  try {
    await ctx.mpv.command(['dump-cache', 0, 0, ''])
    toast('info', 'capture-encode.cutStopped')
  } catch (e) {
    toast('error', 'capture-encode.failed', {
      label: ctx.i18n.t('capture-encode.stopCacheDump'),
      reason: (e as Error).message
    })
  }
}

// ---------------------------------------------------------------------------
// C17 / R21 — live stream recording
// ---------------------------------------------------------------------------

/**
 * C17, and the important half of this row is verified-NEGATIVE:
 * **`stream-record` does nothing for local files.** With the default cache it
 * produced a 0-byte file; with an 800 MiB cache, no file at all — it "will write
 * only data that is appended at the end of the cache", which for a
 * fully-buffered local file is nothing. So the command is enabled only while a
 * network source is playing, and `ctx.mpv.isNetworkSource` is the authority.
 *
 * Two further documented limits are in the setting's description rather than
 * discovered by the user: the output container generally must match the input,
 * and seeking or switching tracks during recording "might result in recording
 * being stopped and/or broken files".
 */
function recordingTo(): string | null {
  const v = ctx.mpv.peek<string>('stream-record')
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function toggleStreamRecord(): Promise<void> {
  if (!ctx.mpv.isNetworkSource) return void toast('error', 'capture-encode.recNeedsStream')
  const active = recordingTo()
  if (active) {
    await ctx.mpv.set('stream-record', '')
    toast('info', 'capture-encode.recStopped', { name: path.basename(active) })
    return
  }
  const ext = ctx.settings.get<string>('capture-encode.streamRecordExt') || 'mkv'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = outputPath('video', `rec_${stamp}`, ext)
  await ctx.mpv.set('stream-record', mpvPath(out))
  toast('info', 'capture-encode.recStarted', { name: path.basename(out) })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const enumOptions = <T extends { id: string }>(
  rows: readonly T[],
  prefix: string
): ReadonlyArray<{ value: string; labelKey: string }> =>
  rows.map((r) => ({ value: r.id, labelKey: `capture-encode.${prefix}.${r.id}` }))

function descriptors(): SettingDescriptor[] {
  return [
    {
      id: 'capture-encode.videoDir',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.videoDirLabel',
      descriptionKey: 'capture-encode.videoDirDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      keywords: ['내보내기', '클립', 'export', 'clip', 'folder'],
      order: 40
    },
    {
      id: 'capture-encode.audioDir',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.audioDirLabel',
      descriptionKey: 'capture-encode.audioDirDesc',
      type: { kind: 'path', mode: 'directory' },
      default: '',
      keywords: ['음원 추출', 'audio', 'extract', 'folder'],
      order: 41
    },
    {
      id: 'capture-encode.clipPreset',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipPresetLabel',
      descriptionKey: 'capture-encode.clipPresetDesc',
      type: { kind: 'enum', options: enumOptions(CLIP_PRESETS, 'preset') },
      default: 'h264-mp4',
      keywords: ['코덱', 'codec', 'x264', 'x265', 'vp9', 'av1', 'nvenc'],
      order: 42
    },
    {
      id: 'capture-encode.clipQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipQualityLabel',
      descriptionKey: 'capture-encode.clipQualityDesc',
      type: { kind: 'int', min: 0, max: 51, step: 1 },
      default: 20,
      keywords: ['crf', '품질', 'quality'],
      order: 43
    },
    {
      id: 'capture-encode.clipWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.clipWidthLabel',
      descriptionKey: 'capture-encode.clipWidthDesc',
      type: { kind: 'int', min: 0, max: 3840, step: 2 },
      default: 0,
      advanced: true,
      keywords: ['해상도', 'resolution', 'scale'],
      order: 44
    },
    {
      id: 'capture-encode.burnSubs',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burnSubsLabel',
      descriptionKey: 'capture-encode.burnSubsDesc',
      type: { kind: 'bool' },
      default: true,
      keywords: ['자막', 'subtitle', 'burn'],
      order: 45
    },
    {
      id: 'capture-encode.audioFormat',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.audioFormatLabel',
      type: { kind: 'enum', options: enumOptions(AUDIO_FORMATS, 'audio') },
      default: 'mp3',
      keywords: ['mp3', 'flac', 'wav', 'opus', 'm4a'],
      order: 46
    },
    {
      id: 'capture-encode.gifFps',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifFpsLabel',
      type: { kind: 'int', min: 5, max: 30, step: 1 },
      default: 15,
      keywords: ['gif', 'fps'],
      order: 47
    },
    {
      id: 'capture-encode.gifWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifWidthLabel',
      type: { kind: 'int', min: 160, max: 960, step: 16 },
      default: 480,
      keywords: ['gif', 'width', '너비'],
      order: 48
    },
    {
      id: 'capture-encode.gifColors',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifColorsLabel',
      descriptionKey: 'capture-encode.gifColorsDesc',
      type: { kind: 'int', min: 32, max: 256, step: 16 },
      default: 192,
      advanced: true,
      keywords: ['gif', 'palette', '팔레트'],
      order: 49
    },
    {
      id: 'capture-encode.gifDither',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifDitherLabel',
      type: {
        kind: 'enum',
        options: GIF_DITHERS.map((d) => ({ value: d, labelKey: `capture-encode.dither.${d}` }))
      },
      default: 'sierra2_4a',
      advanced: true,
      keywords: ['gif', 'dither', '디더링'],
      order: 50
    },
    {
      id: 'capture-encode.gifMaxSeconds',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.gifMaxSecondsLabel',
      descriptionKey: 'capture-encode.gifMaxSecondsDesc',
      type: { kind: 'int', min: 1, max: 60, step: 1 },
      default: 15,
      keywords: ['gif', 'duration', '길이'],
      order: 51
    },
    {
      id: 'capture-encode.webpQuality',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.webpQualityLabel',
      type: { kind: 'int', min: 0, max: 100, step: 5 },
      default: 75,
      advanced: true,
      keywords: ['webp', 'quality'],
      order: 52
    },
    {
      id: 'capture-encode.burstFormat',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstFormatLabel',
      type: {
        kind: 'enum',
        options: [
          { value: 'png', labelKey: 'capture-encode.burstFormat.png' },
          { value: 'jpg', labelKey: 'capture-encode.burstFormat.jpg' }
        ]
      },
      default: 'png',
      keywords: ['연속 캡처', 'burst', 'png', 'jpg'],
      order: 53
    },
    {
      id: 'capture-encode.burstIntervalSec',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstIntervalLabel',
      type: { kind: 'float', min: 0.2, max: 300, step: 0.2 },
      default: 5,
      keywords: ['간격', 'interval', 'burst'],
      order: 54
    },
    {
      id: 'capture-encode.burstWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstWidthLabel',
      type: { kind: 'int', min: 160, max: 3840, step: 16 },
      default: 1280,
      advanced: true,
      keywords: ['burst', 'width'],
      order: 55
    },
    {
      id: 'capture-encode.burstJpegQscale',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.burstJpegQscaleLabel',
      descriptionKey: 'capture-encode.burstJpegQscaleDesc',
      type: { kind: 'int', min: 2, max: 31, step: 1 },
      default: 3,
      advanced: true,
      mpvOption: 'ovcopts=global_quality',
      keywords: ['jpeg', 'qscale', '품질'],
      order: 56
    },
    {
      id: 'capture-encode.sheetCols',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetColsLabel',
      type: { kind: 'int', min: 2, max: 8, step: 1 },
      default: 4,
      keywords: ['thumbnail', '장면', 'sheet', 'grid'],
      order: 57
    },
    {
      id: 'capture-encode.sheetRows',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetRowsLabel',
      type: { kind: 'int', min: 2, max: 12, step: 1 },
      default: 5,
      keywords: ['thumbnail', 'sheet', 'grid'],
      order: 58
    },
    {
      id: 'capture-encode.sheetTileWidth',
      section: 'general',
      group: 'capture',
      labelKey: 'capture-encode.sheetTileWidthLabel',
      descriptionKey: 'capture-encode.sheetTileWidthDesc',
      type: { kind: 'int', min: 160, max: 640, step: 16 },
      default: 320,
      advanced: true,
      keywords: ['sheet', 'tile'],
      order: 59
    },
    {
      id: 'capture-encode.maxConcurrent',
      section: 'advanced',
      group: 'capture',
      labelKey: 'capture-encode.maxConcurrentLabel',
      descriptionKey: 'capture-encode.maxConcurrentDesc',
      type: { kind: 'int', min: 1, max: 2, step: 1 },
      default: 1,
      advanced: true,
      keywords: ['동시', 'queue', 'concurrent'],
      order: 60
    },
    {
      id: 'capture-encode.streamRecordExt',
      section: 'advanced',
      group: 'capture',
      labelKey: 'capture-encode.streamRecordExtLabel',
      descriptionKey: 'capture-encode.streamRecordExtDesc',
      type: {
        kind: 'enum',
        options: [
          { value: 'mkv', labelKey: 'capture-encode.rec.mkv' },
          { value: 'ts', labelKey: 'capture-encode.rec.ts' },
          { value: 'mp4', labelKey: 'capture-encode.rec.mp4' }
        ]
      },
      default: 'mkv',
      advanced: true,
      mpvOption: 'stream-record',
      keywords: ['녹화', 'record', 'stream'],
      order: 61
    }
  ]
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const KO: Record<string, string> = {
  'capture-encode.videoDirLabel': '클립·GIF 저장 폴더',
  'capture-encode.videoDirDesc':
    '비워 두면 원본 파일과 같은 폴더에 저장합니다. 쓸 수 없으면 비디오\\RLPlayer(휴대용 모드에서는 exe 옆의 Export)를 씁니다.',
  'capture-encode.audioDirLabel': '추출한 소리 저장 폴더',
  'capture-encode.audioDirDesc': '비워 두면 원본 파일과 같은 폴더, 그다음 음악\\RLPlayer 순서입니다.',
  'capture-encode.clipPresetLabel': '클립 내보내기 프리셋',
  'capture-encode.clipPresetDesc':
    'GPU 프리셋은 쓰기 전에 실제로 초기화되는지 한 번 검사하고, 실패하면 libx264로 되돌립니다. 같은 비트레이트에서 화질은 libx264가 더 좋습니다.',
  'capture-encode.clipQualityLabel': '클립 품질 (낮을수록 고화질)',
  'capture-encode.clipQualityDesc':
    'crf·cq·global_quality·qp 가운데 그 인코더가 쓰는 이름으로 전달됩니다. 20 전후가 눈에 거슬리지 않는 범위입니다.',
  'capture-encode.clipWidthLabel': '클립 가로 크기 (0 = 원본)',
  'capture-encode.clipWidthDesc': '세로는 비율을 맞춰 짝수로 자동 계산합니다.',
  'capture-encode.burnSubsLabel': '자막을 영상에 새겨 넣기',
  'capture-encode.burnSubsDesc':
    '인코딩 모드에는 자막 트랙을 담는 기능이 없습니다. 새겨 넣기 아니면 없음, 둘 중 하나입니다.',
  'capture-encode.audioFormatLabel': '소리 추출 형식',
  'capture-encode.gifFpsLabel': 'GIF·WebP 초당 프레임',
  'capture-encode.gifWidthLabel': 'GIF·WebP 가로 크기',
  'capture-encode.gifColorsLabel': 'GIF 팔레트 색 수',
  'capture-encode.gifColorsDesc': '한 번의 패스로 팔레트를 만들고 바로 적용합니다.',
  'capture-encode.gifDitherLabel': 'GIF 디더링',
  'capture-encode.gifMaxSecondsLabel': 'GIF 최대 길이 (초)',
  'capture-encode.gifMaxSecondsDesc':
    'A-B 구간이 없으면 현재 위치에서 이 길이만큼 만듭니다. 480픽셀 15fps에서 2초가 약 2.8MB입니다.',
  'capture-encode.webpQualityLabel': 'WebP 품질',
  'capture-encode.burstFormatLabel': '연속 캡처 형식',
  'capture-encode.burstIntervalLabel': '연속 캡처 간격 (초)',
  'capture-encode.burstWidthLabel': '연속 캡처 가로 크기',
  'capture-encode.burstJpegQscaleLabel': 'JPEG 품질 (2 = 최고)',
  'capture-encode.burstJpegQscaleDesc': 'libavcodec 단위로 환산해 넘깁니다 (q × 118).',
  'capture-encode.sheetColsLabel': '장면 모아보기 열 수',
  'capture-encode.sheetRowsLabel': '장면 모아보기 행 수',
  'capture-encode.sheetTileWidthLabel': '장면 모아보기 칸 너비',
  'capture-encode.sheetTileWidthDesc':
    '이 빌드에서는 칸마다 시간을 찍지 못합니다. drawtext에 필요한 글꼴 경로를 필터 그래프에 넣을 방법이 없습니다.',
  'capture-encode.maxConcurrentLabel': '동시에 처리할 작업 수',
  'capture-encode.maxConcurrentDesc':
    '1을 권합니다. libx265·libsvtav1은 모든 코어를 다 쓰기 때문에 재생이 끊길 수 있습니다.',
  'capture-encode.streamRecordExtLabel': '스트림 녹화 컨테이너',
  'capture-encode.streamRecordExtDesc':
    '입력과 같은 컨테이너를 써야 하는 경우가 많습니다. 녹화 중 탐색하거나 트랙을 바꾸면 녹화가 끊기거나 파일이 깨질 수 있습니다.',

  'capture-encode.preset.h264-mp4': 'H.264 MP4 (호환성)',
  'capture-encode.preset.hevc-mkv': 'HEVC MKV (용량 절약)',
  'capture-encode.preset.vp9-webm': 'VP9 WebM',
  'capture-encode.preset.av1-mkv': 'AV1 MKV (느림)',
  'capture-encode.preset.nvenc-mp4': '빠름 (NVIDIA GPU)',
  'capture-encode.preset.qsv-mp4': '빠름 (Intel GPU)',
  'capture-encode.preset.amf-mp4': '빠름 (AMD GPU)',
  'capture-encode.preset.mf-mp4': '빠름 (Windows 공용)',
  'capture-encode.audio.mp3': 'MP3 192kbps',
  'capture-encode.audio.wav': 'WAV (무손실, 큼)',
  'capture-encode.audio.flac': 'FLAC (무손실)',
  'capture-encode.audio.opus': 'Opus',
  'capture-encode.audio.m4a': 'M4A (AAC)',
  'capture-encode.audio.mka': 'MKA (FLAC)',
  'capture-encode.dither.sierra2_4a': 'Sierra2 4A (기본)',
  'capture-encode.dither.sierra2': 'Sierra2',
  'capture-encode.dither.floyd_steinberg': 'Floyd–Steinberg',
  'capture-encode.dither.bayer': 'Bayer',
  'capture-encode.dither.none': '없음',
  'capture-encode.burstFormat.png': 'PNG (무손실)',
  'capture-encode.burstFormat.jpg': 'JPEG (작음)',
  'capture-encode.rec.mkv': 'MKV',
  'capture-encode.rec.ts': 'TS',
  'capture-encode.rec.mp4': 'MP4',

  'capture-encode.exportClip': '구간 클립 내보내기',
  'capture-encode.extractAudio': '구간 소리 추출',
  'capture-encode.exportGif': 'GIF 만들기',
  'capture-encode.exportWebp': '움직이는 WebP 만들기',
  'capture-encode.burstFrames': '연속 이미지 저장 (빠른 일괄)',
  'capture-encode.contactSheet': '장면 모아보기 이미지',
  'capture-encode.losslessCut': '빠른 무손실 잘라내기 (경계 대략)',
  'capture-encode.stopCacheDump': '캐시 기록 멈추기',
  'capture-encode.toggleStreamRecord': '스트림 녹화 켜기/끄기',
  'capture-encode.cancel': '취소',
  'capture-encode.cancelAll': '진행 중인 내보내기 모두 취소',
  'capture-encode.menuTitle': '내보내기',

  'capture-encode.jobRunning': '내보내는 중',
  'capture-encode.started': '{label} 시작 — {detail}',
  'capture-encode.finished': '{name}{을/를} 저장했습니다',
  'capture-encode.openFolder': '폴더 열기',
  'capture-encode.cancelled': '{label}{을/를} 취소했습니다',
  'capture-encode.failed': '{label} 실패: {reason}',
  'capture-encode.needLocalFile': '로컬 파일을 재생하는 중에만 쓸 수 있습니다',
  'capture-encode.needRange': '먼저 A-B 구간을 지정하거나 파일 길이를 확인해 주세요',
  'capture-encode.hwFellBack': 'GPU 인코더를 쓸 수 없어 libx264로 진행합니다',
  'capture-encode.gifTooLong': 'GIF는 {cap}초까지만 만듭니다. A-B 구간을 줄여 주세요',
  'capture-encode.gifEstimate': '예상 약 {mb}MB',
  'capture-encode.cacheTooSmall':
    '무손실 잘라내기는 큰 디먹서 캐시가 필요합니다 (현재 {mb}MB). 스트림 캐시 설정은 이 모듈이 정할 수 없습니다',
  'capture-encode.cutWorking': '캐시에서 잘라내는 중 — 잠시 재생이 멈출 수 있습니다',
  'capture-encode.cutEmpty': '캐시에 담긴 구간이 없어 빈 파일이 나왔습니다',
  'capture-encode.cutStopped': '캐시 기록을 멈췄습니다',
  'capture-encode.recNeedsStream': '스트림 녹화는 네트워크 원본에서만 동작합니다',
  'capture-encode.recStarted': '{name}{으로/로} 녹화를 시작했습니다',
  'capture-encode.recStopped': '녹화를 멈췄습니다 — {name}',
  'capture-encode.noJobs': '진행 중인 작업이 없습니다'
}

const EN: Record<string, string> = {
  'capture-encode.videoDirLabel': 'Clip and GIF folder',
  'capture-encode.videoDirDesc':
    "Empty means beside the source file. If that is not writable, Videos\\RLPlayer (or Export beside the exe in portable mode).",
  'capture-encode.audioDirLabel': 'Extracted audio folder',
  'capture-encode.audioDirDesc': 'Empty means beside the source file, then Music\\RLPlayer.',
  'capture-encode.clipPresetLabel': 'Clip export preset',
  'capture-encode.clipPresetDesc':
    'A GPU preset is probed once for whether it actually initialises, and falls back to libx264 if not. At equal bitrate libx264 still looks better.',
  'capture-encode.clipQualityLabel': 'Clip quality (lower is better)',
  'capture-encode.clipQualityDesc':
    'Passed as crf, cq, global_quality or qp — whichever name that encoder uses. Around 20 is visually clean.',
  'capture-encode.clipWidthLabel': 'Clip width (0 = source)',
  'capture-encode.clipWidthDesc': 'Height follows the aspect ratio and is forced even.',
  'capture-encode.burnSubsLabel': 'Burn subtitles into the export',
  'capture-encode.burnSubsDesc':
    'Encode mode cannot mux a subtitle track at all. It is burn-in or nothing.',
  'capture-encode.audioFormatLabel': 'Audio extraction format',
  'capture-encode.gifFpsLabel': 'GIF / WebP frames per second',
  'capture-encode.gifWidthLabel': 'GIF / WebP width',
  'capture-encode.gifColorsLabel': 'GIF palette colours',
  'capture-encode.gifColorsDesc': 'The palette is generated and applied in one pass.',
  'capture-encode.gifDitherLabel': 'GIF dithering',
  'capture-encode.gifMaxSecondsLabel': 'Maximum GIF length (seconds)',
  'capture-encode.gifMaxSecondsDesc':
    'With no A-B range, this much is taken from the current position. 2 s at 480 px and 15 fps is about 2.8 MB.',
  'capture-encode.webpQualityLabel': 'WebP quality',
  'capture-encode.burstFormatLabel': 'Consecutive image format',
  'capture-encode.burstIntervalLabel': 'Consecutive image interval (seconds)',
  'capture-encode.burstWidthLabel': 'Consecutive image width',
  'capture-encode.burstJpegQscaleLabel': 'JPEG quality (2 = best)',
  'capture-encode.burstJpegQscaleDesc': "Converted to libavcodec's units on the way out (q × 118).",
  'capture-encode.sheetColsLabel': 'Contact sheet columns',
  'capture-encode.sheetRowsLabel': 'Contact sheet rows',
  'capture-encode.sheetTileWidthLabel': 'Contact sheet tile width',
  'capture-encode.sheetTileWidthDesc':
    'Per-tile timestamps are unavailable in this build: drawtext needs a font path, and a filter graph cannot carry one.',
  'capture-encode.maxConcurrentLabel': 'Jobs at once',
  'capture-encode.maxConcurrentDesc':
    'Keep this at 1. libx265 and libsvtav1 will use every core and playback is what must not stutter.',
  'capture-encode.streamRecordExtLabel': 'Stream recording container',
  'capture-encode.streamRecordExtDesc':
    'The container generally has to match the input. Seeking or switching tracks while recording may stop the recording or break the file.',

  'capture-encode.preset.h264-mp4': 'H.264 MP4 (compatible)',
  'capture-encode.preset.hevc-mkv': 'HEVC MKV (smaller)',
  'capture-encode.preset.vp9-webm': 'VP9 WebM',
  'capture-encode.preset.av1-mkv': 'AV1 MKV (slow)',
  'capture-encode.preset.nvenc-mp4': 'Fast (NVIDIA GPU)',
  'capture-encode.preset.qsv-mp4': 'Fast (Intel GPU)',
  'capture-encode.preset.amf-mp4': 'Fast (AMD GPU)',
  'capture-encode.preset.mf-mp4': 'Fast (Windows generic)',
  'capture-encode.audio.mp3': 'MP3 192 kbps',
  'capture-encode.audio.wav': 'WAV (lossless, large)',
  'capture-encode.audio.flac': 'FLAC (lossless)',
  'capture-encode.audio.opus': 'Opus',
  'capture-encode.audio.m4a': 'M4A (AAC)',
  'capture-encode.audio.mka': 'MKA (FLAC)',
  'capture-encode.dither.sierra2_4a': 'Sierra2 4A (default)',
  'capture-encode.dither.sierra2': 'Sierra2',
  'capture-encode.dither.floyd_steinberg': 'Floyd–Steinberg',
  'capture-encode.dither.bayer': 'Bayer',
  'capture-encode.dither.none': 'None',
  'capture-encode.burstFormat.png': 'PNG (lossless)',
  'capture-encode.burstFormat.jpg': 'JPEG (small)',
  'capture-encode.rec.mkv': 'MKV',
  'capture-encode.rec.ts': 'TS',
  'capture-encode.rec.mp4': 'MP4',

  'capture-encode.exportClip': 'Export clip of the range',
  'capture-encode.extractAudio': 'Extract audio of the range',
  'capture-encode.exportGif': 'Export GIF',
  'capture-encode.exportWebp': 'Export animated WebP',
  'capture-encode.burstFrames': 'Consecutive images (offline batch)',
  'capture-encode.contactSheet': 'Contact sheet image',
  'capture-encode.losslessCut': 'Fast lossless cut (approximate edges)',
  'capture-encode.stopCacheDump': 'Stop cache recording',
  'capture-encode.toggleStreamRecord': 'Toggle stream recording',
  'capture-encode.cancel': 'Cancel',
  'capture-encode.cancelAll': 'Cancel every running export',
  'capture-encode.menuTitle': 'Export',

  'capture-encode.jobRunning': 'Exporting',
  'capture-encode.started': '{label} started — {detail}',
  'capture-encode.finished': 'Saved {name}',
  'capture-encode.openFolder': 'Open folder',
  'capture-encode.cancelled': '{label} cancelled',
  'capture-encode.failed': '{label} failed: {reason}',
  'capture-encode.needLocalFile': 'Only available while a local file is playing',
  'capture-encode.needRange': 'Set an A-B range first, or wait for the duration to be known',
  'capture-encode.hwFellBack': 'The GPU encoder is unusable here; continuing with libx264',
  'capture-encode.gifTooLong': 'GIFs are capped at {cap} s. Shorten the A-B range',
  'capture-encode.gifEstimate': 'about {mb} MB',
  'capture-encode.cacheTooSmall':
    'A lossless cut needs a large demuxer cache (currently {mb} MB), and this module does not own the cache settings',
  'capture-encode.cutWorking': 'Cutting from the cache — playback may pause briefly',
  'capture-encode.cutEmpty': 'Nothing of that range was in the cache, so the file came out empty',
  'capture-encode.cutStopped': 'Cache recording stopped',
  'capture-encode.recNeedsStream': 'Stream recording only works on a network source',
  'capture-encode.recStarted': 'Recording to {name}',
  'capture-encode.recStopped': 'Recording stopped — {name}',
  'capture-encode.noJobs': 'Nothing is running'
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const mod: FeatureModule = {
  id: 'capture-encode',
  // Copied verbatim from this module's docs/parity/modules.json row (§1).
  dependsOn: ['core-paths'],
  // C17/R21. The only property this module writes.
  ownsProperties: ['stream-record'],
  // §2.1: "capture owns everything that writes media to disk". C13.
  ownsCommands: ['ab-loop-dump-cache', 'dump-cache'],

  setup(c): void {
    ctx = c
    queue = new JobQueue(1, {
      onFinish: (job) => ctx.log.info(`job ${job.id} (${job.kind}) ${job.state}`)
    })

    ctx.settings.define(descriptors())
    queue.setMaxConcurrent(ctx.settings.get<number>('capture-encode.maxConcurrent'))
    ctx.settings.onChange<number>('capture-encode.maxConcurrent', (n) =>
      queue.setMaxConcurrent(n)
    )

    ctx.commands.register([
      {
        id: 'capture-encode.exportClip',
        labelKey: 'capture-encode.exportClip',
        category: 'capture',
        // C22's PotPlayer table, read out of its own English.ini: Alt+C is
        // "Record Video". Physical codes, always (P16).
        defaults: { default: ['Alt+KeyC'], potplayer: ['Alt+KeyC'], mpv: [] },
        enabledWhen: localReady,
        run: () => void exportClip()
      },
      {
        id: 'capture-encode.extractAudio',
        labelKey: 'capture-encode.extractAudio',
        category: 'capture',
        // C22: Shift+G is "Record Audio".
        defaults: { default: ['Shift+KeyG'], potplayer: ['Shift+KeyG'], mpv: [] },
        enabledWhen: localReady,
        run: extractAudio
      },
      {
        id: 'capture-encode.exportGif',
        labelKey: 'capture-encode.exportGif',
        category: 'capture',
        defaults: { default: ['Ctrl+Shift+KeyG'], potplayer: [], mpv: [] },
        enabledWhen: localReady,
        run: exportGif
      },
      {
        id: 'capture-encode.exportWebp',
        labelKey: 'capture-encode.exportWebp',
        category: 'capture',
        defaults: { default: [], potplayer: [], mpv: [] },
        enabledWhen: localReady,
        run: exportWebp
      },
      {
        id: 'capture-encode.burstFrames',
        labelKey: 'capture-encode.burstFrames',
        category: 'capture',
        // NOT Ctrl+G: C22 gives that to "Capture Consecutive Images", which is
        // C08's LIVE burst and belongs to M22. This is C09, the offline batch.
        defaults: { default: ['Ctrl+Alt+KeyG'], potplayer: [], mpv: [] },
        enabledWhen: localReady,
        run: burstFrames
      },
      {
        id: 'capture-encode.contactSheet',
        labelKey: 'capture-encode.contactSheet',
        category: 'capture',
        // C22: Alt+N is "Create Thumbnail Image".
        defaults: { default: ['Alt+KeyN'], potplayer: ['Alt+KeyN'], mpv: [] },
        enabledWhen: localReady,
        run: contactSheet
      },
      {
        id: 'capture-encode.losslessCut',
        labelKey: 'capture-encode.losslessCut',
        category: 'capture',
        defaults: { default: [], potplayer: [], mpv: [] },
        enabledWhen: localReady,
        run: () => void losslessCut()
      },
      {
        id: 'capture-encode.stopCacheDump',
        labelKey: 'capture-encode.stopCacheDump',
        category: 'capture',
        defaults: { default: [], potplayer: [], mpv: [] },
        run: () => void stopCacheDump()
      },
      {
        id: 'capture-encode.toggleStreamRecord',
        labelKey: 'capture-encode.toggleStreamRecord',
        category: 'capture',
        defaults: { default: ['Alt+KeyR'], potplayer: [], mpv: [] },
        // C17 is verified-negative for local files, so the item is disabled
        // rather than silently doing nothing.
        enabledWhen: () => ctx.mpv.isNetworkSource,
        run: () => void toggleStreamRecord()
      },
      {
        id: 'capture-encode.cancelAll',
        labelKey: 'capture-encode.cancelAll',
        category: 'capture',
        defaults: { default: [], potplayer: [], mpv: [] },
        enabledWhen: () => queue.activeCount > 0,
        run: () => {
          const n = queue.cancelAll()
          if (n === 0) toast('info', 'capture-encode.noJobs')
        }
      }
    ])

    ctx.menu.contribute({
      id: 'capture-encode.menu',
      labelKey: 'capture-encode.menuTitle',
      // 62: M22 capture-still holds 60 and the `capture` root's base order is
      // also 60, so this section sits just after the still-capture group. Every
      // cross-module ordering namespace rejects a tie rather than resolving it
      // by module discovery order.
      order: 62,
      items: [
        { commandId: 'capture-encode.exportClip' },
        { commandId: 'capture-encode.extractAudio' },
        { type: 'separator' },
        { commandId: 'capture-encode.exportGif' },
        { commandId: 'capture-encode.exportWebp' },
        { type: 'separator' },
        { commandId: 'capture-encode.burstFrames' },
        { commandId: 'capture-encode.contactSheet' },
        { type: 'separator' },
        { commandId: 'capture-encode.losslessCut' },
        { commandId: 'capture-encode.toggleStreamRecord' },
        { commandId: 'capture-encode.stopCacheDump' },
        { type: 'separator' },
        { commandId: 'capture-encode.cancelAll' }
      ]
    })

    /**
     * C17: a recording must never survive the file it belongs to.
     *
     * `stream-record` is spawn-surviving and file-agnostic — mpv keeps appending
     * to the same path across a `loadfile`, which for a playlist advance means
     * one file containing two programmes. Clearing it at every new file is the
     * only behaviour that matches what the user asked for.
     */
    ctx.mpv.afterFileLoaded(() => {
      if (recordingTo() !== null) void ctx.mpv.set('stream-record', '').catch(() => undefined)
    })

    ctx.i18n.register('ko', KO)
    ctx.i18n.register('en', EN)
  },

  async dispose(): Promise<void> {
    // Politeness, not the guarantee: `ctx.engine` reaps every secondary on the
    // quit path whether or not this runs, and has a synchronous exit reaper
    // behind that. Cancelling first means the queue does not start a new job
    // while the app is going down.
    queue?.cancelAll()
    if (recordingTo() !== null) await ctx.mpv.set('stream-record', '').catch(() => undefined)
  }
}

export default mod
