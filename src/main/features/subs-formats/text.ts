/**
 * Bytes -> string, and the honest limits of doing it ourselves.
 *
 * S33's detection order is mpv's, and mpv's fourth step is **uchardet**, a C
 * library linked into the pinned binary (`uchardet=enabled` in its
 * `List of enabled features`). We cannot call it: this is a TypeScript process,
 * `ctx.network` reaches zero hosts, and shelling out per subtitle file to ask
 * mpv would be a second mpv per hover.
 *
 * So there are TWO detectors in this product and they are not the same one:
 *
 *  - everything mpv decodes itself (every format in `--sub-auto-exts` that
 *    probes, which is S02's well-formed CP949 SAMI included) uses uchardet, and
 *    S33's job is to leave it alone and assert it is there;
 *  - the files THIS module rewrites (S03 split, S04 normalisation, S07 TTML)
 *    have to be decoded here, before mpv ever sees them, and they get
 *    `detectEncoding` below: BOM, then a strict UTF-8 validation, then a
 *    CJK scoring pass with a Korean prior.
 *
 * That asymmetry is a real limitation and it is written down rather than hidden:
 * a Japanese Shift-JIS `.smi` with two classes could be mis-decoded by our
 * detector where mpv's uchardet would have been right. The escape hatch is the
 * S34 dropdown, which forces BOTH decoders at once — the mpv value and our
 * `TextDecoder` label come from one row of `codepages.ts`.
 */

export interface DecodeResult {
  readonly text: string
  /** The WHATWG label actually used. */
  readonly encoding: string
  /** True when a BOM was found and stripped. */
  readonly bom: boolean
  /** True when `encoding` came from the S34 override rather than detection. */
  readonly forced: boolean
}

const HANGUL_SYLLABLE = /[가-힣]/
const REPLACEMENT = '�'

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/** Strict UTF-8: the whole buffer must be valid, which is mpv's third step. */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * How plausible `label` is for these bytes.
 *
 * Two terms, and the second is why a Korean-market player does not simply take
 * "fewest replacement characters": CP949 and GB18030 and Big5 all accept most
 * CP949 byte pairs without producing U+FFFD, they just produce the WRONG
 * characters. The tiebreak is therefore how much of the decoded text lands in
 * the Hangul syllable block, which is the one thing a real `.smi` from a Korean
 * rip is full of and a mis-decode is not.
 */
export function scoreEncoding(bytes: Uint8Array, label: string): number {
  const text = tryDecode(bytes, label)
  if (text === null || text.length === 0) return -1
  let bad = 0
  let hangul = 0
  let cjk = 0
  for (const ch of text) {
    if (ch === REPLACEMENT) bad++
    else if (HANGUL_SYLLABLE.test(ch)) hangul++
    else {
      const cp = ch.codePointAt(0) ?? 0
      // CJK unified ideographs, kana, and the compatibility jamo block: a
      // mis-decode of Hangul into Chinese lands here, so it must NOT count as
      // evidence for the encoding that produced it. Counted only to keep the
      // ratio honest.
      if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x4e00 && cp <= 0x9fff)) cjk++
    }
  }
  const total = text.length
  return (hangul * 3 + cjk) / total - (bad / total) * 20
}

/** Candidate order matters only for exact ties; the Korean labels come first. */
const CJK_CANDIDATES = ['euc-kr', 'gb18030', 'shift_jis', 'big5', 'windows-1252'] as const

/**
 * @param forcedLabel a `TextDecoder` label from the S34 dropdown, or null for
 *        `auto`. A forced label wins over EVERYTHING, BOM included, because
 *        that is what mpv's `+` prefix does and the two must not disagree about
 *        the same file.
 */
export function decodeSubtitle(bytes: Uint8Array, forcedLabel: string | null): DecodeResult {
  if (forcedLabel) {
    const text = tryDecode(bytes, forcedLabel)
    if (text !== null) {
      return { text: stripBom(text), encoding: forcedLabel, bom: hasBom(bytes), forced: true }
    }
  }
  const bom = detectBom(bytes)
  if (bom) {
    const text = tryDecode(bytes, bom) ?? ''
    return { text: stripBom(text), encoding: bom, bom: true, forced: false }
  }
  if (looksLikeUtf8(bytes)) {
    return { text: tryDecode(bytes, 'utf-8') ?? '', encoding: 'utf-8', bom: false, forced: false }
  }
  let best = CJK_CANDIDATES[0] as string
  let bestScore = -Infinity
  for (const label of CJK_CANDIDATES) {
    const s = scoreEncoding(bytes, label)
    if (s > bestScore) {
      bestScore = s
      best = label
    }
  }
  return { text: tryDecode(bytes, best) ?? '', encoding: best, bom: false, forced: false }
}

function hasBom(bytes: Uint8Array): boolean {
  return detectBom(bytes) !== null
}

/** The three BOMs FFmpeg's `FFTextReader` also understands. */
export function detectBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8'
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Bake `sub-delay` and `sub-speed` into a subtitle timestamp (S42).
 *
 * mpv maps a subtitle event's own timestamp to video time as
 * `t_video = t_sub * sub_speed + sub_delay` (`pts_from_subtitle` in
 * `dec_sub.c`; the manual's wording for `--sub-speed` is "multiply the subtitle
 * event timestamps with the given value", and `--sub-delay` "delays primary
 * subtitles by <sec>"). Exporting means writing the times the user is CURRENTLY
 * seeing, so the same expression is the whole transform — and then the exported
 * file is correct only with delay 0 and speed 1, which the export dialog says.
 */
export function bakeTime(seconds: number, delay: number, speed: number): number {
  const s = seconds * (speed > 0 ? speed : 1) + delay
  return s < 0 ? 0 : s
}

/** `00:01:02,500` — SRT's comma. */
export function formatSrtTime(seconds: number): string {
  return formatClock(seconds, ',', 3)
}

/** `0:01:02.50` — ASS's single-digit hour and centiseconds. */
export function formatAssTime(seconds: number): string {
  const t = Math.max(0, seconds)
  const cs = Math.round(t * 100)
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(c, 2)}`
}

function formatClock(seconds: number, decimalSep: string, digits: number): string {
  const t = Math.max(0, seconds)
  const scale = 10 ** digits
  const ticks = Math.round(t * scale)
  const h = Math.floor(ticks / (3600 * scale))
  const m = Math.floor((ticks % (3600 * scale)) / (60 * scale))
  const s = Math.floor((ticks % (60 * scale)) / scale)
  const frac = ticks % scale
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${decimalSep}${pad(frac, digits)}`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
