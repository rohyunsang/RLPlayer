import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import type { FeatureContext, FeatureModule } from '@shared/feature-api'
import {
  BURST_MAX_FRAMES,
  HARDWARE_FALLBACK,
  PROBE_SOURCE,
  audioArgs,
  audioFormat,
  burstArgs,
  burstFrameCount,
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
import { EN, KO, descriptors } from './declarations.ts'
import { JobQueue, type JobKind, type JobRunner, type JobState } from './job-queue.ts'
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
 * with no consumer. Re-measured this round and still true, so the resolution is
 * not to wait for it: the handle is driven anyway (it costs nothing and starts
 * working the day the wire is connected), and the progress a user can actually
 * SEE is this module's own `ctx.panel()` job list, fed by `capture-encode:jobs`
 * and cancelled by `capture-encode:cancel`. That is a fix inside this module's
 * own two directories rather than an edit to a core file. Two further cancels
 * exist because a queue with one job is not the only case: the toast action
 * (`ui:toastAction` IS wired end to end, preload sender included) and the
 * `capture-encode.cancelAll` command, which is in the menu and the keybind
 * editor.
 */

/**
 * ONE JOB, AS THE PANEL SEES IT.
 *
 * DUPLICATED IN `src/renderer/src/features/capture-encode/index.ts`, AND THAT IS
 * A REPORTED DEFECT RATHER THAN A CHOICE. §10 says a module's two halves share
 * `src/shared/features/<id>/`, "listed in your row's ownedFiles" — but only 3 of
 * the 40 feature rows in docs/parity/modules.json list one, and M23's row does
 * not. Creating `src/shared/features/capture-encode/wire.ts` would be a file
 * owned by nobody, which `check:partition` fails and `check:ownership` reports;
 * adding it to the row is a manifest edit this module may not make. So the shape
 * is written twice — the exact defect the shared directory exists to prevent.
 */
interface JobWire {
  readonly id: string
  readonly kind: JobKind
  readonly label: string
  readonly name: string
  readonly state: JobState
  readonly percent: number | null
  readonly error: string | null
}

function jobWire(): { jobs: JobWire[] } {
  return {
    jobs: queue.jobs().map((j) => ({
      id: j.id,
      kind: j.kind,
      label: j.label,
      name: path.basename(j.outputFile),
      state: j.state,
      percent: j.fraction === undefined ? null : Math.round(j.fraction * 100),
      error: j.error ?? null
    }))
  }
}

function pushJobs(): void {
  ctx.ipc.send('capture-encode:jobs', jobWire())
}
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
  /** The source `runEncode` will `loadfile`. Never a command-line argument. */
  source: string
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
          source: spec.source,
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
        {
          purpose: 'encode-probe',
          args: hardwareProbeArgs(wanted, probeOut),
          source: PROBE_SOURCE,
          outputFile: probeOut
        }
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
    runner: encodeRunner({ purpose: 'encode-clip', args, source: file, outputFile: out, range })
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
    runner: encodeRunner({ purpose: 'encode-audio', args, source: file, outputFile: out, range })
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
    runner: encodeRunner({ purpose: 'encode-gif', args, source: file, outputFile: out, range })
  })
}

function exportWebp(): void {
  if (!localReady()) return void toast('error', 'capture-encode.needLocalFile')
  const file = sourceFile() as string
  const range = exportRange('short')
  if (!range) return void toast('error', 'capture-encode.needRange')

  const out = outputPath('video', `${stampSeconds(range.start)}`, 'webp')
  const args = webpArgs({
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
    runner: encodeRunner({ purpose: 'encode-webp', args, source: file, outputFile: out, range })
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
  const interval = ctx.settings.get<number>('capture-encode.burstIntervalSec')
  /**
   * C09's range defaults to the WHOLE FILE, and encode mode runs faster than
   * realtime, so there is no moment in which a user notices that a two-hour film
   * at the default 5 s interval is about to become 1440 files. Refuse with the
   * number rather than fill a disk.
   */
  const frames = burstFrameCount(range.start, range.end, interval)
  if (frames > BURST_MAX_FRAMES) {
    return void toast('error', 'capture-encode.burstTooMany', {
      frames,
      max: BURST_MAX_FRAMES
    })
  }
  const dir = path.join(targetDir('video'), `${sourceStem()}_frames_${stampSeconds(range.start)}`)
  fs.mkdirSync(dir, { recursive: true })
  // image2 needs the counter in the name; the first frame is what we verify on.
  const pattern = path.join(dir, `frame_%04d.${format}`)
  const firstFrame = path.join(dir, `frame_0001.${format}`)

  const args = burstArgs({
    startSec: range.start,
    endSec: range.end,
    outputPattern: pattern,
    format,
    intervalSec: interval,
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
      source: file,
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
      source: file,
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
      // The panel is this module's own progress UI (see `submit`), so every
      // queue mutation is pushed. `onChange` fires on enqueue, start, each
      // distinct progress step and each terminal state.
      onChange: () => pushJobs(),
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
        id: 'capture-encode.showJobs',
        labelKey: 'capture-encode.showJobs',
        category: 'capture',
        defaults: { default: [], potplayer: [], mpv: [] },
        run: () => ctx.ipc.send('capture-encode:panel', { open: 'toggle' })
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

    /**
     * The renderer half's four channels. Nothing here is a second
     * implementation: `start` invokes the same command the menu and the keybind
     * editor invoke, so there is exactly one code path per feature.
     */
    ctx.ipc.handle<undefined, { jobs: JobWire[] }>('capture-encode:getJobs', () => jobWire())
    ctx.ipc.on<{ id: string }>('capture-encode:cancel', (req) => {
      if (typeof req?.id === 'string') queue.cancel(req.id)
    })
    ctx.ipc.on<undefined>('capture-encode:cancelAll', () => void queue.cancelAll())
    ctx.ipc.on<{ command: string }>('capture-encode:start', (req) => {
      const id = String(req?.command ?? '')
      // Only this module's own commands, and only ones that exist. A renderer
      // is not trusted to name a command: the panel is in this repo, but the
      // channel is reachable from any page the preload bridge serves.
      if (!id.startsWith('capture-encode.') || !ctx.commands.has(id)) {
        ctx.log.warn(`capture-encode:start refused '${id}'`)
        return
      }
      void ctx.commands.invoke(id).catch((e: Error) => ctx.log.warn(`${id} failed:`, e.message))
    })

    ctx.menu.contribute({
      id: 'capture-encode.menu',
      labelKey: 'capture-encode.menuTitle',
      // 62: M22 capture-still holds 60 and the `capture` root's base order is
      // also 60, so this section sits just after the still-capture group. Every
      // cross-module ordering namespace rejects a tie rather than resolving it
      // by module discovery order.
      order: 62,
      /**
       * WRAPPED IN AN ITEM THAT OWNS THE SUBMENU, because a contributed
       * section's own `labelKey` is not rendered anywhere.
       * `MenuService.contribute()` requires it, and `core/menu.ts`'s
       * `buildTemplate()` renders `section.items` and nothing else — the
       * `labelKey` is read only by the namespace check. Twelve flat items would
       * therefore have landed loose in the context-menu root with no title.
       * M22 hit the same thing one directory over and used the same shape; two
       * modules working around one unused required field is a finding, not a
       * house style.
       */
      items: [
        {
          labelKey: 'capture-encode.menuTitle',
          submenu: [
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
            { commandId: 'capture-encode.showJobs' },
            { commandId: 'capture-encode.cancelAll' }
          ]
        }
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
