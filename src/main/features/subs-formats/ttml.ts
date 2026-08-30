/**
 * S07 — TTML / DFXP.
 *
 * `FFmpeg has a TTML muxer but no demuxer`, so there is nothing to configure:
 * either this module converts the file or the file does not play. Verified on
 * the pinned binary — a valid TTML passed as `--sub-file`:
 *
 *   t.ttml   (no sub demuxer matched at all)   @@SUB=[(unavailable)]
 *
 * Compare the SAMI fixtures, which at least reach `Found 'sami' at score=1`.
 * TTML does not even get an extension fallback, because `ttml` is not in mpv's
 * `--sub-auto-exts`.
 *
 * Output is SRT, as the row specifies. A DOM parser is not available in the main
 * process, and pulling one in for a P2 sidecar format would be a dependency for
 * a file shape that is `rare as a sidecar on a Windows disk` — so this is a
 * tag scanner over the `<p>` elements, which is all TTML-as-subtitles is.
 */

import { decodeEntities } from './smi.ts'

export interface TtmlCue {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  /** `xml:lang` in scope, lower-cased, or `''`. */
  readonly lang: string
}

export interface TtmlDocument {
  readonly cues: readonly TtmlCue[]
  /** Every distinct in-scope `xml:lang`, in first-appearance order. */
  readonly langs: readonly string[]
  readonly tickRate: number
  readonly frameRate: number
}

const DEFAULT_TICK_RATE = 1
const DEFAULT_FRAME_RATE = 30

/**
 * Every TTML time expression the spec row calls for.
 *
 * `clock-time`   `hh:mm:ss`, `hh:mm:ss.fff`, `hh:mm:ss:ff` (frames)
 * `offset-time`  `123.4s`, `500ms`, `3.5m`, `1h`, `12f`, `3000t`
 *
 * Returns null for anything else, and null must be treated as "no cue" rather
 * than as zero: a cue silently placed at 00:00 is the failure mode this whole
 * module exists to avoid.
 */
export function parseTtmlTime(
  raw: string | undefined,
  tickRate: number,
  frameRate: number
): number | null {
  if (!raw) return null
  const v = raw.trim()
  if (v.length === 0) return null

  const offset = /^([0-9]+(?:\.[0-9]+)?)(h|m|s|ms|f|t)$/i.exec(v)
  if (offset) {
    const n = Number.parseFloat(offset[1] ?? '')
    if (!Number.isFinite(n)) return null
    switch ((offset[2] ?? '').toLowerCase()) {
      case 'h':
        return n * 3600000
      case 'm':
        return n * 60000
      case 's':
        return n * 1000
      case 'ms':
        return n
      case 'f':
        return frameRate > 0 ? (n / frameRate) * 1000 : null
      case 't':
        return tickRate > 0 ? (n / tickRate) * 1000 : null
      default:
        return null
    }
  }

  const clock = /^([0-9]+):([0-5][0-9]):([0-5][0-9])(?:([.,])([0-9]+)|:([0-9]+))?$/.exec(v)
  if (clock) {
    const h = Number.parseInt(clock[1] ?? '0', 10)
    const m = Number.parseInt(clock[2] ?? '0', 10)
    const s = Number.parseInt(clock[3] ?? '0', 10)
    let ms = 0
    if (clock[5] !== undefined) ms = Number.parseFloat(`0.${clock[5]}`) * 1000
    else if (clock[6] !== undefined && frameRate > 0) {
      ms = (Number.parseInt(clock[6], 10) / frameRate) * 1000
    }
    return h * 3600000 + m * 60000 + s * 1000 + ms
  }
  return null
}

function attrOf(attrs: string, name: string): string | undefined {
  // `xml:lang` and `ttp:tickRate` are namespaced; match the local name so a
  // document using a different prefix (or none) still works.
  const local = name.replace(/^.*:/, '')
  const re = new RegExp(
    `(?:^|\\s)(?:[A-Za-z0-9_.-]+:)?${local}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    'i'
  )
  const m = re.exec(attrs)
  return m?.[2] ?? m?.[3]
}

export function parseTtml(xml: string): TtmlDocument {
  const ttMatch = /<\s*(?:[A-Za-z0-9_.-]+:)?tt\b([^>]*)>/i.exec(xml)
  const ttAttrs = ttMatch?.[1] ?? ''
  const tickRate = Number.parseFloat(attrOf(ttAttrs, 'tickRate') ?? '') || DEFAULT_TICK_RATE
  const frameRate = Number.parseFloat(attrOf(ttAttrs, 'frameRate') ?? '') || DEFAULT_FRAME_RATE
  const rootLang = (attrOf(ttAttrs, 'xml:lang') ?? '').toLowerCase()

  const cues: TtmlCue[] = []
  const langs: string[] = []

  // One pass over every opening tag, keeping an `xml:lang` stack. `<div>` is
  // where per-language grouping lives in every real TTML sidecar.
  const tagRe = /<\s*(\/?)\s*(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)([^>]*?)(\/?)>/g
  const langStack: string[] = [rootLang]
  let m: RegExpExecArray | null
  let pending: { start: number; end: number | null; lang: string; from: number } | null = null

  while ((m = tagRe.exec(xml)) !== null) {
    const closing = m[1] === '/'
    const name = (m[2] ?? '').toLowerCase()
    const attrs = m[3] ?? ''
    const selfClosing = m[4] === '/'

    if (name === 'p' && pending && closing) {
      const inner = xml.slice(pending.from, m.index)
      const text = ttmlTextToPlain(inner)
      const end = pending.end ?? pending.start + 3000
      if (text.length > 0 && end > pending.start) {
        cues.push({ startMs: pending.start, endMs: end, text, lang: pending.lang })
        if (!langs.includes(pending.lang)) langs.push(pending.lang)
      }
      pending = null
      continue
    }

    if (closing) {
      if (name === 'div' || name === 'body' || name === 'tt') {
        if (langStack.length > 1) langStack.pop()
      }
      continue
    }

    const own = (attrOf(attrs, 'xml:lang') ?? '').toLowerCase()
    if (name === 'div' || name === 'body') {
      langStack.push(own.length > 0 ? own : (langStack[langStack.length - 1] ?? ''))
      continue
    }

    if (name === 'p' && !selfClosing) {
      const start = parseTtmlTime(attrOf(attrs, 'begin'), tickRate, frameRate)
      if (start === null) continue
      let end = parseTtmlTime(attrOf(attrs, 'end'), tickRate, frameRate)
      if (end === null) {
        const dur = parseTtmlTime(attrOf(attrs, 'dur'), tickRate, frameRate)
        end = dur !== null ? start + dur : null
      }
      const lang = own.length > 0 ? own : (langStack[langStack.length - 1] ?? '')
      pending = { start, end, lang, from: m.index + m[0].length }
    }
  }

  return { cues, langs, tickRate, frameRate }
}

/** `<br/>` -> newline, `<span>` and the rest -> gone, entities decoded. */
export function ttmlTextToPlain(inner: string): string {
  return decodeEntities(
    inner
      .replace(/<\s*(?:[A-Za-z0-9_.-]+:)?br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim()
}
