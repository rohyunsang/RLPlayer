/**
 * M23 capture-encode — the command lines, asserted as STRINGS.
 *
 * WHY THESE ASSERT STRINGS AND NOT OUTCOMES, which is the whole reason this file
 * is worth its length: **mpv is not a check.** The §2.4 rows say a malformed
 * `--ovcopts` "fails with Invalid chars"; measured against the pinned binary
 * (mpv v0.41.0-923-g7b8915bc1, FFmpeg N-126125) over JSON IPC, it does not fail,
 * it silently drops every option after the first —
 *
 *   --ovcopts=lossless=0,quality=75 -> 37,688 bytes   quality applied
 *   --ovcopts=lossless=0,quality=10 -> 14,124 bytes   quality applied
 *   --ovcopts=lossless=0:quality=75 -> 37,688 bytes   end-file eof, no error
 *   --ovcopts=lossless=0:quality=10 -> 37,688 bytes   IDENTICAL: q ignored
 *
 * — so an integration test that ran a job and asserted "it produced a file and
 * mpv reported no error" would pass on a command line whose quality setting went
 * nowhere. The separator, the option names and the graph text are therefore
 * asserted literally here, where a typo cannot hide behind a plausible file.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIO_FORMATS,
  BURST_MAX_FRAMES,
  CLIP_PRESETS,
  ENCODE_OVERRIDES,
  ENGINE_APPLIED_OPTIONS,
  HARDWARE_FALLBACK,
  PROBE_SOURCE,
  assertLavfiSafe,
  audioArgs,
  audioFormat,
  burstArgs,
  burstFrameCount,
  clipArgs,
  clipPreset,
  conflictsWithEngineArgs,
  estimateGifBytes,
  even,
  gifArgs,
  hardwareProbeArgs,
  mjpegQualityOpts,
  optList,
  sanitizeStem,
  sheetArgs,
  stampSeconds,
  subtitleArgs,
  timestampedSheetArgs,
  uniqueName,
  webpArgs
} from './encode-args.ts'

const RANGE = { startSec: 12, endSec: 20.5 }
const NO_SUBS = { burn: false }
const value = (args: readonly string[], name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 1)
}

// ---------------------------------------------------------------------------
// The engine contract: what a job may and may not say
// ---------------------------------------------------------------------------

test('no builder emits the source file or a positional argument', () => {
  // MEASURED REGRESSION. The first draft appended ['--', file] and set
  // --idle=no so mpv would encode on startup and exit. A 2 s clip then finished
  // in 161 ms, the pipe vanished, core's client.connect() retried for its fixed
  // 15 s and ctx.engine.spawn() THREW — for a job that had written a valid
  // 15,269-byte MP4. Every source now arrives by `loadfile` over IPC.
  const builders: Array<readonly string[]> = [
    clipArgs({ ...RANGE, outputFile: 'C:/out/a.mp4', preset: clipPreset('h264-mp4'), quality: 20, subs: NO_SUBS }),
    audioArgs({ ...RANGE, outputFile: 'C:/out/a.mp3', format: audioFormat('mp3') }),
    gifArgs({ ...RANGE, outputFile: 'C:/out/a.gif', fps: 15, width: 480, maxColors: 192, dither: 'sierra2_4a' }),
    webpArgs({ ...RANGE, outputFile: 'C:/out/a.webp', fps: 15, width: 480, quality: 75, lossless: false }),
    burstArgs({ ...RANGE, outputPattern: 'C:/out/a_%04d.png', format: 'png', intervalSec: 1, width: 640, jpegQscale: 3, burnSubs: false }),
    sheetArgs({ outputFile: 'C:/out/s.png', durationSec: 600, cols: 4, rows: 4, tileWidth: 320, burnSubs: false }),
    hardwareProbeArgs(clipPreset('nvenc-mp4'), 'C:/tmp/p.mp4')
  ]
  for (const args of builders) {
    assert.equal(args.includes('--'), false, `a positional separator in ${args.join(' ')}`)
    for (const a of args) {
      assert.ok(a.startsWith('--'), `non-option argument '${a}'`)
      assert.ok(!a.startsWith('--idle'), '--idle is core\'s and must not be overridden')
    }
  }
})

test('ENCODE_OVERRIDES leaves --idle alone and asks for readable errors', () => {
  assert.deepEqual(ENCODE_OVERRIDES, ['--keep-open=no', '--terminal=yes', '--msg-level=all=error'])
  // --keep-open=no is load-bearing: `end-file` is the runner's only completion
  // signal AND its only failure channel, and keep-open=yes suppresses it.
  assert.ok(ENCODE_OVERRIDES.includes('--keep-open=no'))
})

test('conflictsWithEngineArgs catches an option core already applies', () => {
  assert.deepEqual(conflictsWithEngineArgs(['--idle=no', '--of=mp4']), ['--idle'])
  assert.deepEqual(conflictsWithEngineArgs(['--no-config', '--ytdl=no']), ['--no-config', '--ytdl'])
  assert.deepEqual(conflictsWithEngineArgs([...ENCODE_OVERRIDES]), ['--terminal', '--msg-level'])
  assert.ok(ENGINE_APPLIED_OPTIONS.includes('--idle'))
})

test('PROBE_SOURCE is C19\'s literal source', () => {
  assert.equal(PROBE_SOURCE, 'av://lavfi:testsrc=duration=0.2')
})

// ---------------------------------------------------------------------------
// Fact 1 — the comma separator, which mpv will not complain about
// ---------------------------------------------------------------------------

test('every option list is comma-separated and never colon-separated', () => {
  assert.equal(optList([['lossless', '0'], ['quality', '75']]), 'lossless=0,quality=75')

  const all = [
    ...clipArgs({ ...RANGE, outputFile: 'o.mp4', preset: clipPreset('amf-mp4'), quality: 23, subs: NO_SUBS }),
    ...audioArgs({ ...RANGE, outputFile: 'o.mp3', format: audioFormat('mp3') }),
    ...webpArgs({ ...RANGE, outputFile: 'o.webp', fps: 15, width: 480, quality: 75, lossless: false }),
    ...burstArgs({ ...RANGE, outputPattern: 'o_%04d.jpg', format: 'jpg', intervalSec: 1, width: 640, jpegQscale: 3, burnSubs: false })
  ]
  for (const a of all) {
    if (!/^--(ovcopts|oacopts|ofopts)=/.test(a)) continue
    const list = a.slice(a.indexOf('=') + 1)
    for (const pair of list.split(',')) {
      assert.match(pair, /^[a-z_0-9]+=[^,]*$/, `'${pair}' in '${a}' is not a bare key=value`)
      assert.equal(pair.includes(':'), false, `colon separator survived in '${a}'`)
    }
  }
})

test('the four hardware presets carry their vendor\'s own quality key', () => {
  // C19: "the exact --ovcopts key names differ per vendor". A shared `crf` would
  // make mpv print "AVOption not found" for three of the four.
  const keyOf = (id: string): string[] => clipPreset(id).qualityKeys.slice()
  assert.deepEqual(keyOf('nvenc-mp4'), ['cq'])
  assert.deepEqual(keyOf('qsv-mp4'), ['global_quality'])
  assert.deepEqual(keyOf('amf-mp4'), ['qp_i', 'qp_p'])
  assert.deepEqual(keyOf('mf-mp4'), [])

  const amf = clipArgs({ ...RANGE, outputFile: 'o.mp4', preset: clipPreset('amf-mp4'), quality: 30, subs: NO_SUBS })
  assert.equal(value(amf, '--ovcopts'), 'quality=balanced,rc=cqp,qp_i=30,qp_p=30')

  // h264_mf has no quality key at all: it must be left alone, not given a `crf`
  // it does not understand.
  const mf = clipArgs({ ...RANGE, outputFile: 'o.mp4', preset: clipPreset('mf-mp4'), quality: 30, subs: NO_SUBS })
  assert.equal(value(mf, '--ovcopts'), undefined)
  assert.equal(value(mf, '--ovc'), 'h264_mf')
})

test('every hardware preset falls back to a software one that exists', () => {
  const fallback = CLIP_PRESETS.find((p) => p.id === HARDWARE_FALLBACK)
  assert.ok(fallback, 'HARDWARE_FALLBACK names no preset')
  assert.equal(fallback?.hardware, false)
  assert.equal(CLIP_PRESETS.filter((p) => p.hardware).length, 4)
})

// ---------------------------------------------------------------------------
// Fact 2 — pix_fmt is a graph node, never an --ovcopts key
// ---------------------------------------------------------------------------

test('the pixel format is a format= node and never an option', () => {
  const args = clipArgs({ ...RANGE, outputFile: 'o.mp4', preset: clipPreset('h264-mp4'), quality: 20, subs: NO_SUBS })
  assert.equal(value(args, '--vf'), 'lavfi=[format=yuv420p]')
  assert.equal(args.some((a) => a.includes('pix_fmt')), false)
})

test('a width downscale becomes an even scale node before the format node', () => {
  const args = clipArgs({ ...RANGE, outputFile: 'o.mp4', preset: clipPreset('h264-mp4'), quality: 20, subs: NO_SUBS, width: 1281 })
  // 1281 is odd; libx264 needs even dimensions and `-2` keeps the aspect.
  assert.equal(value(args, '--vf'), 'lavfi=[scale=1280:-2:flags=lanczos,format=yuv420p]')
  assert.equal(even(1281), 1280)
  assert.equal(even(0), 2)
})

// ---------------------------------------------------------------------------
// Fact 3 — qscale is not an AVOption
// ---------------------------------------------------------------------------

test('MJPEG quality is global_quality in FF_QP2LAMBDA units, with +qscale', () => {
  // C09's own number: qscale 3 -> 354. `qscale=` would make mpv print
  // "AVOption 'qscale' not found" and fail the job.
  assert.equal(mjpegQualityOpts(3), 'global_quality=354,flags=+qscale')
  assert.equal(mjpegQualityOpts(0), 'global_quality=236,flags=+qscale', 'clamped to 2')
  assert.equal(mjpegQualityOpts(99), 'global_quality=3658,flags=+qscale', 'clamped to 31')

  const jpg = burstArgs({ ...RANGE, outputPattern: 'b_%04d.jpg', format: 'jpg', intervalSec: 2, width: 640, jpegQscale: 3, burnSubs: false })
  assert.equal(value(jpg, '--ovc'), 'mjpeg')
  assert.equal(value(jpg, '--ovcopts'), 'global_quality=354,flags=+qscale')
  // C09: the JPEG variant needs the full-range YUV node as well as the encoder.
  assert.equal(value(jpg, '--vf'), 'lavfi=[fps=1/2,scale=640:-2:flags=lanczos,format=yuvj420p]')
  assert.equal(value(jpg, '--o'), 'b_%04d.jpg')
  assert.equal(value(jpg, '--of'), 'image2')

  const png = burstArgs({ ...RANGE, outputPattern: 'b_%04d.png', format: 'png', intervalSec: 2, width: 640, jpegQscale: 3, burnSubs: false })
  assert.equal(value(png, '--ovc'), 'png')
  assert.equal(png.some((a) => a.startsWith('--ovcopts')), false)
  assert.equal(value(png, '--vf'), 'lavfi=[fps=1/2,scale=640:-2:flags=lanczos]')
})

// ---------------------------------------------------------------------------
// Fact 4 — the GIF palette graph
// ---------------------------------------------------------------------------

test('the single-pass GIF graph is C14\'s, verbatim', () => {
  const args = gifArgs({ ...RANGE, outputFile: 'o.gif', fps: 15, width: 480, maxColors: 192, dither: 'sierra2_4a' })
  assert.equal(
    value(args, '--vf'),
    'lavfi=[fps=15,scale=480:-2:flags=lanczos,format=rgb24,split[a][b];' +
      '[a]palettegen=max_colors=192:stats_mode=single[p];' +
      '[b][p]paletteuse=dither=sierra2_4a:new=1]'
  )
  assert.equal(value(args, '--ofopts'), 'loop=0')
  assert.equal(value(args, '--of'), 'gif')
  assert.equal(value(args, '--ovc'), 'gif')
  assert.ok(args.includes('--no-audio'))
})

test('the GIF graph never uses stats_mode=diff and always sets new=1', () => {
  const g = value(gifArgs({ ...RANGE, outputFile: 'o.gif', fps: 12, width: 320, maxColors: 999, dither: 'nonsense' }), '--vf') ?? ''
  assert.match(g, /stats_mode=single/)
  assert.equal(g.includes('stats_mode=diff'), false)
  assert.match(g, /paletteuse=dither=sierra2_4a:new=1/, 'an unknown dither falls back')
  assert.match(g, /max_colors=256/, 'colours clamped to the GIF maximum')
})

test('the GIF size estimate scales with area and frames', () => {
  // C14 measured 2 s at 480 px / 15 fps as 2.7-3.0 MB.
  const twoSec = estimateGifBytes(2, 15, 480)
  assert.ok(twoSec > 2.5e6 && twoSec < 3.1e6, `${twoSec} outside the measured band`)
  assert.equal(estimateGifBytes(4, 15, 480), twoSec * 2)
  assert.equal(estimateGifBytes(2, 15, 960), twoSec * 4, 'area, not width')
  assert.ok(estimateGifBytes(-5, 15, 480) > 0, 'never negative')
})

// ---------------------------------------------------------------------------
// C15 — animated WebP
// ---------------------------------------------------------------------------

test('the WebP job is C15\'s line', () => {
  const args = webpArgs({ ...RANGE, outputFile: 'o.webp', fps: 15, width: 480, quality: 75, lossless: false })
  assert.equal(value(args, '--of'), 'webp')
  assert.equal(value(args, '--ovc'), 'libwebp_anim')
  assert.equal(value(args, '--ovcopts'), 'lossless=0,quality=75')
  assert.equal(value(args, '--vf'), 'lavfi=[fps=15,scale=480:-2:flags=lanczos]')

  const lossless = webpArgs({ ...RANGE, outputFile: 'o.webp', fps: 15, width: 480, quality: 120, lossless: true })
  assert.equal(value(lossless, '--ovcopts'), 'lossless=1,quality=100')
})

// ---------------------------------------------------------------------------
// C16 / A46 — audio
// ---------------------------------------------------------------------------

test('every audio format is C16\'s muxer/encoder pair', () => {
  const line = (id: string): string =>
    audioArgs({ ...RANGE, outputFile: `o.${audioFormat(id).ext}`, format: audioFormat(id) })
      .filter((a) => /^--(of|oac|oacopts)=/.test(a))
      .join(' ')
  assert.equal(line('mp3'), '--of=mp3 --oac=libmp3lame --oacopts=b=192000')
  assert.equal(line('wav'), '--of=wav --oac=pcm_s16le')
  assert.equal(line('flac'), '--of=flac --oac=flac')
  assert.equal(line('opus'), '--of=opus --oac=libopus')
  // `ipod` is mpv's name for the M4A muxer; `m4a` is not a format mpv knows.
  assert.equal(line('m4a'), '--of=ipod --oac=aac --oacopts=b=192000')
  assert.equal(line('mka'), '--of=matroska --oac=flac')
  assert.equal(AUDIO_FORMATS.length, 6)
})

test('an audio job is --no-video and carries the playing track', () => {
  const args = audioArgs({ ...RANGE, outputFile: 'o.mp3', format: audioFormat('mp3'), aid: 2 })
  assert.ok(args.includes('--no-video'))
  assert.ok(args.includes('--aid=2'))
  // `false` is a real mpv value for aid ("no track"), and must not become
  // `--aid=false`.
  const none = audioArgs({ ...RANGE, outputFile: 'o.mp3', format: audioFormat('mp3'), aid: false })
  assert.equal(none.some((a) => a.startsWith('--aid')), false)
})

// ---------------------------------------------------------------------------
// The range, and C12's subtitle carry-over
// ---------------------------------------------------------------------------

test('the range is absolute seconds with hr-seek, on every job', () => {
  const args = audioArgs({ ...RANGE, outputFile: 'o.wav', format: audioFormat('wav') })
  assert.ok(args.includes('--start=12.000'))
  assert.ok(args.includes('--end=20.500'))
  assert.ok(args.includes('--hr-seek=yes'))
})

test('C12: burn-in is the only mode, and off is explicit', () => {
  // Subtitles are burnt in BY DEFAULT in encode mode, so "no subtitles" is the
  // case that needs an option. There is no soft-muxing branch to test because
  // encode mode has none.
  assert.deepEqual(subtitleArgs({ burn: false }), ['--sid=no'])
  assert.deepEqual(subtitleArgs({ burn: true, sid: 2, subDelay: -0.5, subScale: 1.2 }), [
    '--sid=2',
    '--sub-delay=-0.500',
    '--sub-scale=1.200',
    '--sub-ass-override=no'
  ])
  assert.deepEqual(subtitleArgs({ burn: true, sid: false }), ['--sub-ass-override=no'])
  assert.deepEqual(subtitleArgs({ burn: true, subFile: 'C:/subs/a.ass' }), [
    '--sub-file=C:/subs/a.ass',
    '--sub-ass-override=no'
  ])
  // A default delay/scale is not restated: fewer options, fewer things to be
  // wrong about.
  assert.deepEqual(subtitleArgs({ burn: true, sid: 1, subDelay: 0, subScale: 1 }), [
    '--sid=1',
    '--sub-ass-override=no'
  ])
})

// ---------------------------------------------------------------------------
// Fact 5 / §7.7 trap 8 — no Windows path inside a lavfi option
// ---------------------------------------------------------------------------

test('assertLavfiSafe refuses every spelling of an absolute path', () => {
  // All three spellings were measured failing graph parsing. The escaped ones
  // are the dangerous case: they LOOK like the fix.
  for (const bad of [
    'drawtext=fontfile=C:/fonts/a.ttf',
    'drawtext=fontfile=C\\:/fonts/a.ttf',
    'drawtext=fontfile=C\\\\:/fonts/a.ttf',
    'drawtext=fontfile=c:\\fonts\\a.ttf',
    'movie=\\\\server\\share\\pal.png'
  ]) {
    assert.throws(() => assertLavfiSafe(bad, 'test'), /absolute path/, `accepted '${bad}'`)
  }
})

test('assertLavfiSafe accepts every graph this module actually emits', () => {
  // The guard has to be a false-positive-free predicate, or it becomes the thing
  // people delete. These are the real graphs, colons, brackets, `@` and all.
  for (const good of [
    'format=yuv420p',
    'scale=1280:-2:flags=lanczos,format=yuv420p',
    'fps=15,scale=480:-2:flags=lanczos,format=rgb24,split[a][b];[a]palettegen=max_colors=192:stats_mode=single[p];[b][p]paletteuse=dither=sierra2_4a:new=1',
    'fps=1/2,scale=640:-2:flags=lanczos,format=yuvj420p',
    'fps=16/600,scale=320:-2,tile=4x4:margin=6:padding=4:color=0x1e1e1e',
    "drawtext=fontfile=sheet.ttf:text='%{pts\\:hms}':x=6:y=h-th-6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4"
  ]) {
    assert.doesNotThrow(() => assertLavfiSafe(good, 'test'), `rejected '${good}'`)
  }
})

test('C10 ships without timestamps, and the timestamped graph guards its font', () => {
  const args = sheetArgs({ outputFile: 'C:/out/s.png', durationSec: 600, cols: 4, rows: 4, tileWidth: 320, burnSubs: false })
  assert.equal(value(args, '--vf'), 'lavfi=[fps=16/600,scale=320:-2,tile=4x4:margin=6:padding=4:color=0x1e1e1e]')
  assert.equal(args.some((a) => a.includes('drawtext')), false, 'drawtext needs a cwd this module cannot set')
  assert.equal(value(args, '--ofopts'), 'update=1')
  assert.ok(args.includes('--start=0'))

  // The verified graph is kept whole and asserts its own precondition, so the
  // day `SecondaryEngineOptions` gains a `cwd` it is a one-line change. WITH a
  // cwd and a bare relative font this graph was measured producing a 43,020-byte
  // sheet; with the escaped absolute path mpv answered
  // end-file{reason:'error', file_error:'no audio or video data played'}.
  const ts = timestampedSheetArgs({ outputFile: 's.png', durationSec: 600, cols: 3, rows: 3, tileWidth: 320, burnSubs: false, fontFile: 'sheet.ttf', header: 'Ep 1' })
  assert.match(value(ts, '--vf') ?? '', /drawtext=fontfile=sheet\.ttf/)
  assert.match(value(ts, '--vf') ?? '', /pad=iw:ih\+70:0:70/)
  for (const font of ['C:/fonts/a.ttf', 'fonts/a.ttf', 'sub\\a.ttf']) {
    assert.throws(
      () => timestampedSheetArgs({ outputFile: 's.png', durationSec: 60, cols: 2, rows: 2, tileWidth: 160, burnSubs: false, fontFile: font, header: 'x' }),
      /BARE relative filename/,
      `accepted fontFile '${font}'`
    )
  }
})

test('burnSubs adds nothing and its absence adds --sid=no', () => {
  const off = sheetArgs({ outputFile: 's.png', durationSec: 60, cols: 2, rows: 2, tileWidth: 160, burnSubs: false })
  const on = sheetArgs({ outputFile: 's.png', durationSec: 60, cols: 2, rows: 2, tileWidth: 160, burnSubs: true })
  assert.ok(off.includes('--sid=no'))
  assert.equal(on.includes('--sid=no'), false)
})

// ---------------------------------------------------------------------------
// C19 — the probe line
// ---------------------------------------------------------------------------

test('the hardware probe encodes with the preset under test and nothing else', () => {
  const args = hardwareProbeArgs(clipPreset('nvenc-mp4'), 'C:/tmp/probe-nvenc.mp4')
  assert.equal(value(args, '--ovc'), 'h264_nvenc')
  assert.equal(value(args, '--ovcopts'), 'preset=p5,rc=vbr,cq=23')
  assert.equal(value(args, '--o'), 'C:/tmp/probe-nvenc.mp4')
  assert.ok(args.includes('--no-audio'))
  // --keep-open=no is what makes end-file arrive, and end-file is the only
  // verdict available: SecondaryEngine exposes no exit code.
  assert.ok(args.includes('--keep-open=no'))
})

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

test('sanitizeStem removes every Windows-illegal character', () => {
  assert.equal(sanitizeStem('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(sanitizeStem('  spaced  '), 'spaced')
  assert.equal(sanitizeStem('///'), '___')
  assert.equal(sanitizeStem(''), 'clip')
  assert.equal(sanitizeStem('   '), 'clip')
  assert.equal(sanitizeStem('a'.repeat(400)).length, 110)
  // Korean survives: it is not illegal and mangling it would be worse than the
  // problem being solved.
  assert.equal(sanitizeStem('영화 1화'), '영화 1화')
  assert.equal(sanitizeStem('a\u0007b'), 'a_b')
})

test('stampSeconds is filename-safe and sorts', () => {
  assert.equal(stampSeconds(0), '0m00s')
  assert.equal(stampSeconds(1234.5), '20m34s')
  assert.equal(stampSeconds(3661), '1h01m01s')
  assert.equal(stampSeconds(-5), '0m00s')
  assert.equal(stampSeconds(59.99), '0m59s')
})

test('uniqueName only asks the filesystem through the predicate', () => {
  const taken = new Set(['a.mp4', 'a_2.mp4'])
  assert.equal(uniqueName('a', 'mp4', (n) => taken.has(n)), 'a_3.mp4')
  assert.equal(uniqueName('b', 'mp4', () => false), 'b.mp4')
  // Exhausted: a timestamped name rather than an exception or an overwrite.
  assert.match(uniqueName('c', 'gif', () => true), /^c_\d{10,}\.gif$/)
})

test('C09 counts the files it is about to write, and the cap is a refusal', () => {
  // A two-hour film with no A-B range, at the default 5 s interval.
  assert.equal(burstFrameCount(0, 7200, 5), 1441)
  assert.ok(1441 < BURST_MAX_FRAMES, 'the default case must still be allowed')
  // The same film at 1 s is not: 7201 files is not something to discover after
  // the fact, and encode mode is faster than realtime so nothing pauses.
  assert.ok(burstFrameCount(0, 7200, 1) > BURST_MAX_FRAMES)
  // Inclusive of the first frame, and never zero.
  assert.equal(burstFrameCount(10, 20, 5), 3)
  assert.equal(burstFrameCount(10, 10, 5), 1)
  assert.equal(burstFrameCount(20, 10, 5), 1)
  assert.equal(burstFrameCount(0, 1, 0), 21, 'a zero interval is clamped to 0.05, not divided by')
})
