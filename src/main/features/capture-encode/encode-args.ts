/**
 * M23 capture-encode — the PURE half: every mpv encode-mode command line this
 * module can produce, and nothing else.
 *
 * WHY THIS FILE HAS NO IMPORTS. Every string below is a literal transcription of
 * a §2.4 row that was verified end to end against the pinned mpv, and the only
 * way to keep it that way is to be able to test it without a process, a window
 * or an Electron import (§13). `runner.ts` turns these into a child; this file
 * only ever returns arrays of strings.
 *
 * THE HEADLINE, RECORDED SO NOBODY RE-ADDS 80 MB: **ffmpeg is not bundled and is
 * not needed.** §7.3 R-5 is explicit — mpv's own encode mode covers clip export
 * (C11), GIF (C14), animated WebP (C15), contact sheets (C10), burst frames
 * (C09) and audio extraction (C16). mpv.exe statically links FFmpeg and exposes
 * no CLI, so the licensing question never arises for these rows: the engine is
 * the mpv we already ship, spawned through `ctx.engine.spawn()`, and the bundle
 * grows by zero bytes. The single row that WOULD need an ffmpeg binary is S43
 * (extract an embedded subtitle to disk); §2.4 answers it with "we will not",
 * and this module ships no S43 command rather than pulling in the dependency.
 *
 * FIVE MEASURED FACTS THAT SHAPE EVERY BUILDER HERE, each from the §2.4 row it
 * belongs to. They are the whole reason this is a table of literals and not a
 * template somebody tidies later:
 *
 *  1. `--ovcopts` / `--oacopts` / `--ofopts` are **COMMA**-separated.
 *     `lossless=0:quality=75` fails with "Invalid chars" (C11).
 *  2. `pix_fmt` is **not** an AVOption. The pixel format is a `format=` node in
 *     the filter graph, never an `--ovcopts` key (C11).
 *  3. `qscale` is **not** a libavcodec AVOption — mpv prints "AVOption 'qscale'
 *     not found". MJPEG quality is `global_quality=<q*118>,flags=+qscale` (C09).
 *  4. A single-pass GIF **must** use `stats_mode=single`. `stats_mode=diff`
 *     produced no output and no error, because `palettegen` only emits at EOF
 *     and deadlocks a one-shot graph; `paletteuse=new=1` is required (C14).
 *  5. **A Windows absolute path cannot appear inside a lavfi option.** `C\:/…`
 *     and `C\\:/…` both fail graph parsing (§7.7 trap 8, C10). Only a bare
 *     relative filename with the child's cwd set has ever worked — and
 *     `SecondaryEngineOptions` has no `cwd`, which is why `sheetArgs()` below
 *     ships without timestamps and `timestampedSheetArgs()` is quarantined
 *     behind `SHEET_TIMESTAMPS_NEED_CWD`.
 */

// ---------------------------------------------------------------------------
// What `ctx.engine.spawn()` already applies, and what this module deliberately
// overrides.
// ---------------------------------------------------------------------------

/**
 * The options core adds to every secondary, copied here because core does not
 * export them.
 *
 * This list is duplicated from `src/main/core/mpv/engine.ts`'s
 * `ENGINE_BASE_ARGS`, and M27 had to copy it too (`thumb-core.ts`'s
 * `ENGINE_APPLIED_OPTIONS`). Two modules keeping their own copy of a core
 * constant is how the copies come to disagree with core; it is reported as a
 * finding rather than papered over, because a module may not import the file
 * that holds the real one.
 */
export const ENGINE_APPLIED_OPTIONS: readonly string[] = [
  '--input-ipc-server',
  '--no-config',
  '--idle',
  '--terminal',
  '--msg-level',
  '--load-scripts',
  '--ytdl'
]

/**
 * The three core defaults an ENCODE job must override, and why each one.
 *
 * mpv applies command-line options left to right and the last occurrence wins;
 * `ctx.engine.spawn()` puts `opts.args` after its own, so these three take
 * effect. They are stated in one place because getting any of them wrong
 * produces a file that exists and does not play.
 *
 *  - `--idle=no`: core applies `--idle=yes`, which is right for M27's
 *    thumbnailer (a pinned process answering hover requests) and wrong for an
 *    encode. Encode mode finalises the container — the MP4 `moov` atom, the
 *    Matroska cues — when the encoder is torn down, so a job that reaches EOF
 *    and then sits idle has written a file whose trailer is missing. Letting mpv
 *    exit by itself is the only path that finalises without depending on
 *    `close()`'s fixed 800 ms kill escalation.
 *  - `--keep-open=no`: `keep-open=yes` pauses at the last frame instead of
 *    ending the file, which with `--idle=no` would hang the job for ever.
 *  - `--terminal=yes --msg-level=all=error`: core sets `--terminal=no
 *    --msg-level=all=no`, so an encoder that refuses to initialise (C19's whole
 *    subject) fails silently. This is the exact pair the playing mpv already
 *    runs with in `src/main/index.ts`, and `ctx.engine.spawn()` pipes the
 *    child's stderr into the log, so a failure becomes readable.
 */
export const ENCODE_OVERRIDES: readonly string[] = [
  '--idle=no',
  '--keep-open=no',
  '--terminal=yes',
  '--msg-level=all=error'
]

/** True when `args` re-states an option `ctx.engine.spawn()` already applies. */
export function conflictsWithEngineArgs(args: readonly string[]): string[] {
  const names = args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0] as string)
  return names.filter((n) => ENGINE_APPLIED_OPTIONS.includes(n))
}

// ---------------------------------------------------------------------------
// §7.7 trap 8, as a function that throws.
// ---------------------------------------------------------------------------

/**
 * Refuse a filter graph that carries a Windows absolute path.
 *
 * This is a guard rather than a comment because the failure mode it prevents is
 * silent: mpv reports a graph-parse error, the job "fails" with no output, and
 * the obvious next move — escaping the colon as `C\:/…` — fails identically.
 * Both spellings were measured. The only thing that works is a bare relative
 * filename resolved against the child's cwd, which this module cannot set.
 *
 * Matches a drive-letter path (`C:/`, `c:\`), a UNC path (`\\server\share`) and
 * the two escaped spellings that look like they should work.
 */
const ABSOLUTE_IN_GRAPH = /(?:[A-Za-z]\\{0,2}:[/\\])|(?:^|[=:,[])\\\\[^\\]/

export function assertLavfiSafe(graph: string, what: string): void {
  if (ABSOLUTE_IN_GRAPH.test(graph)) {
    throw new Error(
      `${what}: a Windows absolute path cannot appear inside a lavfi option ` +
        `(§7.7 trap 8). Stage the asset in ctx.paths.tempJobDir() and pass a bare ` +
        `relative filename with the child's cwd set — which ctx.engine.spawn() ` +
        `cannot do today. Graph was: ${graph}`
    )
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Most encoders need even dimensions; `-2` in a scale node keeps the aspect. */
export function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v - 1
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * MJPEG quality, C09's measured form.
 *
 * `qscale` is not an AVOption. libavcodec's `global_quality` is in
 * `FF_QP2LAMBDA` units (118), so a qscale of 3 is `global_quality=354` — the
 * exact number the row records — and `flags=+qscale` is what makes the encoder
 * read it at all.
 */
export function mjpegQualityOpts(qscale: number): string {
  const q = clamp(Math.round(qscale), 2, 31)
  return `global_quality=${q * 118},flags=+qscale`
}

/** A comma-separated option list. Never colon: `--ovcopts` rejects colons. */
export function optList(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${k}=${v}`).join(',')
}

/** Wrap a filter graph for mpv's `lavfi` bridge, with the trap-8 guard. */
export function lavfi(graph: string, what: string): string {
  assertLavfiSafe(graph, what)
  return `--vf=lavfi=[${graph}]`
}

// ---------------------------------------------------------------------------
// The range and subtitle carry-over shared by every job
// ---------------------------------------------------------------------------

export interface SourceRange {
  /** Absolute path or URL of the source. Passed positionally after `--`. */
  readonly file: string
  readonly startSec: number
  readonly endSec: number
}

/**
 * C12. Subtitles are burnt in **by default** in encode mode, so "no subtitles"
 * is the case that needs an explicit option. Muxing a soft subtitle track is
 * not possible at all — encode mode has no subtitle muxing — so the UI says
 * burn-in or nothing rather than offering a checkbox that cannot work.
 */
export interface SubtitleCarry {
  readonly burn: boolean
  /** mpv's `sid`. `false` is a real value (no track selected). */
  readonly sid?: number | false | undefined
  /** Carried so the burnt-in timing matches what the user was watching. */
  readonly subDelay?: number | undefined
  readonly subScale?: number | undefined
  /** An external subtitle file, when the selected track came from one. */
  readonly subFile?: string | undefined
}

function rangeArgs(r: SourceRange): string[] {
  // `--start`/`--end` are absolute seconds; `--hr-seek=yes` is what makes the
  // first frame land on the requested time instead of the preceding keyframe.
  return [`--start=${r.startSec.toFixed(3)}`, `--end=${r.endSec.toFixed(3)}`, '--hr-seek=yes']
}

/**
 * C12, in full.
 *
 * `--sub-ass-override=no` is deliberate: a typeset release positions signs
 * exactly where it wants them, and forcing our own style into a file the user
 * is exporting to send to somebody else is the wrong default.
 */
export function subtitleArgs(s: SubtitleCarry): string[] {
  if (!s.burn) return ['--sid=no']
  const out: string[] = []
  if (s.subFile) out.push(`--sub-file=${s.subFile}`)
  if (typeof s.sid === 'number' && s.sid > 0) out.push(`--sid=${s.sid}`)
  if (typeof s.subDelay === 'number' && s.subDelay !== 0) {
    out.push(`--sub-delay=${s.subDelay.toFixed(3)}`)
  }
  if (typeof s.subScale === 'number' && s.subScale !== 1) {
    out.push(`--sub-scale=${s.subScale.toFixed(3)}`)
  }
  out.push('--sub-ass-override=no')
  return out
}

// ---------------------------------------------------------------------------
// C11 + C19 — the clip presets
// ---------------------------------------------------------------------------

export type ClipPresetId =
  | 'h264-mp4'
  | 'hevc-mkv'
  | 'vp9-webm'
  | 'av1-mkv'
  | 'nvenc-mp4'
  | 'qsv-mp4'
  | 'amf-mp4'
  | 'mf-mp4'

export interface ClipPreset {
  readonly id: ClipPresetId
  readonly ext: string
  /** `--of=` */
  readonly format: string
  /** `--ovc=` */
  readonly vcodec: string
  /** `--ovcopts=`, as ordered pairs so the quality key can be overridden. */
  readonly vopts: ReadonlyArray<readonly [string, string]>
  /** `--oac=` */
  readonly acodec: string
  readonly aopts: ReadonlyArray<readonly [string, string]>
  /**
   * The `vopts` keys that carry the quality knob, in the spelling THIS encoder
   * uses. C19: "the exact `--ovcopts` key names differ per vendor", which is
   * exactly why this is per-preset data and not a global `crf` string.
   */
  readonly qualityKeys: readonly string[]
  /** True for the four `_nvenc`/`_qsv`/`_amf`/`_mf` presets (C19). */
  readonly hardware: boolean
}

/**
 * Verbatim from C11 and C19. The encoder inventory was confirmed against the
 * pinned build: libx264 / libx265 / libvpx-vp9 / libsvtav1 / libaom-av1 /
 * prores / ffv1 / mjpeg / png / gif / webp plus the `_nvenc` / `_qsv` / `_amf`
 * / `_mf` variants.
 *
 * §7.3 R-4 is the standing caveat on this whole table: the pin reports a **GPL**
 * build. An LGPL build (`-Dgpl=false`) loses libx264, libx265 and libmp3lame
 * outright, and this table collapses to AAC / Opus / VP9 / AV1. That open
 * question has never been closed, and it decides M23's presets — so
 * `probeEncoder()` exists for the hardware rows and `AUDIO_FORMATS`' mp3 row and
 * the two libx presets are the ones that would have to go.
 */
export const CLIP_PRESETS: readonly ClipPreset[] = [
  {
    id: 'h264-mp4',
    ext: 'mp4',
    format: 'mp4',
    vcodec: 'libx264',
    vopts: [
      ['preset', 'veryfast'],
      ['crf', '20']
    ],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: ['crf'],
    hardware: false
  },
  {
    id: 'hevc-mkv',
    ext: 'mkv',
    format: 'matroska',
    vcodec: 'libx265',
    vopts: [
      ['preset', 'medium'],
      ['crf', '24']
    ],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: ['crf'],
    hardware: false
  },
  {
    id: 'vp9-webm',
    ext: 'webm',
    format: 'webm',
    vcodec: 'libvpx-vp9',
    // `b=0` is not decoration: without it libvpx treats crf as a ceiling on a
    // bitrate target and the file comes out at the default 256 kbps.
    vopts: [
      ['crf', '32'],
      ['b', '0']
    ],
    acodec: 'libopus',
    aopts: [],
    qualityKeys: ['crf'],
    hardware: false
  },
  {
    id: 'av1-mkv',
    ext: 'mkv',
    format: 'matroska',
    vcodec: 'libsvtav1',
    vopts: [
      ['crf', '32'],
      ['preset', '8']
    ],
    acodec: 'libopus',
    aopts: [],
    qualityKeys: ['crf'],
    hardware: false
  },
  {
    id: 'nvenc-mp4',
    ext: 'mp4',
    format: 'mp4',
    vcodec: 'h264_nvenc',
    vopts: [
      ['preset', 'p5'],
      ['rc', 'vbr'],
      ['cq', '23']
    ],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: ['cq'],
    hardware: true
  },
  {
    id: 'qsv-mp4',
    ext: 'mp4',
    format: 'mp4',
    vcodec: 'h264_qsv',
    vopts: [['global_quality', '23']],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: ['global_quality'],
    hardware: true
  },
  {
    id: 'amf-mp4',
    ext: 'mp4',
    format: 'mp4',
    vcodec: 'h264_amf',
    vopts: [
      ['quality', 'balanced'],
      ['rc', 'cqp'],
      ['qp_i', '23'],
      ['qp_p', '23']
    ],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: ['qp_i', 'qp_p'],
    hardware: true
  },
  {
    id: 'mf-mp4',
    ext: 'mp4',
    format: 'mp4',
    vcodec: 'h264_mf',
    vopts: [],
    acodec: 'aac',
    aopts: [['b', '192000']],
    qualityKeys: [],
    hardware: true
  }
]

export function clipPreset(id: string): ClipPreset {
  return CLIP_PRESETS.find((p) => p.id === id) ?? (CLIP_PRESETS[0] as ClipPreset)
}

/** Every hardware preset's software fallback, per C19's "never a default". */
export const HARDWARE_FALLBACK: ClipPresetId = 'h264-mp4'

/**
 * Apply the user's quality number to whichever key this encoder calls quality.
 *
 * A preset with no quality key (`h264_mf`) is left alone rather than being given
 * a `crf` it does not understand — mpv would print "AVOption not found" and the
 * job would fail for a reason the user cannot act on.
 */
export function withQuality(
  vopts: ReadonlyArray<readonly [string, string]>,
  qualityKeys: readonly string[],
  quality: number
): Array<readonly [string, string]> {
  const q = String(clamp(Math.round(quality), 0, 63))
  return vopts.map(([k, v]) => (qualityKeys.includes(k) ? ([k, q] as const) : ([k, v] as const)))
}

export interface ClipInput extends SourceRange {
  readonly outputFile: string
  readonly preset: ClipPreset
  /** crf / cq / global_quality / qp, in the preset's own spelling. */
  readonly quality: number
  readonly subs: SubtitleCarry
  /** Optional downscale. Omitted keeps the source resolution. */
  readonly width?: number | undefined
  /** mpv `aid`, carried so a dual-audio release exports the dub the user hears. */
  readonly aid?: number | false | undefined
}

/** C11 + C12 + C19: one re-encoded clip. */
export function clipArgs(input: ClipInput): string[] {
  const p = input.preset
  const nodes: string[] = []
  if (typeof input.width === 'number' && input.width > 0) {
    nodes.push(`scale=${even(input.width)}:-2:flags=lanczos`)
  }
  // Fact 2: pix_fmt is not an AVOption, so the pixel format is a graph node.
  nodes.push('format=yuv420p')

  const args = [
    ...ENCODE_OVERRIDES,
    ...rangeArgs(input),
    ...subtitleArgs(input.subs),
    lavfi(nodes.join(','), 'clip export'),
    `--of=${p.format}`,
    `--ovc=${p.vcodec}`
  ]
  const vopts = withQuality(p.vopts, p.qualityKeys, input.quality)
  if (vopts.length > 0) args.push(`--ovcopts=${optList(vopts)}`)
  args.push(`--oac=${p.acodec}`)
  if (p.aopts.length > 0) args.push(`--oacopts=${optList(p.aopts)}`)
  if (typeof input.aid === 'number' && input.aid > 0) args.push(`--aid=${input.aid}`)
  args.push(`--o=${input.outputFile}`, '--', input.file)
  return args
}

// ---------------------------------------------------------------------------
// C16 / A46 — audio extraction
// ---------------------------------------------------------------------------

export type AudioFormatId = 'mp3' | 'wav' | 'flac' | 'opus' | 'm4a' | 'mka'

export interface AudioFormat {
  readonly id: AudioFormatId
  readonly ext: string
  readonly format: string
  readonly codec: string
  readonly opts: ReadonlyArray<readonly [string, string]>
}

/** Verbatim from C16. `--of=ipod` is mpv's name for the M4A muxer. */
export const AUDIO_FORMATS: readonly AudioFormat[] = [
  { id: 'mp3', ext: 'mp3', format: 'mp3', codec: 'libmp3lame', opts: [['b', '192000']] },
  { id: 'wav', ext: 'wav', format: 'wav', codec: 'pcm_s16le', opts: [] },
  { id: 'flac', ext: 'flac', format: 'flac', codec: 'flac', opts: [] },
  { id: 'opus', ext: 'opus', format: 'opus', codec: 'libopus', opts: [] },
  { id: 'm4a', ext: 'm4a', format: 'ipod', codec: 'aac', opts: [['b', '192000']] },
  { id: 'mka', ext: 'mka', format: 'matroska', codec: 'flac', opts: [] }
]

export function audioFormat(id: string): AudioFormat {
  return AUDIO_FORMATS.find((f) => f.id === id) ?? (AUDIO_FORMATS[0] as AudioFormat)
}

export interface AudioInput extends SourceRange {
  readonly outputFile: string
  readonly format: AudioFormat
  readonly aid?: number | false | undefined
}

/**
 * C16 / A46: extract or "record" audio.
 *
 * PotPlayer's audio recorder is a live tape deck. Because encode mode runs
 * faster than realtime, an A-B range job is strictly better for a local file —
 * the same output in seconds instead of minutes, and cancellable. The tape-deck
 * metaphor survives only for live network streams, which is C17's `stream-record`
 * and lives in index.ts.
 */
export function audioArgs(input: AudioInput): string[] {
  const args = [
    ...ENCODE_OVERRIDES,
    '--no-video',
    ...rangeArgs(input),
    `--of=${input.format.format}`,
    `--oac=${input.format.codec}`
  ]
  if (input.format.opts.length > 0) args.push(`--oacopts=${optList(input.format.opts)}`)
  if (typeof input.aid === 'number' && input.aid > 0) args.push(`--aid=${input.aid}`)
  args.push(`--o=${input.outputFile}`, '--', input.file)
  return args
}

// ---------------------------------------------------------------------------
// C14 — GIF, with palette generation
// ---------------------------------------------------------------------------

export interface GifInput extends SourceRange {
  readonly outputFile: string
  readonly fps: number
  readonly width: number
  readonly maxColors: number
  readonly dither: string
}

export const GIF_DITHERS: readonly string[] = [
  'sierra2_4a',
  'sierra2',
  'floyd_steinberg',
  'bayer',
  'none'
]

/**
 * C14, single pass — the recommended one, and the one whose failure mode is
 * subtle enough to be worth restating at the call site.
 *
 * `stats_mode=single` is mandatory. With `stats_mode=diff` the job produced **no
 * output and no error**: `palettegen` only emits its palette at EOF, so in a
 * one-shot graph the `paletteuse` branch waits for a frame that never comes and
 * the graph deadlocks. `paletteuse=new=1` is required for the same reason —
 * it tells paletteuse a new palette arrives per segment.
 *
 * `paletteuse` and `overlay` are absent from `--vf=lavfi=help` because that
 * listing filters multi-input filters; both exist.
 */
export function gifArgs(input: GifInput): string[] {
  const w = even(input.width)
  const colors = clamp(Math.round(input.maxColors), 2, 256)
  const dither = GIF_DITHERS.includes(input.dither) ? input.dither : 'sierra2_4a'
  const graph =
    `fps=${input.fps},scale=${w}:-2:flags=lanczos,format=rgb24,split[a][b];` +
    `[a]palettegen=max_colors=${colors}:stats_mode=single[p];` +
    `[b][p]paletteuse=dither=${dither}:new=1`
  return [
    ...ENCODE_OVERRIDES,
    '--no-audio',
    ...rangeArgs(input),
    lavfi(graph, 'GIF export'),
    '--of=gif',
    '--ovc=gif',
    '--ofopts=loop=0',
    `--o=${input.outputFile}`,
    '--',
    input.file
  ]
}

/**
 * C14's size estimate, calibrated on the row's own measurement: 2 s at 480 px
 * and 15 fps came out at 2.7–3.0 MB, i.e. ~95 KB per frame at 480 px wide.
 *
 * Area-proportional, because a GIF frame's cost is its pixel count. This exists
 * so the UI can show a number and cap the duration BEFORE spending a minute
 * producing a 40 MB file nobody can send anywhere.
 */
const GIF_BYTES_PER_FRAME_AT_480 = 95_000

export function estimateGifBytes(durationSec: number, fps: number, width: number): number {
  const frames = Math.max(1, Math.round(Math.max(0, durationSec) * Math.max(1, fps)))
  const areaRatio = (even(width) / 480) ** 2
  return Math.round(frames * GIF_BYTES_PER_FRAME_AT_480 * areaRatio)
}

// ---------------------------------------------------------------------------
// C15 — animated WebP
// ---------------------------------------------------------------------------

export interface WebpInput extends SourceRange {
  readonly outputFile: string
  readonly fps: number
  readonly width: number
  readonly quality: number
  readonly lossless: boolean
}

/** C15. Verified at 560 KB for 2 s at 480 px — roughly a fifth of the GIF. */
export function webpArgs(input: WebpInput): string[] {
  const w = even(input.width)
  return [
    ...ENCODE_OVERRIDES,
    '--no-audio',
    ...rangeArgs(input),
    lavfi(`fps=${input.fps},scale=${w}:-2:flags=lanczos`, 'WebP export'),
    '--of=webp',
    '--ovc=libwebp_anim',
    // Fact 1: comma, not colon. `lossless=0:quality=75` fails "Invalid chars".
    `--ovcopts=${optList([
      ['lossless', input.lossless ? '1' : '0'],
      ['quality', String(clamp(Math.round(input.quality), 0, 100))]
    ])}`,
    `--o=${input.outputFile}`,
    '--',
    input.file
  ]
}

// ---------------------------------------------------------------------------
// C09 — offline burst frames, faster than realtime
// ---------------------------------------------------------------------------

export type BurstFormat = 'png' | 'jpg'

export interface BurstInput extends SourceRange {
  /** Must contain a `%04d` counter: image2 writes one file per frame. */
  readonly outputPattern: string
  readonly format: BurstFormat
  readonly intervalSec: number
  readonly width: number
  /** MJPEG qscale, 2 (best) to 31. Ignored for PNG. */
  readonly jpegQscale: number
  /** Drop `--sid=no` to burn subtitles into the frames (C09's own note). */
  readonly burnSubs: boolean
}

export function burstArgs(input: BurstInput): string[] {
  const w = even(input.width)
  const interval = Math.max(0.05, input.intervalSec)
  const nodes = [`fps=1/${interval}`, `scale=${w}:-2:flags=lanczos`]
  // C09: the JPEG variant needs a full-range YUV node as well as the encoder.
  if (input.format === 'jpg') nodes.push('format=yuvj420p')

  const args = [
    ...ENCODE_OVERRIDES,
    '--no-audio',
    ...rangeArgs(input),
    lavfi(nodes.join(','), 'burst frames'),
    '--of=image2'
  ]
  if (!input.burnSubs) args.push('--sid=no')
  if (input.format === 'png') {
    args.push('--ovc=png')
  } else {
    // Fact 3: `qscale` is not an AVOption.
    args.push('--ovc=mjpeg', `--ovcopts=${mjpegQualityOpts(input.jpegQscale)}`)
  }
  args.push(`--o=${input.outputPattern}`, '--', input.file)
  return args
}

// ---------------------------------------------------------------------------
// C10 — the contact sheet, and the part of it that cannot ship
// ---------------------------------------------------------------------------

export interface SheetInput {
  readonly file: string
  readonly outputFile: string
  readonly durationSec: number
  readonly cols: number
  readonly rows: number
  readonly tileWidth: number
  readonly burnSubs: boolean
}

/**
 * C10, without per-tile timestamps.
 *
 * WHAT IS MISSING AND WHY, because "the contact sheet has no timestamps" must
 * not read as an oversight. C10's verified graph puts a `drawtext` node between
 * `scale` and `tile`, and `drawtext` **requires** `fontfile=` — `font=Arial`
 * fails, this build has no fontconfig. `fontfile=` must therefore name a font
 * file, and §7.7 trap 8 says a Windows absolute path inside a lavfi option is
 * impossible: `C\:/…` and `C\\:/…` both fail graph parsing, and the only thing
 * that ever worked was a bare relative filename with the child's **cwd** set to
 * the directory holding the font.
 *
 * `ctx.paths.tempJobDir(jobId)` exists for exactly that staging, and §12 says in
 * as many words "spawn with `cwd` set" — but `SecondaryEngineOptions` is
 * `{ purpose, args, idleTimeoutMs }`. There is no `cwd`, and `ctx.engine.spawn()`
 * passes none to `child_process.spawn`, so the child inherits the app's cwd,
 * which is the install directory and is not writable. A module may not use
 * `child_process` itself (the §15 checklist forbids it, and it is what "no
 * orphan mpv on quit" rests on), so there is no second path.
 *
 * So this ships the sheet that DOES work — tiles, margins, background — and
 * `timestampedSheetArgs()` below keeps the verified graph next to it, tested and
 * unreachable, so the day `cwd` lands it is a one-line change and not a
 * re-derivation. §7.3 R-9's recommendation (compose the header on a canvas,
 * `drawtext` only for per-tile timestamps) points the same way and needs the same
 * missing option.
 */
export function sheetArgs(input: SheetInput): string[] {
  const tiles = Math.max(1, input.cols * input.rows)
  const dur = Math.max(1, input.durationSec)
  const tileW = even(input.tileWidth)
  const graph =
    `fps=${tiles}/${dur},scale=${tileW}:-2,` +
    `tile=${input.cols}x${input.rows}:margin=6:padding=4:color=0x1e1e1e`
  const args = [
    ...ENCODE_OVERRIDES,
    '--no-audio',
    '--start=0',
    '--hr-seek=yes',
    lavfi(graph, 'contact sheet')
  ]
  if (!input.burnSubs) args.push('--sid=no')
  args.push(
    '--of=image2',
    // C10: `fps=<tiles>/<duration>` yields exactly <tiles> frames, but pass
    // `update=1` anyway — a single-output image2 without it is a template error
    // waiting for the frame count to be off by one.
    '--ofopts=update=1',
    '--ovc=png',
    `--o=${input.outputFile}`,
    '--',
    input.file
  )
  return args
}

/**
 * Why `timestampedSheetArgs` is not called anywhere: `ctx.engine.spawn()` has no
 * `cwd`, and this graph needs one.
 */
export const SHEET_TIMESTAMPS_NEED_CWD = true

/**
 * C10's verified graph, kept whole. Requires `cwd` to be the directory holding
 * `fontFile`, and `fontFile` must be a BARE relative name.
 *
 * Callable only from tests today. It asserts its own precondition rather than
 * trusting the caller, because the failure it prevents is a graph-parse error
 * with no output and no obvious cause.
 */
export function timestampedSheetArgs(
  input: SheetInput & { readonly fontFile: string; readonly header: string }
): string[] {
  if (/[/\\]|^[A-Za-z]:/.test(input.fontFile)) {
    throw new Error(
      `contact sheet: fontFile must be a BARE relative filename (got '${input.fontFile}'). ` +
        `drawtext requires fontfile= and a lavfi option cannot carry a Windows path; ` +
        `the child's cwd must be the directory holding the font (§7.7 trap 8).`
    )
  }
  const tiles = Math.max(1, input.cols * input.rows)
  const dur = Math.max(1, input.durationSec)
  const tileW = even(input.tileWidth)
  const stamp =
    `drawtext=fontfile=${input.fontFile}:text='%{pts\\:hms}':x=6:y=h-th-6:` +
    `fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4`
  const head =
    `drawtext=fontfile=${input.fontFile}:text='${input.header}':x=14:y=22:` +
    `fontsize=22:fontcolor=0xE6E6E6`
  const graph =
    `fps=${tiles}/${dur},scale=${tileW}:-2,${stamp},` +
    `tile=${input.cols}x${input.rows}:margin=6:padding=4:color=0x1e1e1e,` +
    `pad=iw:ih+70:0:70:color=0x1e1e1e,${head}`
  const args = [
    ...ENCODE_OVERRIDES,
    '--no-audio',
    '--start=0',
    '--hr-seek=yes',
    lavfi(graph, 'contact sheet with timestamps')
  ]
  if (!input.burnSubs) args.push('--sid=no')
  args.push(
    '--of=image2',
    '--ofopts=update=1',
    '--ovc=png',
    `--o=${input.outputFile}`,
    '--',
    input.file
  )
  return args
}

// ---------------------------------------------------------------------------
// C19 — the hardware-encoder probe
// ---------------------------------------------------------------------------

/**
 * C19: "probe once against `av://lavfi:testsrc=duration=0.2` and cache the exit
 * code". The encoders are PRESENT in the build; whether they initialise depends
 * on the GPU and the driver, so every hardware preset is probe-then-fall-back and
 * never a default.
 *
 * `--idle=yes` is left alone here — that is core's default and this call does NOT
 * add `ENCODE_OVERRIDES`. A 0.2 s encode with `--idle=no` can finish before
 * `ctx.engine.spawn()`'s IPC connect lands, and a spawn that fails to connect
 * retries for 15 s and then throws, which would make a working encoder look
 * broken. The probe therefore stays idle-resident, reports through `end-file`,
 * and is closed by the caller.
 */
export function hardwareProbeArgs(preset: ClipPreset, outputFile: string): string[] {
  const args = [
    '--terminal=yes',
    '--msg-level=all=error',
    '--no-audio',
    '--of=mp4',
    `--ovc=${preset.vcodec}`
  ]
  if (preset.vopts.length > 0) args.push(`--ovcopts=${optList(preset.vopts)}`)
  args.push(
    lavfi('format=yuv420p', 'encoder probe'),
    `--o=${outputFile}`,
    '--',
    'av://lavfi:testsrc=duration=0.2'
  )
  return args
}

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

/** Windows-illegal characters, plus the control range. */
export function sanitizeStem(name: string): string {
  /* eslint-disable-next-line no-control-regex */
  const cleaned = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u0000-\u001f]/g, '_')
  return cleaned.trim().slice(0, 110) || 'clip'
}

/** `1234.5` -> `20m34s`. Filename-safe and sorts sensibly. */
export function stampSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h${two(m)}m${two(r)}s` : `${m}m${two(r)}s`
}

/**
 * A name that will not collide, without asking the filesystem twice.
 *
 * `exists` is injected so this is testable without touching a disk — and so the
 * caller can pass the same predicate for the `%04d` burst pattern, where the
 * file that would collide is the FIRST frame rather than the name itself.
 */
export function uniqueName(
  base: string,
  ext: string,
  exists: (name: string) => boolean
): string {
  const first = `${base}.${ext}`
  if (!exists(first)) return first
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}.${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${base}_${Date.now()}.${ext}`
}
