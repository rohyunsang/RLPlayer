import type { SettingDescriptor, SettingSection, SettingType } from '@shared/feature-api'

/**
 * M19 subs-style — the property table, and every pure function over it.
 *
 * No Electron, no DOM, no `node:*`: this file is where the logic lives so it can
 * be driven by `style.test.ts` (§13). `index.ts` holds wiring only.
 *
 * EVERY ROW BELOW WAS MEASURED AGAINST THE PINNED BINARY over JSON IPC
 * (`resources/mpv/mpv.exe`, v0.41.0-923-g7b8915bc1) — name, type, range, the
 * exact accepted spellings and the READBACK shape. Five things came out of that
 * run that the spec's §2 tables do not say, and each one is a bug somebody would
 * otherwise have written:
 *
 *  1. A choice property whose value is `no` or `yes` READS BACK AS A JSON
 *     BOOLEAN, not as the string you wrote:
 *
 *        set sub-ass-override "no"    -> get: false
 *        set sub-ass-override "yes"   -> get: true
 *        set sub-ass-override "scale" -> get: "scale"
 *        set sub-ass-vsfilter-color-compat "no" -> get: false
 *        set secondary-sub-ass-override "no"    -> get: false
 *
 *     So `peek<string>('sub-ass-override') === 'no'` is FALSE while the property
 *     is exactly `no`. `fromMpv()` is the only thing allowed to read one of
 *     these back.
 *  2. An OUT-OF-RANGE write does not clamp and does not report a range error —
 *     it fails with `unsupported format for accessing property`, which reads
 *     like a type error and is easy to log-and-ignore:
 *
 *        sub-pos 200 · sub-margin-x -5 · sub-blur 21 · sub-spacing 11
 *        sub-gauss 4 · sub-scale 101 · sub-font-size 0 · image-subs-hdr-peak 5
 *
 *     all FAIL. `coerce()` clamps to the range the binary reported, so a
 *     slider that overshoots is our bug and not a silent no-op.
 *  3. `sub-shadow-size` DOES NOT EXIST (`property not found`) — the shadow is
 *     offset-driven, as S18 says. `sub-shadow-color` is an alias for
 *     `sub-back-color` (verified: writing one moves the other), so there is no
 *     separate shadow colour to expose.
 *  4. `sub-outline-size` is an UNBOUNDED Float: `-1` is accepted. mpv will not
 *     stop us from shipping a negative outline; the table does.
 *  5. A String-list property accepts a bare string and reads back as a
 *     one-element list (`sub-filter-regex "x"` -> `["x"]`), and the
 *     choice-or-integer pair accept the numeric STRING form and read back as a
 *     number (`image-subs-hdr-peak "1000"` -> `1000`).
 */

export type GroupKey = 'font' | 'colour' | 'position' | 'ass' | 'filter' | 'image'

export type RowKind = 'bool' | 'int' | 'float' | 'enum' | 'string' | 'list' | 'path' | 'color'

export interface StyleRow {
  /** Setting id suffix. The id is `subs-style.${key}`. */
  readonly key: string
  /** The mpv property name, verified present in the pinned binary. */
  readonly mpv: string
  readonly kind: RowKind
  readonly group: GroupKey
  readonly order: number
  /** OUR default. Equals mpv's unless `mpvDefault` is present. */
  readonly def: unknown
  /** Present only where we deliberately differ from mpv, with a reason. */
  readonly mpvDefault?: unknown
  /** The range the BINARY reported, or the narrower one we expose. */
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly choices?: readonly string[]
  readonly pathMode?: 'file' | 'directory'
  /**
   * A stored boolean maps to these. Only for `assOverride`, whose v0.1.1
   * descriptor was a `bool` under the same id: a user who ticked it has `true`
   * in config.json and must not get `coerce()`'s fallback silently.
   */
  readonly boolMap?: { readonly true: string; readonly false: string }
  /**
   * libass reads this at track-parse time, so an already-loaded EXTERNAL track
   * only restyles after M17 reloads it (S22). Not our command to issue:
   * `ctx.commands.invoke('subs-tracks.reload')`.
   */
  readonly reload?: boolean
  /**
   * Never contributed as a spawn argument. mpv's CLI splits a String list on
   * `,`, and two of these three have `,` and `(` inside their VALUES
   * (`sub-filter-sdh-enclosures` defaults to `(),[],（）`), so the escaping is a
   * hazard with no upside: a property write is verified and exact.
   */
  readonly noArg?: boolean
  readonly advanced?: boolean
  readonly keywords: readonly string[]
}

const SECTION: SettingSection = 'subtitles'

/**
 * The order blocks are contiguous per group because the generated form buckets
 * rows by `group` in the order it first meets them (`settings-form.ts`), so a
 * group whose orders interleave with another's renders its heading twice.
 */
export const ROWS: readonly StyleRow[] = [
  // --- S17 · S20 · S24 font, size, weight, scale, spacing -------------------
  {
    key: 'font',
    mpv: 'sub-font',
    kind: 'string',
    group: 'font',
    order: 100,
    def: 'sans-serif',
    keywords: ['글꼴', '폰트', 'font', 'family', '맑은 고딕']
  },
  {
    key: 'fontSize',
    mpv: 'sub-font-size',
    kind: 'int',
    group: 'font',
    // mpv: Float 1..9000. 8..200 is the range a slider can actually resolve;
    // `sub-font-size` is "scaled pixels at a window height of 720", so it
    // already auto-scales and 9000 is not a size anybody wants.
    order: 101,
    def: 38,
    min: 8,
    max: 200,
    step: 1,
    keywords: ['크기', '글자 크기', 'size', 'font size']
  },
  {
    key: 'bold',
    mpv: 'sub-bold',
    kind: 'bool',
    group: 'font',
    order: 102,
    def: false,
    keywords: ['굵게', 'bold']
  },
  {
    key: 'italic',
    mpv: 'sub-italic',
    kind: 'bool',
    group: 'font',
    order: 103,
    def: false,
    keywords: ['기울임', 'italic']
  },
  {
    key: 'scale',
    mpv: 'sub-scale',
    kind: 'float',
    group: 'font',
    order: 104,
    def: 1,
    // mpv: Float 0..100. 101 FAILS; 0.2..4 is the useful band.
    min: 0.2,
    max: 4,
    step: 0.05,
    keywords: ['자막 크기', 'scale', '배율']
  },
  {
    key: 'spacing',
    mpv: 'sub-spacing',
    kind: 'float',
    group: 'font',
    order: 105,
    def: 0,
    min: -10,
    max: 10,
    step: 0.1,
    keywords: ['자간', 'letter spacing', 'spacing']
  },
  {
    key: 'lineSpacing',
    mpv: 'sub-line-spacing',
    kind: 'float',
    group: 'font',
    order: 106,
    def: 0,
    // mpv: -1000..1000, which is not a slider. -20..20 covers real use.
    min: -20,
    max: 20,
    step: 0.5,
    keywords: ['행간', 'line spacing']
  },
  {
    key: 'blur',
    mpv: 'sub-blur',
    kind: 'float',
    group: 'font',
    order: 107,
    def: 0,
    min: 0,
    max: 20,
    step: 0.1,
    keywords: ['흐림', 'blur', 'gauss']
  },
  {
    key: 'scaleByWindow',
    mpv: 'sub-scale-by-window',
    kind: 'bool',
    group: 'font',
    order: 108,
    def: true,
    advanced: true,
    keywords: ['창 크기', 'scale by window']
  },
  {
    key: 'scaleWithWindow',
    mpv: 'sub-scale-with-window',
    kind: 'bool',
    group: 'font',
    order: 109,
    def: true,
    advanced: true,
    keywords: ['창 크기', 'scale with window']
  },

  // --- S18 colour, outline, shadow, background box --------------------------
  {
    key: 'color',
    mpv: 'sub-color',
    kind: 'color',
    group: 'colour',
    order: 120,
    def: '#FFFFFFFF',
    keywords: ['색', '색상', 'colour', 'color']
  },
  {
    key: 'outlineColor',
    mpv: 'sub-outline-color',
    kind: 'color',
    group: 'colour',
    order: 121,
    def: '#FF000000',
    keywords: ['테두리', '외곽선', 'outline', 'border']
  },
  {
    key: 'outlineSize',
    mpv: 'sub-outline-size',
    kind: 'float',
    group: 'colour',
    order: 122,
    def: 1.65,
    // mpv accepts -1 here (unbounded Float). 0 disables the outline.
    min: 0,
    max: 10,
    step: 0.05,
    keywords: ['테두리 두께', 'outline size', 'border size']
  },
  {
    key: 'backColor',
    mpv: 'sub-back-color',
    kind: 'color',
    group: 'colour',
    order: 123,
    def: '#AF000000',
    keywords: ['배경', '그림자 색', 'back color', 'shadow color', 'box']
  },
  {
    key: 'shadowOffset',
    mpv: 'sub-shadow-offset',
    kind: 'float',
    group: 'colour',
    order: 124,
    def: 0,
    min: 0,
    max: 10,
    step: 0.1,
    keywords: ['그림자', 'shadow']
  },
  {
    key: 'borderStyle',
    mpv: 'sub-border-style',
    kind: 'enum',
    group: 'colour',
    order: 125,
    def: 'outline-and-shadow',
    choices: ['outline-and-shadow', 'opaque-box', 'background-box'],
    keywords: ['테두리 방식', '불투명 상자', 'border style', 'box']
  },

  // --- S19 · S23 position, margins, alignment ------------------------------
  {
    key: 'pos',
    mpv: 'sub-pos',
    kind: 'int',
    group: 'position',
    order: 140,
    def: 100,
    min: 0,
    max: 150,
    step: 1,
    keywords: ['위치', 'position', 'pos']
  },
  {
    key: 'marginX',
    mpv: 'sub-margin-x',
    kind: 'int',
    group: 'position',
    order: 141,
    def: 19,
    min: 0,
    max: 400,
    step: 1,
    keywords: ['좌우 여백', 'margin']
  },
  {
    key: 'marginY',
    mpv: 'sub-margin-y',
    kind: 'int',
    group: 'position',
    order: 142,
    def: 34,
    min: 0,
    max: 400,
    step: 1,
    keywords: ['아래 여백', 'margin']
  },
  {
    key: 'marginYOffset',
    mpv: 'sub-margin-y-offset',
    kind: 'int',
    group: 'position',
    order: 143,
    def: 0,
    min: -200,
    max: 200,
    step: 1,
    advanced: true,
    keywords: ['여백 보정', 'offset']
  },
  {
    key: 'alignX',
    mpv: 'sub-align-x',
    kind: 'enum',
    group: 'position',
    order: 144,
    def: 'center',
    choices: ['left', 'center', 'right'],
    keywords: ['가로 정렬', 'align']
  },
  {
    key: 'alignY',
    mpv: 'sub-align-y',
    kind: 'enum',
    group: 'position',
    order: 145,
    def: 'bottom',
    choices: ['top', 'center', 'bottom'],
    keywords: ['세로 정렬', 'align']
  },
  {
    key: 'justify',
    mpv: 'sub-justify',
    kind: 'enum',
    group: 'position',
    order: 146,
    def: 'auto',
    // The binary reports FOUR choices; §2's S19 row lists only three.
    choices: ['auto', 'left', 'center', 'right'],
    keywords: ['줄 정렬', 'justify']
  },
  {
    key: 'useMargins',
    mpv: 'sub-use-margins',
    kind: 'bool',
    group: 'position',
    order: 147,
    def: true,
    keywords: ['레터박스', '검은 띠', 'margins', 'letterbox']
  },
  {
    key: 'assForceMargins',
    mpv: 'sub-ass-force-margins',
    kind: 'bool',
    group: 'position',
    order: 148,
    def: false,
    keywords: ['ass 여백', 'ass margins']
  },

  // --- S21 · S22 · S51 · S53 ASS ------------------------------------------
  {
    key: 'assOverride',
    mpv: 'sub-ass-override',
    kind: 'enum',
    group: 'ass',
    order: 160,
    /**
     * OFF BY DEFAULT, and this is the one place the module deliberately differs
     * from mpv (whose default is `scale`). A release group's styling is part of
     * the release; forcing our font over a typeset sign is the wrong default and
     * is the reason S21 exists as a five-state selector rather than a checkbox.
     */
    def: 'no',
    mpvDefault: 'scale',
    choices: ['no', 'yes', 'scale', 'force', 'strip'],
    boolMap: { true: 'force', false: 'no' },
    keywords: ['ass', '스타일 덮어쓰기', 'override', 'style']
  },
  {
    key: 'scaleSigns',
    mpv: 'sub-scale-signs',
    kind: 'bool',
    group: 'ass',
    order: 161,
    def: false,
    keywords: ['간판', '사인', 'signs', 'scale signs']
  },
  {
    key: 'assScaleWithWindow',
    mpv: 'sub-ass-scale-with-window',
    kind: 'bool',
    group: 'ass',
    order: 162,
    def: false,
    advanced: true,
    keywords: ['ass 창 크기', 'ass scale with window']
  },
  {
    key: 'assStyleOverrides',
    mpv: 'sub-ass-style-overrides',
    kind: 'list',
    group: 'ass',
    order: 163,
    def: [],
    reload: true,
    noArg: true,
    advanced: true,
    keywords: ['ass 스타일', 'style overrides', 'Default.Bold']
  },
  {
    key: 'assStyles',
    mpv: 'sub-ass-styles',
    kind: 'path',
    pathMode: 'file',
    group: 'ass',
    order: 164,
    def: '',
    reload: true,
    advanced: true,
    keywords: ['ass 파일', 'styles file']
  },
  {
    key: 'vsfilterColorCompat',
    mpv: 'sub-ass-vsfilter-color-compat',
    kind: 'enum',
    group: 'ass',
    order: 165,
    def: 'basic',
    choices: ['no', 'basic', 'full', 'force-601'],
    advanced: true,
    keywords: ['vsfilter', 'smi', '색 호환', 'colour compat', 'bt.601']
  },
  {
    key: 'embeddedFonts',
    mpv: 'embeddedfonts',
    kind: 'bool',
    group: 'ass',
    order: 166,
    def: true,
    keywords: ['포함된 글꼴', '첨부 글꼴', 'embedded fonts', 'attachment']
  },
  {
    key: 'fontsDir',
    mpv: 'sub-fonts-dir',
    kind: 'path',
    pathMode: 'directory',
    group: 'ass',
    order: 167,
    def: '',
    keywords: ['글꼴 폴더', 'fonts dir']
  },
  {
    key: 'secondaryScale',
    mpv: 'secondary-sub-scale',
    kind: 'float',
    group: 'ass',
    order: 168,
    def: 1,
    min: 0.2,
    max: 4,
    step: 0.05,
    advanced: true,
    keywords: ['보조 자막', 'secondary']
  },
  {
    key: 'secondaryPos',
    mpv: 'secondary-sub-pos',
    kind: 'int',
    group: 'ass',
    order: 169,
    def: 0,
    min: 0,
    max: 150,
    step: 1,
    advanced: true,
    keywords: ['보조 자막 위치', 'secondary position']
  },
  {
    key: 'secondaryAssOverride',
    mpv: 'secondary-sub-ass-override',
    kind: 'enum',
    group: 'ass',
    order: 170,
    // The binary's default here is `strip`, NOT `scale`. Left alone: a
    // secondary track is a reading aid and its own positioning fights the
    // primary one.
    def: 'strip',
    choices: ['no', 'yes', 'scale', 'force', 'strip'],
    advanced: true,
    keywords: ['보조 자막 스타일', 'secondary override']
  },

  // --- S46 SDH and regex filtering ----------------------------------------
  {
    key: 'filterSdh',
    mpv: 'sub-filter-sdh',
    kind: 'bool',
    group: 'filter',
    order: 180,
    def: false,
    keywords: ['청각장애인', 'sdh', '효과음 제거']
  },
  {
    key: 'filterSdhHarder',
    mpv: 'sub-filter-sdh-harder',
    kind: 'bool',
    group: 'filter',
    order: 181,
    def: false,
    keywords: ['sdh', 'harder']
  },
  {
    key: 'filterSdhEnclosures',
    mpv: 'sub-filter-sdh-enclosures',
    kind: 'list',
    group: 'filter',
    order: 182,
    // The binary's default, verbatim. The full-width pair is not decoration:
    // Korean SMI rips use （）.
    def: ['()', '[]', '（）'],
    noArg: true,
    advanced: true,
    keywords: ['괄호', 'enclosures']
  },
  {
    key: 'filterRegex',
    mpv: 'sub-filter-regex',
    kind: 'list',
    group: 'filter',
    order: 183,
    // EMPTY by default (S46). Never silently filter anything.
    def: [],
    noArg: true,
    keywords: ['정규식', '광고 제거', 'regex', 'filter']
  },
  {
    key: 'filterRegexEnable',
    mpv: 'sub-filter-regex-enable',
    kind: 'bool',
    group: 'filter',
    order: 184,
    def: true,
    advanced: true,
    keywords: ['정규식', 'regex enable']
  },
  {
    key: 'filterRegexPlain',
    mpv: 'sub-filter-regex-plain',
    kind: 'bool',
    group: 'filter',
    order: 185,
    def: false,
    advanced: true,
    keywords: ['정규식', 'regex plain']
  },
  {
    key: 'filterRegexWarn',
    mpv: 'sub-filter-regex-warn',
    kind: 'bool',
    group: 'filter',
    order: 186,
    def: false,
    advanced: true,
    keywords: ['정규식', 'regex warn']
  },

  // --- S25 image subtitles (VobSub / PGS) ---------------------------------
  {
    key: 'gauss',
    mpv: 'sub-gauss',
    kind: 'float',
    group: 'image',
    order: 200,
    def: 0,
    min: 0,
    max: 3,
    step: 0.05,
    keywords: ['이미지 자막', 'gauss', 'blur']
  },
  {
    key: 'stretchDvdSubs',
    mpv: 'stretch-dvd-subs',
    kind: 'bool',
    group: 'image',
    order: 201,
    def: false,
    advanced: true,
    keywords: ['dvd', 'vobsub']
  },
  {
    key: 'stretchImageSubsToScreen',
    mpv: 'stretch-image-subs-to-screen',
    kind: 'bool',
    group: 'image',
    order: 202,
    def: false,
    keywords: ['이미지 자막', 'stretch']
  },
  {
    key: 'imageSubsVideoResolution',
    mpv: 'image-subs-video-resolution',
    kind: 'bool',
    group: 'image',
    order: 203,
    def: false,
    advanced: true,
    keywords: ['이미지 자막', 'resolution']
  },
  {
    key: 'forcedEventsOnly',
    mpv: 'sub-forced-events-only',
    kind: 'bool',
    group: 'image',
    order: 204,
    def: false,
    keywords: ['강제 자막', 'forced']
  },
  {
    key: 'imageSubsHdrPeak',
    mpv: 'image-subs-hdr-peak',
    kind: 'enum',
    group: 'image',
    order: 205,
    // Choices OR an integer 10..10000, default 1000. The numeric entries are
    // the string form, which the binary accepts and reads back as a number.
    def: '1000',
    choices: ['sdr', 'video', 'video-static', 'video-dynamic', '203', '400', '1000', '4000'],
    advanced: true,
    keywords: ['hdr', '밝기', 'peak', 'nits']
  },
  {
    key: 'subHdrPeak',
    mpv: 'sub-hdr-peak',
    kind: 'enum',
    group: 'image',
    order: 206,
    def: 'auto',
    choices: ['auto', 'sdr', '203', '400', '1000', '4000'],
    advanced: true,
    keywords: ['hdr', '밝기', 'peak', 'nits']
  }
]

const BY_KEY = new Map(ROWS.map((r) => [r.key, r]))
const BY_SETTING_ID = new Map(ROWS.map((r) => [settingIdOf(r), r]))

export function settingIdOf(row: StyleRow): string {
  return `subs-style.${row.key}`
}

export function rowByKey(key: string): StyleRow | undefined {
  return BY_KEY.get(key)
}

export function rowBySettingId(id: string): StyleRow | undefined {
  return BY_SETTING_ID.get(id)
}

/** Every mpv property this table writes. Must equal the module's `ownsProperties`. */
export function tableProperties(): string[] {
  return ROWS.map((r) => r.mpv)
}

// --- colour ----------------------------------------------------------------

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, '0')

/** Canonical mpv colour: `#AARRGGBB`. */
export function formatColor(c: Rgba): string {
  return `#${hex2(c.a)}${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
}

/**
 * Parse the forms the binary accepts. `#RRGGBB` (verified accepted, opaque) and
 * `#AARRGGBB`; the `r/g/b/a` float form is accepted by mpv too but is never
 * written by us, so it is read as opaque white rather than half-parsed.
 */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s)
  if (!m) return null
  const h = m[1] as string
  if (h.length === 6) {
    return {
      a: 255,
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    }
  }
  return {
    a: parseInt(h.slice(0, 2), 16),
    r: parseInt(h.slice(2, 4), 16),
    g: parseInt(h.slice(4, 6), 16),
    b: parseInt(h.slice(6, 8), 16)
  }
}

// --- coercion --------------------------------------------------------------

function clampNumber(row: StyleRow, n: number): number {
  let v = n
  if (row.min !== undefined) v = Math.max(row.min, v)
  if (row.max !== undefined) v = Math.min(row.max, v)
  if (row.kind === 'int') v = Math.round(v)
  else v = Math.round(v * 1000) / 1000
  return v
}

/**
 * Force any stored/incoming value into something the binary provably accepts.
 *
 * This is not defensive decoration. An out-of-range write FAILS on the wire
 * (measured: `sub-pos 200` -> `unsupported format for accessing property`), so
 * without this a preset, a keybind repeat or a hand-edited config.json turns
 * into a silent no-op, which is exactly the kind of thing that gets reported as
 * "the setting does nothing".
 */
export function coerce(row: StyleRow, value: unknown): unknown {
  switch (row.kind) {
    case 'bool':
      return typeof value === 'boolean' ? value : row.def
    case 'int':
    case 'float': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return row.def
      return clampNumber(row, n)
    }
    case 'enum': {
      const choices = row.choices ?? []
      if (typeof value === 'boolean' && row.boolMap) {
        return value ? row.boolMap.true : row.boolMap.false
      }
      // A `no`/`yes` choice read back from mpv arrives as a boolean (finding 1).
      if (typeof value === 'boolean') {
        const s = value ? 'yes' : 'no'
        return choices.includes(s) ? s : row.def
      }
      const s = typeof value === 'number' ? String(value) : String(value ?? '')
      return choices.includes(s) ? s : row.def
    }
    case 'string':
    case 'path':
      return typeof value === 'string' ? value : row.def
    case 'color': {
      const c = parseColor(value)
      return c ? formatColor(c) : row.def
    }
    case 'list': {
      if (typeof value === 'string') {
        // The binary takes a bare string for a String list and reads it back as
        // a one-element list, so accepting one here loses nothing.
        const one = value.trim()
        return one ? [one] : []
      }
      if (!Array.isArray(value)) return row.def
      return value.map((v) => String(v)).filter((v) => v.length > 0)
    }
  }
}

/**
 * A value read back FROM mpv, normalised to this table's representation.
 *
 * The whole reason this exists is finding 1: `sub-ass-override` reads back as
 * `false` when it is `no` and `true` when it is `yes`, so the obvious
 * `peek<string>()` comparison is wrong for two of the five states. It also
 * folds the numeric readback of the choice-or-integer pair
 * (`image-subs-hdr-peak` -> `1000`) back to the string form the enum stores.
 */
export function fromMpv(row: StyleRow, raw: unknown): unknown {
  return coerce(row, raw)
}

/** The value as `ctx.mpv.set()` must send it. */
export function toMpv(row: StyleRow, value: unknown): unknown {
  const v = coerce(row, value)
  return v
}

/** `--sub-font-size=38`. `null` for the rows that must never be a spawn arg. */
export function argFor(row: StyleRow, value: unknown): string | null {
  if (row.noArg) return null
  const v = coerce(row, value)
  if (row.kind === 'bool') return `--${row.mpv}=${v === true ? 'yes' : 'no'}`
  if ((row.kind === 'path' || row.kind === 'string') && String(v).length === 0) return null
  return `--${row.mpv}=${String(v)}`
}

// --- descriptors -----------------------------------------------------------

function typeOf(row: StyleRow): SettingType {
  switch (row.kind) {
    case 'bool':
      return { kind: 'bool' }
    case 'int':
    case 'float': {
      const t: { kind: 'int' | 'float'; min?: number; max?: number; step?: number } = {
        kind: row.kind
      }
      if (row.min !== undefined) t.min = row.min
      if (row.max !== undefined) t.max = row.max
      if (row.step !== undefined) t.step = row.step
      return t
    }
    case 'enum':
      return {
        kind: 'enum',
        options: (row.choices ?? []).map((v) => ({
          value: v,
          labelKey: `subs-style.opt.${row.key}.${v}`
        }))
      }
    case 'string':
      return { kind: 'string' }
    case 'list':
      return { kind: 'list', of: 'string' }
    case 'path':
      return { kind: 'path', mode: row.pathMode ?? 'file' }
    case 'color':
      /**
       * THE ONE ESCAPE HATCH THIS MODULE USES, and it is here because
       * `SettingType` has no colour kind. Four of S18's five knobs are
       * `#AARRGGBB` with a meaningful alpha (`sub-back-color` defaults to
       * `#AF000000` — 69% black), and the alternatives inside the API are a
       * `string` box where a typo silently falls back to the default, or an
       * `enum` of named colours, which is not a colour picker. See the report.
       */
      return { kind: 'custom', rendererComponent: 'subs-style.color' }
  }
}

export function descriptorFor(row: StyleRow): SettingDescriptor {
  const d: {
    id: string
    section: SettingSection
    group: string
    labelKey: string
    descriptionKey?: string
    type: SettingType
    default: unknown
    keywords: readonly string[]
    mpvOption: string
    order: number
    advanced?: boolean
    visibleWhen?: (get: <V>(id: string) => V) => boolean
  } = {
    id: settingIdOf(row),
    section: SECTION,
    group: `subs-style.group.${row.group}`,
    labelKey: `subs-style.label.${row.key}`,
    descriptionKey: `subs-style.desc.${row.key}`,
    type: typeOf(row),
    default: row.def,
    keywords: row.keywords,
    mpvOption: row.mpv,
    order: row.order
  }
  if (row.advanced) d.advanced = true
  const vis = visibilityOf(row)
  if (vis) d.visibleWhen = vis
  return d as SettingDescriptor
}

/**
 * The only structural dependencies between these rows, expressed with the field
 * that exists for it rather than in a sentence nobody reads.
 *
 * `visibleWhen` sees SETTINGS and nothing else, so it can say "the SDH
 * enclosure list is meaningless while SDH filtering is off" but it cannot say
 * "this track is a PGS bitmap, so the font controls do nothing" — that is not a
 * setting. See the report for that gap; the settings section renders a live
 * warning instead.
 */
function visibilityOf(row: StyleRow): ((get: <V>(id: string) => V) => boolean) | null {
  switch (row.key) {
    case 'filterSdhHarder':
    case 'filterSdhEnclosures':
      return (get) => get<boolean>('subs-style.filterSdh') === true
    case 'filterRegexEnable':
    case 'filterRegexPlain':
    case 'filterRegexWarn':
      return (get) => {
        const list = get<unknown>('subs-style.filterRegex')
        return Array.isArray(list) ? list.length > 0 : false
      }
    case 'scaleSigns':
      // Only `yes`/`scale`/`force` scale anything, so signs cannot be scaled
      // under `no`/`strip`.
      return (get) => {
        const v = get<unknown>('subs-style.assOverride')
        const s = typeof v === 'boolean' ? (v ? 'force' : 'no') : String(v ?? 'no')
        return s === 'yes' || s === 'scale' || s === 'force'
      }
    default:
      return null
  }
}

export function descriptors(): SettingDescriptor[] {
  return ROWS.map(descriptorFor)
}

// --- S26 presets -----------------------------------------------------------

export interface StylePreset {
  readonly id: string
  /** Row key -> value. Every other row is left exactly as the user has it. */
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * A preset is a property→value map applied in one batch (S26). It is applied by
 * writing SETTINGS, not properties: the settings are what the spawn args are
 * built from, so a preset survives a respawn and shows up in the form. mpv's own
 * `--profile=sub-box` is startup-time only, which is why this is replicated
 * here rather than delegated.
 */
export const PRESETS: readonly StylePreset[] = [
  {
    // S26 "Readable": a box behind the text, big, high on the frame.
    id: 'readable',
    values: {
      fontSize: 52,
      borderStyle: 'background-box',
      backColor: '#C0000000',
      outlineSize: 2.5,
      shadowOffset: 2,
      assOverride: 'force',
      scaleSigns: true,
      marginY: 48
    }
  },
  {
    // S26 "Fansub-safe": nothing of ours touches the release's own styling.
    id: 'fansub',
    values: {
      assOverride: 'no',
      useMargins: false,
      assForceMargins: false,
      scaleSigns: false
    }
  },
  {
    // Accessibility: opaque box, no transparency to read through, large text.
    id: 'accessible',
    values: {
      fontSize: 64,
      bold: true,
      borderStyle: 'background-box',
      backColor: '#FF000000',
      color: '#FFFFFF00',
      outlineSize: 3,
      assOverride: 'force',
      scaleSigns: true,
      marginY: 60
    }
  }
]

export function presetById(id: string): StylePreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** Setting id -> coerced value, for one preset. Unknown keys are dropped. */
export function presetWrites(id: string): Record<string, unknown> {
  const p = presetById(id)
  if (!p) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(p.values)) {
    const row = rowByKey(key)
    if (!row) continue
    out[settingIdOf(row)] = coerce(row, value)
  }
  return out
}

/** Every row back to its declared default. */
export function resetWrites(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of ROWS) out[settingIdOf(row)] = row.def
  return out
}

// --- helpers the module and its tests share -------------------------------

/** mpv's own codec names for the four bitmap subtitle formats (S25). */
export const IMAGE_SUB_CODECS: readonly string[] = [
  'dvd_subtitle',
  'hdmv_pgs_subtitle',
  'dvb_subtitle',
  'dvb_teletext',
  'xsub'
]

export function isImageSubCodec(codec: unknown): boolean {
  return typeof codec === 'string' && IMAGE_SUB_CODECS.includes(codec)
}

/** Next value in a cycle, wrapping. Used by the ASS-override cycle command. */
export function cycleNext(choices: readonly string[], current: unknown): string {
  const first = choices[0] ?? ''
  if (choices.length === 0) return first
  const i = choices.indexOf(String(current))
  return choices[(i + 1) % choices.length] ?? first
}

/** A step on a numeric row, clamped to the verified range. */
export function stepValue(row: StyleRow, current: unknown, delta: number): number {
  const base = coerce(row, current)
  return clampNumber(row, (typeof base === 'number' ? base : 0) + delta)
}
