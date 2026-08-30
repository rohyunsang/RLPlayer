/**
 * SMI / SAMI: the probe, the header repair (S04) and the parser (S03/S05/S06).
 *
 * Everything here is written against FFmpeg's own two files, which were read
 * rather than guessed (`libavformat/samidec.c`, `libavcodec/samidec.c`) and then
 * confirmed by running the pinned mpv over fixtures. The three behaviours that
 * matter:
 *
 * 1. THE PROBE IS `strncmp(buf, "<SAMI>", 6)`.
 *    `sami_probe()` reads six bytes through an `FFTextReader` (so a BOM and
 *    UTF-16 are handled, and nothing else is) and returns
 *    `AVPROBE_SCORE_MAX` or **0**. Case-sensitive, exact, no leading
 *    whitespace, no space before the `>`.
 *
 *    Measured on the pinned binary — `sub-text` at t=1s, `--msg-level=all=v`:
 *
 *      single_cp949.smi   Found 'sami' at score=100   charset UHC   안녕하세요 …
 *      lower.smi   (`<sami>`)        Found 'sami' at score=1    (unavailable)
 *      lead.smi    (two \n first)    Found 'sami' at score=1    (unavailable)
 *      space.smi   (`<SAMI >`)       Found 'sami' at score=1    (unavailable)
 *
 *    Score 1 is the extension-only fallback and it is BELOW
 *    `--demuxer-lavf-probescore` (26), so the file is silently not a subtitle at
 *    all. Do not "fix" it by lowering probescore: S01 already records that this
 *    causes false-positive demuxer matches elsewhere.
 *
 * 2. `Class` IS NEVER READ. `libavcodec/samidec.c` extracts `<P …>` tags,
 *    checks only for `ID=Source`, and concatenates every `<P>` inside one packet
 *    with `\N`. There is no code path in FFmpeg that can separate KRCC from
 *    ENCC, which is why S03 is a converter and not an option.
 *
 * 3. TWO `<SYNC>` AT THE SAME PTS LOSES THE FIRST. The demuxer sets
 *    `sub->duration = -1` per SYNC and `ff_subtitles_queue_finalize()` resolves
 *    it to `next_pts - pts`, i.e. **0** for a duplicate timestamp. Measured on a
 *    KRCC-then-ENCC fixture at `Start=500`:
 *
 *      @@SUB=[Hello everyone]      <- the Korean line is the one that vanished
 *
 *    In real Korean releases KRCC is written first, so the failure always eats
 *    Korean. That is the whole reason this module exists.
 */

export interface SmiStyle {
  /** The class id as written, upper-cased: `KRCC`. `''` is the `P` default. */
  readonly id: string
  name?: string
  lang?: string
  fontFamily?: string
  /** In points, as SMI writes it. */
  fontSize?: number
  /** `&HAABBGGRR`. */
  primaryColour?: string
  bold?: boolean
  italic?: boolean
  /** 1=left 2=centre 3=right, in ASS numbering. */
  alignment?: number
}

export interface SmiEvent {
  readonly startMs: number
  /** Upper-cased class id, or `''` when the `<P>` carried no `Class`. */
  readonly className: string
  /** Visible text. `\n` for a line break; never contains markup. */
  readonly text: string
  /** Ruby reading (S05), already separated from `text`. */
  readonly ruby: string
  /** True for a `&nbsp;`-only event: it ENDS the previous line, it is not one. */
  readonly clear: boolean
}

export interface SmiDocument {
  readonly events: readonly SmiEvent[]
  /** Every class id seen, in first-appearance order. */
  readonly classes: readonly string[]
  readonly styles: ReadonlyMap<string, SmiStyle>
}

/**
 * What FFmpeg's `sami_probe` would return for this text.
 *
 * A LEADING BOM IS SKIPPED, and that is not a nicety. `sami_probe()` reads its
 * six bytes through an `FFTextReader`, which strips a BOM and transcodes UTF-16
 * before the `strncmp` runs — as the header comment above already said. The
 * first version of this function compared the raw string, so it answered 0 for a
 * BOM-prefixed `<SAMI>`, i.e. "FFmpeg cannot load this file". Measured:
 *
 *   smiProbeScore('\uFEFF<SAMI>…')  ->  0     (before)
 *   smiProbeScore('\uFEFF<SAMI>…')  ->  100   (after)
 *
 * S42 requires our OWN exported `.smi` to be UTF-8 **with** a BOM (without it
 * Notepad and every Korean subtitle editor opens it as CP949 — the PotPlayer
 * bug the row quotes). So the model declared the file this module writes
 * unreadable, and `needsHeaderRepair` inherited it: a well-formed export was
 * pushed through the S04 repair path and rewritten into the cache on every
 * load, forever, for nothing.
 */
export function smiProbeScore(text: string): 100 | 0 {
  return stripLeadingBom(text).startsWith('<SAMI>') ? 100 : 0
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** The three verified total-silence shapes, and anything else of the same kind. */
export function needsHeaderRepair(text: string): boolean {
  return smiProbeScore(text) === 0 && /^\s*<\s*sami\s*>/i.test(text)
}

/**
 * S04. Return a copy whose first six bytes are literally `<SAMI>`.
 *
 * Leading whitespace and blank lines go, `<sami>` / `<SAMI >` / `< SAMI >`
 * become `<SAMI>`, and NOTHING ELSE IS TOUCHED — the body is the user's data.
 * The caller writes this to the sub cache; the user's file is never modified in
 * place (S04, and the same rule as every other converter here).
 */
export function repairHeader(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, '').replace(/^\s+/, '')
  const m = /^<\s*sami\s*>/i.exec(trimmed)
  if (!m) return trimmed
  return `<SAMI>${trimmed.slice(m[0].length)}`
}

// ---------------------------------------------------------------------------
// Entities and inline markup
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'"
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith('#x')) {
      const cp = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole
    }
    if (key.startsWith('#')) {
      const cp = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole
    }
    return NAMED_ENTITIES[key] ?? whole
  })
}

/**
 * S05. Pull `<RUBY>base<RT>reading</RT></RUBY>` apart.
 *
 * Returns the base text with the ruby REMOVED and the readings collected
 * separately. "Never let ruby markup leak into the visible line" is the row's
 * one hard requirement, and the way to guarantee it is to strip ruby BEFORE the
 * generic tag stripper runs — otherwise `<RT>` disappears and its content stays,
 * so `漢字한자` renders as one word.
 */
export function extractRuby(html: string): { base: string; ruby: string } {
  const readings: string[] = []
  const base = html.replace(
    /<\s*ruby[^>]*>([\s\S]*?)<\s*\/\s*ruby\s*>/gi,
    (_whole, inner: string) => {
      let baseText = inner
      baseText = baseText.replace(
        /<\s*rt[^>]*>([\s\S]*?)(?:<\s*\/\s*rt\s*>|$)/gi,
        (_w, reading: string) => {
          readings.push(stripTags(reading).trim())
          return ''
        }
      )
      // `<rp>(…)</rp>` is the fallback parenthesis for renderers with no ruby
      // support. libass is one of those, but we place the reading ourselves, so
      // keeping the parentheses would double them.
      baseText = baseText.replace(/<\s*rp[^>]*>[\s\S]*?(?:<\s*\/\s*rp\s*>|$)/gi, '')
      return baseText
    }
  )
  return { base, ruby: readings.filter((r) => r.length > 0).join(' ') }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

/** Inline markup -> plain text with `\n` line breaks. */
export function smiTextToPlain(html: string): { text: string; ruby: string } {
  const { base, ruby } = extractRuby(html)
  const withBreaks = base.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  const bare = decodeEntities(stripTags(withBreaks))
  // Collapse runs of spaces/tabs but keep the line structure: SMI is written as
  // HTML, so its source newlines are insignificant and its `<br>` are not.
  const text = bare
    .split('\n')
    .map((line) => line.replace(/[^\S\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // …and then the EMPTY leading and trailing lines go, which the first version
    // did not do. A paragraph is terminated by the newline before the next
    // `<SYNC>`, so with a CRLF source — which every Windows `.smi` is — EVERY
    // cue came out of here with a trailing newline. Measured on the SM-F
    // fixture before this line existed: '안녕하세요 여러분\n',
    // '두 번째 줄\n계속\n', '대사\n'. `buildAss` turns a trailing newline into a
    // literal `\N`, so every line of every converted Korean subtitle rendered
    // with a blank line under it, lifting the text half a line up the screen.
    // Three assertions in smi.test.ts failed on exactly this.
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  return { text, ruby }
}

/** A `&nbsp;`-only paragraph is SMI's "clear the line now". */
export function isClearText(text: string): boolean {
  return text.replace(/[\s\u00a0]/g, '').length === 0
}

// ---------------------------------------------------------------------------
// The CSS block (S06) and the class table
// ---------------------------------------------------------------------------

const CSS_COLOURS: Record<string, string> = {
  white: 'ffffff',
  black: '000000',
  red: 'ff0000',
  lime: '00ff00',
  green: '008000',
  blue: '0000ff',
  yellow: 'ffff00',
  cyan: '00ffff',
  aqua: '00ffff',
  magenta: 'ff00ff',
  fuchsia: 'ff00ff',
  silver: 'c0c0c0',
  gray: '808080',
  grey: '808080',
  maroon: '800000',
  olive: '808000',
  navy: '000080',
  purple: '800080',
  teal: '008080',
  orange: 'ffa500',
  pink: 'ffc0cb'
}

/**
 * CSS `#RRGGBB` (or a colour name) -> ASS `&HAABBGGRR`.
 *
 * Two inversions in one field, and both are easy to get backwards: ASS stores
 * the channels **BGR**, and its alpha byte is **inverted** (00 = opaque).
 */
export function cssColourToAss(value: string): string | undefined {
  const v = value.trim().toLowerCase()
  let hex: string | undefined
  if (/^#[0-9a-f]{6}$/.test(v)) hex = v.slice(1)
  else if (/^#[0-9a-f]{3}$/.test(v)) {
    hex = v
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')
  } else if (/^[0-9a-f]{6}$/.test(v)) hex = v
  else hex = CSS_COLOURS[v]
  if (!hex) return undefined
  const rr = hex.slice(0, 2)
  const gg = hex.slice(2, 4)
  const bb = hex.slice(4, 6)
  return `&H00${bb}${gg}${rr}`.toUpperCase()
}

/** Every `selector { … }` rule inside the `<STYLE>` block, in source order. */
export function parseStyleBlock(smi: string): Map<string, SmiStyle> {
  const styles = new Map<string, SmiStyle>()
  const block = /<\s*style[^>]*>([\s\S]*?)(?:<\s*\/\s*style\s*>|$)/i.exec(smi)
  if (!block?.[1]) return styles
  const css = block[1].replace(/<!--/g, '').replace(/-->/g, '')
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(css)) !== null) {
    const selectors = (m[1] ?? '').split(',')
    const body = m[2] ?? ''
    for (const rawSel of selectors) {
      const sel = rawSel.trim()
      if (sel.length === 0) continue
      // `P` (or `BODY`) is the document default; `.KRCC` / `#KRCC` name a class.
      const id = /^[.#]/.test(sel) ? sel.slice(1).toUpperCase() : ''
      if (id === '' && !/^(p|body)$/i.test(sel)) continue
      const style = styles.get(id) ?? { id }
      applyDeclarations(style, body)
      styles.set(id, style)
    }
  }
  return styles
}

function applyDeclarations(style: SmiStyle, body: string): void {
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':')
    if (idx < 0) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (value.length === 0) continue
    switch (prop) {
      case 'name':
        style.name = value.replace(/^["']|["']$/g, '')
        break
      case 'lang':
        style.lang = value.replace(/^["']|["']$/g, '')
        break
      case 'font-family':
        style.fontFamily = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
        break
      case 'font-size': {
        const n = Number.parseFloat(value)
        // `pt` is what SMI writes; `px` appears too and is close enough at the
        // sizes involved that pretending otherwise would be false precision.
        if (Number.isFinite(n) && n > 0) style.fontSize = n
        break
      }
      case 'color': {
        const c = cssColourToAss(value)
        if (c) style.primaryColour = c
        break
      }
      case 'font-weight':
        style.bold = /bold|[6-9]00/i.test(value)
        break
      case 'font-style':
        style.italic = /italic|oblique/i.test(value)
        break
      case 'text-align':
        style.alignment = /left/i.test(value) ? 1 : /right/i.test(value) ? 3 : 2
        break
      default:
        break
    }
  }
}

/** `ko-KR` / `ko_KR` / `KOREAN` -> the two-letter code mpv wants for `sub-add`. */
export function langOfStyle(style: SmiStyle | undefined, classId: string): string {
  const raw = style?.lang ?? ''
  const m = /^([a-z]{2,3})(?:[-_]|$)/i.exec(raw)
  if (m?.[1]) return m[1].toLowerCase()
  // Korean SMI writers are extremely consistent about these two suffixes even
  // when the CSS carries no `lang:` at all, which is the common case.
  if (/^KR/i.test(classId)) return 'ko'
  if (/^EN/i.test(classId)) return 'en'
  if (/^JP/i.test(classId)) return 'ja'
  if (/^CN|^ZH/i.test(classId)) return 'zh'
  return 'und'
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const SYNC_RE = /<\s*sync\b([^>]*)>/gi
const P_RE = /<\s*p\b([^>]*)>/gi

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(attrs)
  return m?.[2] ?? m?.[3] ?? m?.[4]
}

export function parseSmi(text: string): SmiDocument {
  const body = cutBody(text)
  const events: SmiEvent[] = []
  const classes: string[] = []
  const styles = parseStyleBlock(text)

  const syncs: Array<{ startMs: number; chunk: string }> = []
  SYNC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let prev: { startMs: number; at: number } | null = null
  while ((m = SYNC_RE.exec(body)) !== null) {
    const start = Number.parseInt(attr(m[1] ?? '', 'start') ?? '', 10)
    const at = m.index + m[0].length
    if (prev) syncs.push({ startMs: prev.startMs, chunk: body.slice(prev.at, m.index) })
    prev = { startMs: Number.isFinite(start) ? start : 0, at }
  }
  if (prev) syncs.push({ startMs: prev.startMs, chunk: body.slice(prev.at) })

  for (const sync of syncs) {
    for (const p of splitParagraphs(sync.chunk)) {
      const { text: plain, ruby } = smiTextToPlain(p.html)
      const className = (p.className ?? '').toUpperCase()
      if (className.length > 0 && !classes.includes(className)) classes.push(className)
      if (className.length === 0 && !classes.includes('')) classes.push('')
      events.push({
        startMs: sync.startMs,
        className,
        text: plain,
        ruby,
        clear: isClearText(plain) && ruby.length === 0
      })
    }
  }
  return { events, classes, styles }
}

function cutBody(text: string): string {
  const open = /<\s*body[^>]*>/i.exec(text)
  const from = open ? open.index + open[0].length : 0
  const rest = text.slice(from)
  const close = /<\s*\/\s*body\s*>/i.exec(rest)
  return close ? rest.slice(0, close.index) : rest
}

/**
 * One `<SYNC>` chunk -> its paragraphs.
 *
 * Both real-world layouts are handled, because both exist in Korean releases
 * and they fail differently:
 *
 *   <SYNC Start=500><P Class=KRCC>…      one class per SYNC, duplicated PTS
 *   <SYNC Start=500><P Class=ENCC>…        -> FFmpeg drops the FIRST one
 *
 *   <SYNC Start=500>                     both classes inside one SYNC
 *     <P Class=KRCC>…                      -> FFmpeg concatenates them with \N,
 *     <P Class=ENCC>…                         so both languages show at once
 *
 * A chunk with no `<P>` at all (some writers put the text straight after the
 * SYNC) becomes one class-less paragraph rather than being dropped.
 */
function splitParagraphs(chunk: string): Array<{ className?: string; html: string }> {
  const out: Array<{ className?: string; html: string }> = []
  P_RE.lastIndex = 0
  const heads: Array<{ attrs: string; from: number; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = P_RE.exec(chunk)) !== null) {
    heads.push({ attrs: m[1] ?? '', from: m.index, at: m.index + m[0].length })
  }
  if (heads.length === 0) {
    const html = chunk.trim()
    return html.length > 0 ? [{ html }] : []
  }
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]
    if (!head) continue
    const end = heads[i + 1]?.from ?? chunk.length
    // `ID=Source` is a speaker label, not a subtitle line: FFmpeg italicises it
    // into the same event. We drop it — a converted track that silently gains a
    // speaker name on every line is worse than one that loses it.
    if (/\bID\s*=\s*["']?source["']?/i.test(head.attrs)) continue
    out.push({ className: attr(head.attrs, 'class'), html: chunk.slice(head.at, end) })
  }
  return out
}

/** A cue after grouping: one class, resolved end time. */
export interface Cue {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  readonly ruby: string
}

/**
 * The trailing event has no successor to end it. Five seconds is PotPlayer's
 * own behaviour for a dangling SAMI line and is long enough to read.
 */
export const TRAILING_CUE_MS = 5000

/**
 * Group a parsed document into one cue list PER CLASS — the actual S03 fix.
 *
 * The end of a cue is the start of the next event OF THE SAME CLASS, which is
 * exactly what FFmpeg cannot do: its queue is global, so a KRCC line is ended
 * by the ENCC line that shares its timestamp and gets duration 0.
 */
export function cuesByClass(doc: SmiDocument): Map<string, Cue[]> {
  const byClass = new Map<string, SmiEvent[]>()
  for (const e of doc.events) {
    const list = byClass.get(e.className)
    if (list) list.push(e)
    else byClass.set(e.className, [e])
  }
  const out = new Map<string, Cue[]>()
  for (const [className, list] of byClass) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs)
    const cues: Cue[] = []
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i]
      if (!e || e.clear) continue
      let endMs = e.startMs + TRAILING_CUE_MS
      for (let j = i + 1; j < sorted.length; j++) {
        const next = sorted[j]
        if (next && next.startMs > e.startMs) {
          endMs = next.startMs
          break
        }
      }
      if (endMs <= e.startMs) endMs = e.startMs + 1
      cues.push({ startMs: e.startMs, endMs, text: e.text, ruby: e.ruby })
    }
    out.set(className, cues)
  }
  return out
}
