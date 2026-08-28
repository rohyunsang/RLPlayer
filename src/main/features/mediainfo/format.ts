/**
 * M29 mediainfo -- the value formatters.
 *
 * Pure: no `node:*`, no Electron, no DOM, no `ctx`. That is deliberate and it is
 * what makes the panel testable at all (docs/parity/02-wave0-api.md section 13:
 * "keep the logic you want to test free of Electron imports"). Everything a user
 * reads in the media-info panel is produced here from raw mpv property values,
 * so a wrong unit or a NaN is a unit-test failure rather than a screenshot in a
 * bug report.
 *
 * Two house rules run through the whole file:
 *
 *  - `undefined` IS A VALUE. mpv answers "property unavailable" for
 *    `audio-params` on a video-only file, `estimated-vf-fps` before the first
 *    frame, `file-size` on a stream, and so on. The bus passes that through
 *    (section 3), so every formatter here takes `unknown` and returns the em dash
 *    rather than "NaN", "undefined" or "0". A zero bitrate and an unknown
 *    bitrate are different facts and the panel must not merge them.
 *  - NO LOCALE. `toLocaleString()` groups digits differently per machine, which
 *    makes a test that passes here fail on a Korean CI runner. Digits are
 *    grouped by hand.
 */

/** What every formatter returns when mpv had nothing to say. */
export const UNKNOWN = '—'

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** 1234567 -> '1,234,567'. Locale-free on purpose (see the header). */
export function groupDigits(n: number): string {
  const neg = n < 0
  const digits = Math.abs(Math.trunc(n)).toString()
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return neg ? `-${out}` : out
}

/** Trim a fixed-point string of trailing zeros: '23.976000' -> '23.976'. */
export function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function formatNumber(v: unknown, decimals = 2): string {
  if (!isNum(v)) return UNKNOWN
  return trimZeros(v.toFixed(decimals))
}

/**
 * Binary units, because that is what Explorer shows for the same file and a
 * panel that disagrees with the shell about the size of a file loses the user's
 * trust for everything else on it.
 */
export function formatBytes(v: unknown): string {
  if (!isNum(v) || v < 0) return UNKNOWN
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let n = v
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const short = i === 0 ? `${groupDigits(v)} B` : `${trimZeros(n.toFixed(2))} ${units[i]}`
  return i === 0 ? short : `${short} (${groupDigits(v)} B)`
}

/** `H:MM:SS` above an hour, `M:SS` below it. Negative and unknown both dash. */
export function formatDuration(v: unknown): string {
  if (!isNum(v) || v < 0) return UNKNOWN
  const total = Math.floor(v)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** bits per second, as mpv reports `video-bitrate` / `audio-bitrate`. */
export function formatBitrate(v: unknown): string {
  if (!isNum(v) || v <= 0) return UNKNOWN
  if (v >= 1_000_000) return `${trimZeros((v / 1_000_000).toFixed(2))} Mbps`
  if (v >= 1000) return `${Math.round(v / 1000)} kbps`
  return `${Math.round(v)} bps`
}

/**
 * L23: "Overall container bitrate has no property -- compute
 * `file-size * 8 / duration`."
 *
 * Guarded on BOTH inputs, because a stream has no `file-size` and a live source
 * has `duration` 0, and `x / 0` is `Infinity`, which `formatBitrate` would
 * happily have printed as `Infinity Mbps`.
 */
export function overallBitrate(fileSize: unknown, duration: unknown): number | undefined {
  if (!isNum(fileSize) || !isNum(duration) || fileSize <= 0 || duration <= 0) return undefined
  return (fileSize * 8) / duration
}

export function formatFps(v: unknown): string {
  if (!isNum(v) || v <= 0) return UNKNOWN
  return `${trimZeros(v.toFixed(3))} fps`
}

export function formatSampleRate(v: unknown): string {
  if (!isNum(v) || v <= 0) return UNKNOWN
  return `${trimZeros((v / 1000).toFixed(1))} kHz`
}

/**
 * Channels, from the two things mpv gives us: a count and a layout name.
 *
 * `audio-params/channel-count` is a number; `channels` / `hr-channels` are
 * strings like `5.1(side)` and `5.1`. Show the human layout and keep the count,
 * because "stereo" and "2ch" are the same fact to us and not to a user chasing a
 * downmix.
 */
export function formatChannels(count: unknown, layout: unknown): string {
  const name = str(layout)
  if (isNum(count) && count > 0) return name ? `${name} (${count}ch)` : `${count}ch`
  return name ?? UNKNOWN
}

export function formatResolution(w: unknown, h: unknown): string {
  if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) return UNKNOWN
  return `${Math.round(w)}×${Math.round(h)}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * A display aspect as a ratio a human recognises.
 *
 * mpv's own `video-params/aspect-name` answers this when it can; this is the
 * fallback for when it cannot, and for the probe path, which has no
 * `video-params` at all (L22: those need an initialised decoder).
 */
export function formatAspect(w: unknown, h: unknown): string {
  if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) return UNKNOWN
  const known: ReadonlyArray<[number, number]> = [
    [16, 9],
    [4, 3],
    [21, 9],
    [16, 10],
    [3, 2],
    [5, 4],
    [1, 1],
    [2.39, 1],
    [1.85, 1]
  ]
  const ratio = w / h
  for (const [a, b] of known) {
    if (Math.abs(ratio - a / b) < 0.01) {
      return Number.isInteger(a) ? `${a}:${b}` : `${trimZeros(a.toFixed(2))}:${b}`
    }
  }
  const g = gcd(Math.round(w), Math.round(h)) || 1
  const rw = Math.round(w) / g
  const rh = Math.round(h) / g
  // A reduced pair with four-digit terms tells nobody anything; the decimal does.
  if (rw > 99 || rh > 99) return `${trimZeros(ratio.toFixed(2))}:1`
  return `${rw}:${rh}`
}

/**
 * mpv's `file-format`, made readable WITHOUT throwing the raw value away.
 *
 * L23: "mp4 reports the comma list `mov,mp4,m4a,3gp,3g2,mj2`". That is
 * libavformat's demuxer name list, not a container name, so showing it raw makes
 * an MP4 look like six things at once -- and dropping it loses the one string
 * that is worth pasting into a bug report. So: a friendly short name picked from
 * the list by preference, and the raw value kept beside it.
 */
const CONTAINER_NAMES: Readonly<Record<string, string>> = {
  mp4: 'MP4',
  matroska: 'Matroska (MKV)',
  webm: 'WebM',
  avi: 'AVI',
  mov: 'QuickTime (MOV)',
  mpegts: 'MPEG-TS',
  mpeg: 'MPEG-PS',
  flv: 'FLV',
  asf: 'ASF/WMV',
  ogg: 'Ogg',
  wav: 'WAV',
  mp3: 'MP3',
  flac: 'FLAC',
  aac: 'AAC',
  ape: 'Monkey’s Audio',
  hls: 'HLS',
  'mov,mp4,m4a,3gp,3g2,mj2': 'MP4'
}
/** Which member of a comma list to believe, most specific first. */
const CONTAINER_PREFERENCE = ['matroska', 'webm', 'mp4', 'mov', 'mpegts', 'flac', 'wav', 'mp3']

export function containerLabel(fileFormat: unknown): string {
  const raw = str(fileFormat)
  if (!raw) return UNKNOWN
  const direct = CONTAINER_NAMES[raw]
  if (direct) return raw.includes(',') ? `${direct} (${raw})` : direct
  const tokens = raw.split(',').map((t) => t.trim().toLowerCase())
  const picked = CONTAINER_PREFERENCE.find((p) => tokens.includes(p)) ?? tokens[0] ?? raw
  const friendly = CONTAINER_NAMES[picked] ?? picked.toUpperCase()
  return tokens.length > 1 ? `${friendly} (${raw})` : friendly
}

/**
 * A codec, from the `current-tracks/...` forms ONLY.
 *
 * L23's trap, verbatim: `video-codec`, `video-format`, `audio-codec` and
 * `audio-codec-name` are not in the current manual and survive only as
 * undocumented aliases of these. Nothing in this module reads them, and this
 * signature is why -- it takes the three fields the manual documents.
 */
export function codecLabel(desc: unknown, codec: unknown, profile: unknown): string {
  const d = str(desc)
  const c = str(codec)
  const p = str(profile)
  const base = d ?? c
  if (!base) return UNKNOWN
  const withCodec = d && c && !d.toLowerCase().includes(c.toLowerCase()) ? `${d} [${c}]` : base
  // L24: "`codec-profile` only exists once the track has been decoded", so the
  // profile is additive and never load-bearing.
  return p ? `${withCodec}, ${p}` : withCodec
}

/** `hwdec-current` is the string `'no'` when software decoding, never absent. */
export function hwdecLabel(current: unknown, interop: unknown): string {
  const c = str(current)
  if (!c || c === 'no') return 'no (software)'
  const i = str(interop)
  return i && i !== 'no' ? `${c} (${i})` : c
}

export function formatPercent(v: unknown, decimals = 1): string {
  if (!isNum(v)) return UNKNOWN
  return `${trimZeros((v * 100).toFixed(decimals))}%`
}

/** `demuxer-cache-state/raw-input-rate` is bytes per second (R34). */
export function formatByteRate(v: unknown): string {
  if (!isNum(v) || v <= 0) return UNKNOWN
  if (v >= 1024 * 1024) return `${trimZeros((v / (1024 * 1024)).toFixed(2))} MiB/s`
  if (v >= 1024) return `${trimZeros((v / 1024).toFixed(1))} KiB/s`
  return `${Math.round(v)} B/s`
}

export function formatBool(v: unknown, yes: string, no: string): string {
  if (typeof v !== 'boolean') return UNKNOWN
  return v ? yes : no
}

/** A wall-clock stamp for the file-properties view. Locale-free, sortable. */
export function formatTimestamp(ms: unknown): string {
  if (!isNum(ms) || ms <= 0) return UNKNOWN
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** A language tag as mpv reports it, upper-cased for the track list. */
export function langLabel(v: unknown): string {
  const s = str(v)
  return s ? s.toUpperCase() : UNKNOWN
}

/** The value, or the dash. For strings straight off a property. */
export function textOr(v: unknown): string {
  return str(v) ?? (isNum(v) ? String(v) : UNKNOWN)
}
