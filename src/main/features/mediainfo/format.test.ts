import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UNKNOWN,
  codecLabel,
  containerLabel,
  formatAspect,
  formatBitrate,
  formatBool,
  formatByteRate,
  formatBytes,
  formatChannels,
  formatDuration,
  formatFps,
  formatNumber,
  formatPercent,
  formatResolution,
  formatSampleRate,
  formatTimestamp,
  groupDigits,
  hwdecLabel,
  isNum,
  langLabel,
  overallBitrate,
  textOr,
  trimZeros
} from './format.ts'

/**
 * M29's formatters.
 *
 * Every test here asserts a RESULT STRING, never that a function was called.
 * The whole reason `format.ts` exists as a pure module is that a wrong unit in a
 * media-info panel is otherwise only ever found in a screenshot.
 *
 * The theme running through it: `undefined` IS A VALUE. mpv answers "property
 * unavailable" for `audio-params` on a video-only file, `estimated-vf-fps`
 * before the first frame and `file-size` on a stream, and the bus passes that
 * through rather than coercing it (section 3). A panel that prints `0 bps` for
 * "unknown bitrate" is claiming a measurement it does not have.
 */

test('every formatter answers the dash for undefined, null and NaN', () => {
  const absent = [undefined, null, Number.NaN, Infinity, -Infinity, {}, [], 'x']
  for (const v of absent) {
    assert.equal(formatBytes(v), UNKNOWN, `formatBytes(${String(v)})`)
    assert.equal(formatDuration(v), UNKNOWN, `formatDuration(${String(v)})`)
    assert.equal(formatBitrate(v), UNKNOWN, `formatBitrate(${String(v)})`)
    assert.equal(formatFps(v), UNKNOWN, `formatFps(${String(v)})`)
    assert.equal(formatSampleRate(v), UNKNOWN, `formatSampleRate(${String(v)})`)
    assert.equal(formatByteRate(v), UNKNOWN, `formatByteRate(${String(v)})`)
  }
  // …but a *string* is a legitimate value for the text formatters.
  assert.equal(textOr('yuv420p'), 'yuv420p')
  assert.equal(textOr(''), UNKNOWN)
  assert.equal(textOr(0), '0')
  assert.equal(textOr(undefined), UNKNOWN)
})

test('a ZERO bitrate and an UNKNOWN bitrate are the same dash, and 1 bps is not', () => {
  // mpv reports 0 for a track it has not measured yet, and the panel must not
  // print "0 kbps" as if it were a fact.
  assert.equal(formatBitrate(0), UNKNOWN)
  assert.equal(formatBitrate(1), '1 bps')
  assert.equal(formatBitrate(-5), UNKNOWN)
})

test('isNum rejects everything a JSON property can be except a finite number', () => {
  assert.equal(isNum(1), true)
  assert.equal(isNum(0), true)
  assert.equal(isNum(-1.5), true)
  assert.equal(isNum(Number.NaN), false)
  assert.equal(isNum(Infinity), false)
  assert.equal(isNum('1'), false)
  assert.equal(isNum(null), false)
  assert.equal(isNum(undefined), false)
  assert.equal(isNum(true), false)
})

test('digits are grouped without toLocaleString, so a Korean runner agrees', () => {
  assert.equal(groupDigits(0), '0')
  assert.equal(groupDigits(1), '1')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(1000), '1,000')
  assert.equal(groupDigits(1234567), '1,234,567')
  assert.equal(groupDigits(-1234567), '-1,234,567')
})

test('trimZeros keeps integers intact and strips only trailing fraction zeros', () => {
  assert.equal(trimZeros('23.976000'), '23.976')
  assert.equal(trimZeros('24.000'), '24')
  assert.equal(trimZeros('1000'), '1000')
  assert.equal(trimZeros('0.10'), '0.1')
})

test('sizes use binary units AND keep the exact byte count', () => {
  // Explorer shows the same file as GiB; a panel that disagrees with the shell
  // about a file size loses the user's trust for everything else on it.
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1 KiB (1,024 B)')
  assert.equal(formatBytes(1536), '1.5 KiB (1,536 B)')
  assert.equal(formatBytes(1_073_741_824), '1 GiB (1,073,741,824 B)')
})

test('durations switch from M:SS to H:MM:SS at the hour', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(9), '0:09')
  assert.equal(formatDuration(61), '1:01')
  assert.equal(formatDuration(599), '9:59')
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatDuration(3661), '1:01:01')
  assert.equal(formatDuration(36000), '10:00:00')
  assert.equal(formatDuration(-1), UNKNOWN)
})

test('bitrates cross to kbps at 1000 and Mbps at a million', () => {
  assert.equal(formatBitrate(999), '999 bps')
  assert.equal(formatBitrate(1000), '1 kbps')
  assert.equal(formatBitrate(128_000), '128 kbps')
  assert.equal(formatBitrate(999_999), '1000 kbps')
  assert.equal(formatBitrate(1_000_000), '1 Mbps')
  assert.equal(formatBitrate(8_450_000), '8.45 Mbps')
})

test('L23: the overall container bitrate is computed and NEVER divides by zero', () => {
  // "Overall container bitrate has no property — compute file-size*8/duration."
  // A live stream has duration 0 and a stream has no file-size, and Infinity
  // would have printed as `Infinity Mbps`.
  assert.equal(overallBitrate(1_000_000, 8), 1_000_000)
  assert.equal(overallBitrate(1_000_000, 0), undefined)
  assert.equal(overallBitrate(undefined, 8), undefined)
  assert.equal(overallBitrate(1_000_000, undefined), undefined)
  assert.equal(overallBitrate(0, 8), undefined)
  assert.equal(overallBitrate(-1, 8), undefined)
})

test('fps keeps three decimals, so 23.976 never renders as 24', () => {
  assert.equal(formatFps(23.976024), '23.976 fps')
  assert.equal(formatFps(24), '24 fps')
  assert.equal(formatFps(59.94006), '59.94 fps')
  assert.equal(formatFps(0), UNKNOWN)
})

test('sample rate is kHz with one decimal', () => {
  assert.equal(formatSampleRate(48000), '48 kHz')
  assert.equal(formatSampleRate(44100), '44.1 kHz')
  assert.equal(formatSampleRate(0), UNKNOWN)
})

test('A45: channels show the LAYOUT and keep the count', () => {
  // "stereo" and "2ch" are the same fact to us and not to a user chasing a
  // downmix, which is the whole subject of A45.
  assert.equal(formatChannels(6, '5.1(side)'), '5.1(side) (6ch)')
  assert.equal(formatChannels(2, 'stereo'), 'stereo (2ch)')
  assert.equal(formatChannels(2, undefined), '2ch')
  assert.equal(formatChannels(undefined, 'stereo'), 'stereo')
  assert.equal(formatChannels(undefined, undefined), UNKNOWN)
  assert.equal(formatChannels(0, ''), UNKNOWN)
})

test('resolution rounds and refuses a zero dimension', () => {
  assert.equal(formatResolution(1920, 1080), '1920×1080')
  assert.equal(formatResolution(1919.6, 1080.4), '1920×1080')
  assert.equal(formatResolution(0, 1080), UNKNOWN)
  assert.equal(formatResolution(1920, undefined), UNKNOWN)
})

test('aspect names the ratio a human recognises, and falls back to a decimal', () => {
  assert.equal(formatAspect(1920, 1080), '16:9')
  assert.equal(formatAspect(640, 480), '4:3')
  assert.equal(formatAspect(1920, 800), '2.39:1')
  assert.equal(formatAspect(1440, 1080), '4:3')
  assert.equal(formatAspect(1080, 1080), '1:1')
  // A reduced pair with three-digit terms tells nobody anything.
  assert.equal(formatAspect(1001, 337), '2.97:1')
  assert.equal(formatAspect(0, 0), UNKNOWN)
})

test('REAL ultrawide is 64:27, not the 21:9 the table names', () => {
  /**
   * MEASURED, and it is the reason the `[21, 9]` entry in the table is worth a
   * comment rather than a wider tolerance. `21/9` is 2.3333; the two
   * resolutions ultrawide content actually ships in are
   *
   *   2560x1080 -> exactly 64:27 = 2.3704  -> renders '64:27'
   *   3440x1440 -> exactly 43:18 = 2.3889  -> renders '2.39:1' (within 0.0011
   *                                           of the named cinema-scope entry)
   *
   * Neither reaches `[21, 9]`, which is the point. `21:9` is a marketing name
   * covering two different real ratios and this panel's job is to report what
   * the container declares -- so the named entry only ever fires for a
   * synthetic 2.3333 file. This test exists so nobody "fixes" that by widening
   * the tolerance to 0.05, which would fold 2.39:1 into 21:9 as well and make
   * a scope film and an ultrawide monitor capture indistinguishable.
   */
  assert.equal(formatAspect(2560, 1080), '64:27')
  assert.equal(formatAspect(3440, 1440), '2.39:1')
  // The synthetic exact case, so the entry is demonstrably not dead code.
  assert.equal(formatAspect(2100, 900), '21:9')
})

test('L23: mp4 reports a comma LIST and the raw value is kept beside the name', () => {
  // "mp4 reports the comma list `mov,mp4,m4a,3gp,3g2,mj2`" — that is
  // libavformat's demuxer list, not a container name. Showing it raw makes an
  // MP4 look like six things; dropping it loses the string worth pasting into
  // a bug report.
  assert.equal(
    containerLabel('mov,mp4,m4a,3gp,3g2,mj2'),
    'MP4 (mov,mp4,m4a,3gp,3g2,mj2)'
  )
  assert.equal(containerLabel('matroska,webm'), 'Matroska (MKV) (matroska,webm)')
  assert.equal(containerLabel('mpegts'), 'MPEG-TS')
  assert.equal(containerLabel('weird-new-thing'), 'WEIRD-NEW-THING')
  assert.equal(containerLabel(undefined), UNKNOWN)
  assert.equal(containerLabel(''), UNKNOWN)
})

test('L23 trap: codecs come from current-tracks/… and the profile is additive', () => {
  // `video-codec`/`audio-codec-name` are undocumented aliases and nothing in
  // this module reads one; `codecLabel`'s signature is what enforces that.
  assert.equal(
    codecLabel('H.264 / AVC / MPEG-4 AVC', 'h264', 'High'),
    'H.264 / AVC / MPEG-4 AVC, High'
  )
  // The desc that does NOT mention the codec id gets it appended, so `hevc` vs
  // `h264` is still visible when the desc is a marketing name.
  assert.equal(codecLabel('Dolby Vision', 'hevc', undefined), 'Dolby Vision [hevc]')
  // L24: "codec-profile only exists once the track has been decoded", so an
  // absent profile is normal and never load-bearing.
  assert.equal(codecLabel('AAC', 'aac', undefined), 'AAC')
  assert.equal(codecLabel(undefined, 'aac', 'LC'), 'aac, LC')
  assert.equal(codecLabel(undefined, undefined, 'High'), UNKNOWN)
})

test("hwdec-current is the STRING 'no' for software decoding, never absent", () => {
  assert.equal(hwdecLabel('d3d11va-copy', 'd3d11va'), 'd3d11va-copy (d3d11va)')
  assert.equal(hwdecLabel('d3d11va', 'no'), 'd3d11va')
  assert.equal(hwdecLabel('no', 'no'), 'no (software)')
  assert.equal(hwdecLabel(undefined, undefined), 'no (software)')
})

test('booleans keep the three-way distinction: yes, no, and unknown', () => {
  assert.equal(formatBool(true, 'yes', 'no'), 'yes')
  assert.equal(formatBool(false, 'yes', 'no'), 'no')
  // mpv reports `deinterlace-active` as unavailable with no video, and "no"
  // would be a claim.
  assert.equal(formatBool(undefined, 'yes', 'no'), UNKNOWN)
  assert.equal(formatBool('true', 'yes', 'no'), UNKNOWN)
})

test('R34: the cache input rate is BYTES per second in binary units', () => {
  assert.equal(formatByteRate(512), '512 B/s')
  assert.equal(formatByteRate(2048), '2 KiB/s')
  assert.equal(formatByteRate(5 * 1024 * 1024), '5 MiB/s')
  assert.equal(formatByteRate(0), UNKNOWN)
})

test('timestamps are locale-free and sortable, and 0 is not 1970', () => {
  const stamp = formatTimestamp(new Date(2026, 7, 28, 9, 5, 3).getTime())
  assert.equal(stamp, '2026-08-28 09:05:03')
  assert.equal(formatTimestamp(0), UNKNOWN)
  assert.equal(formatTimestamp(undefined), UNKNOWN)
})

test('language tags upper-case, percentages and plain numbers', () => {
  assert.equal(langLabel('kor'), 'KOR')
  assert.equal(langLabel(''), UNKNOWN)
  assert.equal(formatPercent(0.5), '50%')
  assert.equal(formatPercent(0.1234, 2), '12.34%')
  assert.equal(formatPercent(undefined), UNKNOWN)
  assert.equal(formatNumber(1.23456, 4), '1.2346')
  assert.equal(formatNumber(2, 4), '2')
  assert.equal(formatNumber(undefined), UNKNOWN)
})
