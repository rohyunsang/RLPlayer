/**
 * The ASS writer (S03's output, S06's styles, S05's ruby).
 *
 * ASS rather than SRT for the SMI split, because S06 needs a real
 * `[V4+ Styles]` section and S05 needs override tags, and neither survives SRT.
 * S07 (TTML) writes SRT instead, which is what its spec row asks for.
 */

import { formatAssTime } from './text.ts'
import type { Cue, SmiStyle } from './smi.ts'

/**
 * S05. How a `<RUBY>`/`<RT>` reading is rendered.
 *
 * `libass has no ruby primitive; anything we ship is an approximation. Being
 * honest about that beats a half-broken render.` So:
 *
 *  - `drop`   — the reading is discarded, the base line is untouched. The
 *               default, and the only mode that cannot make a line worse.
 *  - `inline` — `漢字(한자)`. Always legible, always correctly associated with
 *               its base word, and it lengthens the line.
 *  - `above`  — a second `{\an8}` event at half the font size, i.e. top-centre.
 *               The spec sketches `\pos(x,y)`, and we do NOT emit one: placing
 *               a reading over its base glyph needs text metrics for the user's
 *               font at the user's `sub-scale`, which this process does not
 *               have. A `\pos` computed from a guess is a reading floating over
 *               the wrong word, which is worse than one floating at the top.
 */
export type RubyMode = 'drop' | 'inline' | 'above'

export interface AssTrackOptions {
  /** The ASS `Title:` header field. */
  readonly title: string
  readonly rubyMode: RubyMode
  /**
   * S06: apply the SMI `<STYLE>` block. Off by default — `Most Korean SMI style
   * blocks only set a font and white text, which is already the default`, and a
   * subtitle that overrides the user's own styling without being asked is a
   * support ticket.
   */
  readonly useSubtitleStyle: boolean
  readonly classStyle?: SmiStyle | undefined
  readonly defaultStyle?: SmiStyle | undefined
  /** `PlayResX`/`PlayResY`. See PLAY_RES_Y for why it is not libass's 384x288. */
  readonly playResX?: number
  readonly playResY?: number
}

const DEFAULT_FONT = 'Malgun Gothic'

/**
 * The canvas the point sizes are resolved against, and the reason it is not
 * libass's own default.
 *
 * A `Fontsize` in ASS is in PlayRes units, so what the viewer sees is the RATIO
 * `Fontsize / PlayResY`. The first version paired libass's style-less default
 * (384x288) with `Fontsize: 48` and `pt * 2.4`, which is 48/288 = **16.7% of the
 * screen height per line** — three or four lines of Korean would have covered
 * the picture. A 20pt SMI style is authored against a ~480-line canvas, i.e.
 * 4.2%, and 4–5% is what every player ships as a subtitle default.
 *
 * So: a 720-line canvas, `pt * 1.5` (720/480), and 36 when the file says
 * nothing — 5.0%. The user's own scaling is `sub-scale` and friends, which are
 * M19's and multiply on top of this; the converter's job is to land at a sane
 * 1.0.
 */
const PLAY_RES_X = 1280
const PLAY_RES_Y = 720
/** 720/480: SMI point sizes are written against a ~480-line canvas. */
const PT_TO_PLAYRES = 1.5
const DEFAULT_SIZE = 36

/**
 * Plain text -> an ASS `Text` field.
 *
 * Three transforms, and the first is the one that is easy to get wrong. libass
 * only gives a backslash meaning when it precedes `n`, `N` or `h`; every other
 * `\x` is printed literally, backslash included. So blanket-escaping every
 * backslash would print doubled ones all over a Korean subtitle (`\` is a
 * common typo for `₩`), while ignoring backslashes entirely would let a source
 * line containing `\N` inject a line break. Only the three meaningful sequences
 * are neutralised.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\([nNh])/g, '$1')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

function styleLine(o: AssTrackOptions): string {
  const s = o.useSubtitleStyle ? { ...(o.defaultStyle ?? {}), ...(o.classStyle ?? {}) } : {}
  const font = s.fontFamily ?? DEFAULT_FONT
  const size = s.fontSize !== undefined ? Math.round(s.fontSize * PT_TO_PLAYRES) : DEFAULT_SIZE
  const primary = s.primaryColour ?? '&H00FFFFFF'
  const bold = s.bold ? -1 : 0
  const italic = s.italic ? -1 : 0
  const align = s.alignment ?? 2
  return [
    'Style: Default',
    font,
    String(size),
    primary,
    '&H000000FF',
    '&H00000000',
    '&H80000000',
    String(bold),
    String(italic),
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    '2',
    '1.5',
    String(align),
    '20',
    '20',
    '20',
    '1'
  ].join(',')
}

function rubyStyleLine(o: AssTrackOptions): string {
  const s = o.useSubtitleStyle ? { ...(o.defaultStyle ?? {}), ...(o.classStyle ?? {}) } : {}
  const font = s.fontFamily ?? DEFAULT_FONT
  const size = Math.max(
    10,
    Math.round((s.fontSize !== undefined ? s.fontSize * PT_TO_PLAYRES : DEFAULT_SIZE) * 0.5)
  )
  return [
    'Style: Ruby',
    font,
    String(size),
    s.primaryColour ?? '&H00FFFFFF',
    '&H000000FF',
    '&H00000000',
    '&H80000000',
    '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    '1.5',
    '1',
    '8',
    '20',
    '20',
    '20',
    '1'
  ].join(',')
}

const FORMAT_LINE =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
  'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
  'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'

const EVENT_FORMAT_LINE =
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'

export function buildAss(cues: readonly Cue[], o: AssTrackOptions): string {
  const lines: string[] = []
  lines.push('[Script Info]')
  lines.push('; Generated by RLPlayer subs-formats (S03) from a SAMI source.')
  lines.push('; The source file was not modified.')
  lines.push(`Title: ${o.title.replace(/[\r\n]+/g, ' ')}`)
  lines.push('ScriptType: v4.00+')
  lines.push('WrapStyle: 0')
  lines.push('ScaledBorderAndShadow: yes')
  lines.push(`PlayResX: ${o.playResX ?? PLAY_RES_X}`)
  lines.push(`PlayResY: ${o.playResY ?? PLAY_RES_Y}`)
  lines.push('')
  lines.push('[V4+ Styles]')
  lines.push(FORMAT_LINE)
  lines.push(styleLine(o))
  if (o.rubyMode === 'above') lines.push(rubyStyleLine(o))
  lines.push('')
  lines.push('[Events]')
  lines.push(EVENT_FORMAT_LINE)
  for (const cue of cues) {
    const start = formatAssTime(cue.startMs / 1000)
    const end = formatAssTime(cue.endMs / 1000)
    let visible = cue.text
    if (cue.ruby.length > 0 && o.rubyMode === 'inline') visible = `${visible}(${cue.ruby})`
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(visible)}`)
    if (cue.ruby.length > 0 && o.rubyMode === 'above') {
      lines.push(`Dialogue: 0,${start},${end},Ruby,,0,0,0,,${escapeAssText(cue.ruby)}`)
    }
  }
  // libass is content with LF; CRLF is written anyway because these files land
  // on a Windows disk and users open them in Notepad to check what we did.
  return lines.join('\r\n') + '\r\n'
}
