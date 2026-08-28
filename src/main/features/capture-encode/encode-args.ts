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
 *  1. `--ovcopts` / `--oacopts` / `--ofopts` are **COMMA**-separated — and the
 *     colon form is WORSE than the row says. C11 records `lossless=0:quality=75`
 *     as failing with "Invalid chars"; on the pinned binary it does not fail at
 *     all, it silently drops every option after the first:
 *
 *     ```
 *     --ovcopts=lossless=0,quality=75 -> 37,688 bytes    (quality applied)
 *     --ovcopts=lossless=0,quality=10 -> 14,124 bytes    (quality applied)
 *     --ovcopts=lossless=0:quality=75 -> 37,688 bytes    end-file eof, no error
 *     --ovcopts=lossless=0:quality=10 -> 37,688 bytes    IDENTICAL: q ignored
 *     ```
 *
 *     So mpv is not the check. A test that runs a job and asserts "no error"
 *     passes on a command line whose quality setting went nowhere; the only
 *     honest check is on the generated STRING, which is what
 *     `encode-args.test.ts` asserts for every builder.
 *  2. `pix_fmt` is **not** an AVOption. The pixel format is a `format=` node in
 *     the filter graph, never an `--ovcopts` key (C11).
 *  3. `qscale` is **not** a libavcodec AVOption — mpv prints "AVOption 'qscale'
 *     not found". MJPEG quality is `global_quality=<q*118>,flags=+qscale` (C09).
 *  4. A single-pass GIF uses `stats_mode=single` and `paletteuse=new=1` (C14).
 *     C14 says `stats_mode=diff` "produced no output and no error"; on the
 *     pinned binary it **did** produce output — an 856,011-byte GIF for
 *     `single` against a 437,060-byte one for `diff`, both `end-file eof`. The
 *     row's conclusion is kept because `single` is the form that was verified
 *     end to end and is a palette per segment rather than one accumulated at
 *     EOF, but the stated reason no longer reproduces, so nothing here relies on
 *     `diff` failing loudly.
 *  5. **A Windows absolute path cannot appear inside a lavfi option.** `C\:/…`
 *     and `C\\:/…` both fail graph parsing (§7.7 trap 8, C10). Only a bare
 *     relative filename with the child's cwd set has ever worked — and
 *     `SecondaryEngineOptions` has no `cwd`, which is why `sheetArgs()` below
 *     ships without timestamps and `timestampedSheetArgs()` is quarantined
 *     behind `SHEET_TIMESTAMPS_NEED_CWD`.
 *
 * ...and one MEASURED CORRECTION to the row that this file used to follow, made
 * against the pinned binary (mpv v0.41.0-923-g7b8915bc1, FFmpeg N-126125) over
 * JSON IPC exactly the way `ctx.engine.spawn()` spawns:
 *
 *  6. **No builder here emits the source file, and none of them override
 *     `--idle`.** The first draft of this module did both — it appended
 *     `['--', file]` and put `--idle=no` in `ENCODE_OVERRIDES` so mpv would
 *     encode on startup and exit by itself. That cannot work through
 *     `ctx.engine.spawn()`, and the failure is not subtle once measured:
 *
 *     ```
 *     2 s clip, --idle=no, file on the command line:
 *       [161ms]   mpv exited, exit code 0, b.mp4 = 15269 bytes (a VALID file)
 *       [15016ms] core's client.connect() gave up:  "connect timeout"
 *                 -> ctx.engine.spawn() THREW for a job that had succeeded,
 *                    15 s after it finished, with no progress reported at all
 *     ```
 *
 *     `client.connect()` retries a vanished pipe for a fixed 15 s
 *     (`src/main/mpv/client.ts:36`), so every job shorter than the connect
 *     handshake reports failure late instead of success early. The same run in
 *     the shape this file emits now — core's `--idle=yes` left alone, encode
 *     options only, the source arriving by `loadfile` over IPC — connected at
 *     145 ms, delivered 3150 `time-pos` samples on a 60 s job, and ended with
 *     `end-file{reason:'eof'}`. Range options still apply: `--start=2 --end=4`
 *     given on the command line produced a 2 s output from a 6 s source loaded
 *     afterwards (26,733 bytes against the 6 s control's 67,357).
 *
 *     The other half of that measurement is why `runner.ts` waits for the
 *     PROCESS and not for the file: **the output is not valid until mpv exits.**
 *     At `end-file` the WebP was 0 bytes, the MP3 0, the M4A 44 and the GIF
 *     786,432; after `quit` they were 42,742 / 72,768 / 69,603 / 856,011. A
 *     size-greater-than-zero check run at EOF would have announced a truncated
 *     container as a success.
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
 * The core defaults an encode job overrides, and — as important — the one it
 * deliberately does NOT.
 *
 * mpv applies command-line options left to right and the last occurrence wins;
 * `ctx.engine.spawn()` puts `opts.args` after its own
 * (`src/main/core/mpv/engine.ts`: `[pipe, ...ENGINE_BASE_ARGS, ...opts.args]`),
 * so anything here takes effect.
 *
 *  - **`--idle` is NOT overridden.** Core's `--idle=yes` is what keeps the IPC
 *    pipe alive long enough to connect to, observe progress on, and cancel. See
 *    fact 6 in the file header for the measurement that settled it: with
 *    `--idle=no` a 2 s job finished in 161 ms and `spawn()` then threw 15 s
 *    later for a job that had already written a valid file. The job is started
 *    by `loadfile` over IPC instead, and finalised by `quit` — which is
 *    `engine.close()`, and which the runner awaits before it believes the
 *    output.
 *  - `--keep-open=no`: `keep-open=yes` pauses at the last frame instead of
 *    ending the file, so `end-file` — the runner's completion signal and its
 *    only failure channel — would never arrive.
 *  - `--terminal=yes --msg-level=all=error`: core sets `--terminal=no
 *    --msg-level=all=no`, so an encoder that refuses to initialise (C19's whole
 *    subject) fails silently. This is the exact pair the playing mpv already
 *    runs with in `src/main/index.ts`, and `ctx.engine.spawn()` pipes the
 *    child's stderr into the log, so a failure becomes readable in a bug report.
 *    (It is readable in the LOG only: the engine gives the module no access to
 *    the child's stderr and no exit code, which is why `end-file`'s `file_error`
 *    is what the runner reports to the user. Measured on this machine:
 *    `h264_nvenc`, `h264_qsv` and `h264_amf` all answer
 *    `end-file{reason:'error', file_error:'video output initialization failed'}`
 *    while `libx264`, `libx265`, `libvpx-vp9`, `libsvtav1` and `h264_mf` answer
 *    `eof`. That is C19's probe, and it needs no exit code.)
 */
export const ENCODE_OVERRIDES: readonly string[] = [
  '--keep-open=no',
  '--terminal=yes',
  '--msg-level=all=error'
]

/**
 * C19's probe source, `av://lavfi:testsrc=duration=0.2` verbatim from the row.
 *
 * It is a `loadfile` argument, not a command-line one, for the same reason as
 * every other source here.
 */
export const PROBE_SOURCE = 'av://lavfi:testsrc=duration=0.2'

/** True when `args` re-states an option `ctx.engine.spawn()` already applies. */
export function conflictsWithEngineArgs(args: readonly string[]): string[] {
  const names = args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0] as string)
  return names.filter((n) => ENGINE_APPLIED_OPTIONS.includes(n))
}

/**
 * The two of core's options an encode job is ALLOWED to re-state, and why only
 * these two.
 *
 * `--terminal` and `--msg-level` are diagnostics: core silences the child and an
 * encode needs its errors in the log, and re-stating them changes nothing about
 * the process's identity or lifecycle. The other five are load-bearing:
 * `--idle=yes` is what keeps the pipe alive to connect, observe and cancel on
 * (measured: with `--idle=no` a 2 s job exited at 161 ms and `spawn()` threw at
 * 15,016 ms); `--no-config` keeps a `vf` in the user's mpv.conf out of every
 * export; `--load-scripts=no` and `--ytdl=no` are the zero-network-at-rest
 * promise applied to every process this app starts; and `--input-ipc-server` is
 * the random pipe name that keeps mpv's "explicitly insecure" IPC — which
 * exposes `run` — off a guessable path.
 */
export const ENGINE_OVERRIDABLE: readonly string[] = ['--terminal', '--msg-level']

/**
 * The options a job must never re-state. Returns the offenders so the message
 * can name them.
 *
 * This is called at run time rather than only asserted in a test, because the
 * failure it prevents is silent in the direction that matters: mpv takes the
 * last occurrence, reports success, and the job either hangs (idle), picks up
 * the user's filter chain (no-config) or resolves a hostname (ytdl).
 */
export function forbiddenEngineOverrides(args: readonly string[]): string[] {
  return conflictsWithEngineArgs(args).filter((n) => !ENGINE_OVERRIDABLE.includes(n))
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
  args.push(`--o=${input.outputFile}`)
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
  args.push(`--o=${input.outputFile}`)
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
    `--o=${input.outputFile}`
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
    `--o=${input.outputFile}`
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

/**
 * How many files C09 is about to write, and the ceiling on it.
 *
 * The range for a burst defaults to the WHOLE FILE, because that is what
 * "consecutive capture, offline batch" means when no A-B loop is set — and at
 * the default 5 s interval a two-hour film is 1440 PNGs, several hundred
 * megabytes, in a folder the user has to clean up by hand. Encode mode runs
 * faster than realtime, so there is no natural pause in which to notice.
 *
 * The cap is therefore a refusal with an actionable message rather than a
 * progress bar that fills a disk. It is a pure function so the message can carry
 * the real number.
 */
export const BURST_MAX_FRAMES = 2000

export function burstFrameCount(startSec: number, endSec: number, intervalSec: number): number {
  const span = Math.max(0, endSec - startSec)
  const interval = Math.max(0.05, intervalSec)
  return Math.max(1, Math.floor(span / interval) + 1)
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
  args.push(`--o=${input.outputPattern}`)
  return args
}

// ---------------------------------------------------------------------------
// C10 — the contact sheet, and the part of it that cannot ship
// ---------------------------------------------------------------------------

export interface SheetInput {
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
    `--o=${input.outputFile}`
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
    `--o=${input.outputFile}`
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
 * There is no "exit code" to cache: `SecondaryEngine` exposes none. The signal
 * is `end-file`, and it is a good one — measured on this machine, `h264_nvenc`,
 * `h264_qsv` and `h264_amf` each answered
 * `{reason:'error', file_error:'video output initialization failed'}` and wrote
 * nothing, while `h264_mf` (Media Foundation, the vendor-agnostic row) answered
 * `{reason:'eof'}` and wrote 16,371 bytes. So on a box with no discrete GPU the
 * probe correctly rejects three encoders and accepts one.
 *
 * These args carry `ENCODE_OVERRIDES` like every other job — `--keep-open=no` is
 * what makes `end-file` arrive at all — and, like every other job, no source:
 * the probe is started with `loadfile PROBE_SOURCE`.
 */
export function hardwareProbeArgs(preset: ClipPreset, outputFile: string): string[] {
  const args = [...ENCODE_OVERRIDES, '--no-audio', '--of=mp4', `--ovc=${preset.vcodec}`]
  if (preset.vopts.length > 0) args.push(`--ovcopts=${optList(preset.vopts)}`)
  args.push(
    lavfi('format=yuv420p', 'encoder probe'),
    `--o=${outputFile}`
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
