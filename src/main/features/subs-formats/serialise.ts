/**
 * S42 — read a subtitle back, bake `sub-delay`/`sub-speed` in, write it out.
 *
 * `mpv cannot write subtitle files, do not go looking for a command` — the row
 * says so and it is true: there is no `sub-save`, no `sub-dump`, nothing in the
 * pinned binary's `--input-cmdlist`. So the whole feature is parse + transform +
 * serialise, and its correctness rests on one expression, `bakeTime()`.
 */

import { bakeTime, formatSrtTime } from './text.ts'
import { cuesByClass, decodeEntities, langOfStyle, parseSmi } from './smi.ts'
import type { Cue } from './smi.ts'

export type ExportFormat = 'srt' | 'smi'

/** The formats we can read back for export. */
export function isReadableForExport(file: string): boolean {
  return /\.(srt|vtt|ass|ssa|smi|sami)$/i.test(file)
}

export interface ReadOptions {
  /**
   * For a multi-class SMI, which class to export.
   *
   * ONE CLASS, NOT ALL OF THEM. Merging KRCC and ENCC gives a file with two cues
   * at every timestamp — a "subtitle" that shows both languages stacked, which
   * is not a thing the user asked for and is not a thing any editor can fix
   * afterwards. When the caller knows which language is on screen (it does: it
   * either converted the file or it can read the selected track's class), it
   * says so; otherwise `preferredLangs` decides and `exportedClass` reports what
   * was chosen so the UI can say it out loud.
   */
  readonly className?: string
  readonly preferredLangs?: readonly string[]
}

export interface ReadResult {
  readonly cues: Cue[]
  /** The SMI class actually exported, `''` for a class-less or non-SMI source. */
  readonly exportedClass: string
  /** Every class the source offered, so the caller can offer the others. */
  readonly classes: readonly string[]
}

export function readSubtitle(text: string, file: string, o: ReadOptions = {}): ReadResult {
  if (/\.(smi|sami)$/i.test(file)) {
    const doc = parseSmi(text)
    const byClass = cuesByClass(doc)
    const real = [...byClass.entries()].filter(([, cues]) => cues.length > 0)
    const classes = real.map(([id]) => id)
    let pick = real.find(([id]) => id === o.className)
    if (!pick) {
      for (const want of o.preferredLangs ?? []) {
        pick = real.find(([id]) => langOfStyle(doc.styles.get(id), id) === want)
        if (pick) break
      }
    }
    if (!pick) pick = real[0]
    return {
      cues: [...(pick?.[1] ?? [])].sort((a, b) => a.startMs - b.startMs),
      exportedClass: pick?.[0] ?? '',
      classes
    }
  }
  if (/\.(ass|ssa)$/i.test(file)) {
    return { cues: parseAssCues(text), exportedClass: '', classes: [] }
  }
  if (/\.vtt$/i.test(file)) return { cues: parseVttCues(text), exportedClass: '', classes: [] }
  return { cues: parseSrtCues(text), exportedClass: '', classes: [] }
}

/** The cue list alone, for callers that do not care which class it came from. */
export function readCues(text: string, file: string, o: ReadOptions = {}): Cue[] {
  return readSubtitle(text, file, o).cues
}

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/g

function timeToMs(h: string, m: string, s: string, frac: string): number {
  return (
    Number.parseInt(h, 10) * 3600000 +
    Number.parseInt(m, 10) * 60000 +
    Number.parseInt(s, 10) * 1000 +
    Number.parseInt(frac.padEnd(3, '0'), 10)
  )
}

/**
 * SRT (and, through `parseVttCues`, WebVTT).
 *
 * THE TIMING LINE IS FOUND BY LOOKING FOR `-->`, not by counting lines. The
 * first version took line 0, or line 1 when line 0 was all digits — which is
 * true of SRT and false of WebVTT, whose cue identifier is an arbitrary string
 * (`cue-1`, `intro`, a UUID). Measured on a five-line VTT with named cues:
 *
 *   parseVttCues(vtt).length  ->  0   (before)
 *   parseVttCues(vtt).length  ->  1   (after)
 *
 * S42 offers "save the subtitle" for whatever is selected, and a `.vtt` sidecar
 * is an ordinary thing to have selected, so the export silently wrote an empty
 * file for a whole format. Searching for the arrow costs nothing and is correct
 * for both.
 */
export function parseSrtCues(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    const idx = lines.findIndex((l) => l.includes('-->'))
    if (idx < 0) continue
    const timing = lines[idx] ?? ''
    SRT_TIME.lastIndex = 0
    const a = SRT_TIME.exec(timing)
    const b = SRT_TIME.exec(timing)
    if (!a || !b) continue
    const startMs = timeToMs(a[1] ?? '0', a[2] ?? '0', a[3] ?? '0', a[4] ?? '0')
    const endMs = timeToMs(b[1] ?? '0', b[2] ?? '0', b[3] ?? '0', b[4] ?? '0')
    const body = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<[^>]*>/g, '')
    if (body.trim().length === 0 || endMs <= startMs) continue
    cues.push({ startMs, endMs, text: decodeEntities(body), ruby: '' })
  }
  return cues
}

export function parseVttCues(text: string): Cue[] {
  // WebVTT is SRT with a `WEBVTT` header, `.` for the decimal separator (which
  // `SRT_TIME` already accepts), optional cue ids and `NOTE`/`STYLE` blocks.
  // A `NOTE` / `STYLE` / `REGION` block runs to the next BLANK LINE, so the
  // terminator cannot be `$` under /m — that matches the end of the first line
  // and leaves the rest of the comment behind as a pseudo-cue.
  const stripped = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF?WEBVTT[^\n]*\n/i, '')
    .replace(/^(?:NOTE|STYLE|REGION)\b[\s\S]*?(?:\n\n|$)/gm, '')
  return parseSrtCues(stripped)
}

/**
 * ASS in.
 *
 * THE `Format:` LINE IS TAKEN FROM `[Events]` AND NOWHERE ELSE, and getting
 * that wrong made this function return an EMPTY LIST for every ASS file this
 * module itself writes. An ASS script has two `Format:` lines and the styles one
 * comes first:
 *
 *   [V4+ Styles]
 *   Format: Name, Fontname, Fontsize, PrimaryColour, …      <- 23 fields
 *   [Events]
 *   Format: Layer, Start, End, Style, Name, …               <- 10 fields
 *
 * The first version took the first `Format:` it saw, so `fields.indexOf('start')`
 * was -1 for every `Dialogue:` line, `assTimeToMs('')` returned null, and every
 * cue was skipped. Measured on the SM-F split output:
 *
 *   parseAssCues(convertedKrcc).length  ->  0   (before)
 *   parseAssCues(convertedKrcc).length  ->  2   (after)
 *
 * S42 exports whatever track is selected, and after S03 the selected Korean
 * track IS one of these files — so "Save subtitle with sync baked in" wrote an
 * empty file for the module's own primary output, and four of this module's
 * acceptance assertions failed on it.
 */
export function parseAssCues(text: string): Cue[] {
  const cues: Cue[] = []
  let fields: string[] = []
  let inEvents = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (/^\[/.test(line)) {
      inEvents = /^\[events\]/i.test(line)
      continue
    }
    if (inEvents && /^Format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase())
      continue
    }
    if (!/^Dialogue\s*:/i.test(line)) continue
    if (fields.length === 0) {
      fields = [
        'layer',
        'start',
        'end',
        'style',
        'name',
        'marginl',
        'marginr',
        'marginv',
        'effect',
        'text'
      ]
    }
    const body = line.slice(line.indexOf(':') + 1)
    // The `Text` field is last and may itself contain commas, so split only as
    // many times as there are preceding fields.
    const parts = splitLimit(body, ',', fields.length)
    const get = (name: string): string => {
      const i = fields.indexOf(name)
      return i >= 0 ? (parts[i] ?? '').trim() : ''
    }
    const startMs = assTimeToMs(get('start'))
    const endMs = assTimeToMs(get('end'))
    if (startMs === null || endMs === null || endMs <= startMs) continue
    const visible = get('text')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
    if (visible.trim().length === 0) continue
    cues.push({ startMs, endMs, text: visible, ruby: '' })
  }
  return cues.sort((a, b) => a.startMs - b.startMs)
}

function splitLimit(s: string, sep: string, count: number): string[] {
  const out: string[] = []
  let rest = s
  for (let i = 0; i < count - 1; i++) {
    const at = rest.indexOf(sep)
    if (at < 0) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)
  return out
}

function assTimeToMs(v: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(v.trim())
  if (!m) return null
  return timeToMs(m[1] ?? '0', m[2] ?? '0', m[3] ?? '0', (m[4] ?? '0').padEnd(2, '0').slice(0, 3))
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export interface BakeOptions {
  /** mpv's `sub-delay`, seconds. */
  readonly delay: number
  /** mpv's `sub-speed`. */
  readonly speed: number
}

export function bakeCues(cues: readonly Cue[], o: BakeOptions): Cue[] {
  return cues
    .map((c) => ({
      startMs: bakeTime(c.startMs / 1000, o.delay, o.speed) * 1000,
      endMs: bakeTime(c.endMs / 1000, o.delay, o.speed) * 1000,
      text: c.text,
      ruby: c.ruby
    }))
    .filter((c) => c.endMs > c.startMs)
}

/**
 * SRT out, CRLF throughout and blank-line terminated.
 *
 * A BLANK LINE INSIDE A CUE ENDS THE CUE, in this parser and in every other one,
 * so an empty line in the text is collapsed rather than written: an SMI
 * paragraph that happens to contain one would otherwise split into a cue and a
 * fragment with no timing, and the fragment would be read back as a cue index.
 */
export function toSrt(cues: readonly Cue[]): string {
  const out: string[] = []
  let n = 1
  for (const c of cues) {
    out.push(String(n++))
    out.push(`${formatSrtTime(c.startMs / 1000)} --> ${formatSrtTime(c.endMs / 1000)}`)
    out.push(
      c.text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .join('\r\n')
    )
    out.push('')
  }
  return out.join('\r\n') + (out.length > 0 ? '\r\n' : '')
}

/**
 * SMI out.
 *
 * The header is literal uppercase `<SAMI>` with nothing but an optional BOM in
 * front of it, because that is the only shape FFmpeg's probe accepts (S04) —
 * writing our own export in a form our own player cannot read would be a fine
 * joke.
 *
 * A BOM IS FINE AND IS WHAT WE WRITE. The first version of this comment said
 * "no BOM before it, because that is the only shape FFmpeg's probe accepts",
 * which is wrong and contradicted `smi.ts`'s own header note two files away:
 * `sami_probe()` reads through an `FFTextReader`, which skips a BOM before the
 * `strncmp`. That mattered because S42 requires UTF-8 **with** a BOM — without
 * it Notepad and every Korean subtitle editor on Windows opens the file as CP949
 * and shows mojibake, which is the exact PotPlayer bug the row quotes ("Hangul
 * was broken when subtitle sync was saved"). Two of this module's own beliefs
 * were in conflict and the export sat between them.
 *
 * Each cue is followed by a `&nbsp;` clear event at its end time, which is how
 * SAMI ends a line and is what makes a round-trip through `readSubtitle`
 * idempotent.
 */
export function toSmi(cues: readonly Cue[], className: string, lang: string): string {
  const cls = className.length > 0 ? className.toUpperCase() : 'KRCC'
  const out: string[] = []
  out.push('<SAMI>')
  out.push('<HEAD>')
  out.push('<STYLE TYPE="text/css">')
  out.push('<!--')
  out.push('P { font-family:Malgun Gothic; font-size:20pt; color:white; text-align:center; }')
  out.push(`.${cls} { Name:${lang}; lang:${lang}; SAMIType:CC; }`)
  out.push('-->')
  out.push('</STYLE>')
  out.push('</HEAD>')
  out.push('<BODY>')
  for (const c of cues) {
    const body = escapeSmi(c.text).replace(/\n/g, '<br>')
    out.push(`<SYNC Start=${Math.round(c.startMs)}><P Class=${cls}>${body}`)
    out.push(`<SYNC Start=${Math.round(c.endMs)}><P Class=${cls}>&nbsp;`)
  }
  out.push('</BODY>')
  out.push('</SAMI>')
  return out.join('\r\n') + '\r\n'
}

function escapeSmi(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * UTF-8 with a BOM, which S42 asks for and which matters: without it Notepad
 * and every Korean subtitle editor on Windows opens a UTF-8 `.smi` as CP949 and
 * shows mojibake, which is precisely the PotPlayer bug the row quotes
 * ("Hangul was broken when subtitle sync was saved").
 */
export function utf8WithBom(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(body.length + 3)
  out[0] = 0xef
  out[1] = 0xbb
  out[2] = 0xbf
  out.set(body, 3)
  return out
}

/**
 * CP949 out, for `or CP949 on request`.
 *
 * There is no `TextEncoder` for a legacy codepage in Node — it encodes UTF-8 and
 * nothing else — so the table is INVERTED FROM THE DECODER: every two-byte
 * CP949 lead/trail pair is decoded once through `TextDecoder('euc-kr')` and the
 * result indexed the other way. That is deliberate rather than convenient: the
 * encoder and the decoder are then guaranteed to be the same table, so a
 * round-trip cannot disagree with itself, and there is no hand-typed mapping to
 * drift. Built lazily; a Korean export costs one ~23k-iteration pass, once.
 *
 * Characters CP949 cannot represent are replaced with `?` and COUNTED, so the
 * caller can tell the user how many were lost instead of shipping a silently
 * damaged file.
 */
let cp949Encoder: Map<string, [number, number]> | null = null

function buildCp949Table(): Map<string, [number, number]> {
  const table = new Map<string, [number, number]>()
  const decoder = new TextDecoder('euc-kr', { fatal: false })
  const pair = new Uint8Array(2)
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      pair[0] = lead
      pair[1] = trail
      const ch = decoder.decode(pair)
      if (ch.length !== 1 || ch === '�') continue
      if (!table.has(ch)) table.set(ch, [lead, trail])
    }
  }
  return table
}

export function encodeCp949(text: string): { bytes: Uint8Array; unmappable: number } {
  if (!cp949Encoder) cp949Encoder = buildCp949Table()
  const out: number[] = []
  let unmappable = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) {
      out.push(cp)
      continue
    }
    const pair = cp949Encoder.get(ch)
    if (pair) {
      out.push(pair[0], pair[1])
    } else {
      out.push(0x3f)
      unmappable++
    }
  }
  return { bytes: new Uint8Array(out), unmappable }
}
