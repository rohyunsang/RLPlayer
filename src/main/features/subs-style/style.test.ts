import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRESETS,
  ROWS,
  argFor,
  coerce,
  cycleChoicesOf,
  cycleNext,
  descriptorFor,
  descriptors,
  formatColor,
  fromMpv,
  isImageSubCodec,
  parseColor,
  presetById,
  presetWrites,
  resetWrites,
  rowByKey,
  rowBySettingId,
  settingIdOf,
  stepValue,
  tableProperties,
  toMpv,
  type StyleRow
} from './style.ts'

/**
 * M19's TABLE, asserted against the two things that can contradict it: the
 * pinned binary's own option list, and `docs/parity/modules.json`.
 *
 * The rule every one of these follows is the one five audit rounds keep
 * producing: nothing here iterates a list typed into this file and then checks
 * that list against itself. Every set comparison has an independent second
 * source — the manifest, the module's own `ownsProperties`, or the ranges
 * measured over IPC — and every comparison runs in BOTH directions, because a
 * one-way subset check passes for a table that is missing half its rows.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

interface ManifestRow {
  id: string
  ownedProperties: string[]
  ownedFiles: string[]
  features: string[]
  mustNotTouch: string[]
  usesMediators: string[]
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
) as ManifestRow[]
const row19 = manifest.find((m) => m.id === 'M19')
assert.ok(row19, 'modules.json has no M19 row')

// --- the table against modules.json, both directions -----------------------

test('every property in the table is declared in the M19 manifest row', () => {
  const declared = new Set(row19.ownedProperties)
  const missing = tableProperties().filter((p) => !declared.has(p))
  assert.deepEqual(missing, [], 'rows whose mpv property no manifest row claims')
})

test('every property the M19 manifest row claims has a row in the table', () => {
  const inTable = new Set(tableProperties())
  const unimplemented = row19.ownedProperties.filter((p) => !inTable.has(p))
  assert.deepEqual(unimplemented, [], 'claimed properties with no descriptor behind them')
})

test('the table claims no property another manifest row owns', () => {
  const mine = new Set(tableProperties())
  const clashes: string[] = []
  for (const m of manifest) {
    if (m.id === 'M19') continue
    for (const p of m.ownedProperties) if (mine.has(p)) clashes.push(`${p} (${m.id})`)
  }
  assert.deepEqual(clashes, [], 'ownership collisions — the registry would refuse to boot')
})

test('no mpv property appears twice in the table', () => {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const p of tableProperties()) {
    if (seen.has(p)) dupes.push(p)
    seen.add(p)
  }
  assert.deepEqual(dupes, [])
})

/**
 * M20 owns `sub-speed` and S30 says never to ship UI wired to `sub-fps` — the
 * frames are already timestamps by the time libavformat is done, so it scales
 * nothing. Both are easy to add here by mistake because the module's brief says
 * "plus sub speed/FPS correction".
 */
test('sub-speed and sub-fps are absent, and sub-speed belongs to M20', () => {
  assert.equal(tableProperties().includes('sub-speed'), false)
  assert.equal(tableProperties().includes('sub-fps'), false)
  const m20 = manifest.find((m) => m.id === 'M20')
  assert.ok(m20?.ownedProperties.includes('sub-speed'))
})

// --- the ranges, against the values the binary rejected --------------------

/**
 * MEASURED, not assumed. Each pair below is a write that the pinned binary
 * REFUSED over JSON IPC with `unsupported format for accessing property`,
 * leaving the old value in place. `coerce()` has to bring each one inside the
 * range, or the setting is a silent no-op.
 */
const REJECTED_BY_MPV: ReadonlyArray<[string, number]> = [
  ['pos', 200],
  ['marginX', -5],
  ['blur', 21],
  ['spacing', 11],
  ['gauss', 4],
  ['scale', 101],
  ['fontSize', 0],
  ['lineSpacing', -1001]
]

test('every value the binary rejected is clamped into range', () => {
  for (const [key, bad] of REJECTED_BY_MPV) {
    const row = rowByKey(key)
    assert.ok(row, `no row '${key}'`)
    const v = coerce(row, bad) as number
    assert.equal(typeof v, 'number', `${key} did not coerce to a number`)
    if (row.min !== undefined) assert.ok(v >= row.min, `${key}: ${v} < min ${row.min}`)
    if (row.max !== undefined) assert.ok(v <= row.max, `${key}: ${v} > max ${row.max}`)
    assert.notEqual(v, bad, `${key} passed the rejected value straight through`)
  }
})

test('sub-pos 150 is accepted by the binary and so must survive coercion', () => {
  const row = rowByKey('pos')
  assert.ok(row)
  assert.equal(coerce(row, 150), 150)
})

test('an int row rounds and a float row does not', () => {
  const pos = rowByKey('pos')
  const scale = rowByKey('scale')
  assert.ok(pos && scale)
  assert.equal(coerce(pos, 100.6), 101)
  assert.equal(coerce(scale, 1.234), 1.234)
})

/**
 * THE SECOND DEFECT THIS FILE FOUND IN THE DRAFT. `coerce` did
 * `const n = typeof value === 'number' ? value : Number(value)`, and
 * `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all `0`
 * — finite, so each one survived the `isFinite` check and clamped to the row's
 * MINIMUM. A `config.json` carrying `"subs-style.fontSize": null` rendered
 * 8-pixel subtitles rather than the 38 the descriptor promises.
 *
 * Against the old implementation the first four assertions below fail with
 * `8 !== 38`; the `'not a number'` and `undefined` cases pass, which is exactly
 * why a test that only tried those two would have shipped it.
 */
test('a non-numeric value falls back to the row default rather than to the minimum', () => {
  const row = rowByKey('fontSize')
  assert.ok(row)
  assert.notEqual(row.def, row.min, 'this test cannot distinguish default from minimum')
  for (const absent of [null, '', '   ', [], false, {}]) {
    assert.equal(coerce(row, absent), row.def, JSON.stringify(absent))
  }
  assert.equal(coerce(row, 'not a number'), row.def)
  assert.equal(coerce(row, undefined), row.def)
  // A numeric STRING is real input — the settings store round-trips JSON, and a
  // hand-edited "38" should still mean 38.
  assert.equal(coerce(row, '52'), 52)
})

test('every numeric row can hold its own default', () => {
  for (const row of ROWS) {
    if (row.kind !== 'int' && row.kind !== 'float') continue
    assert.equal(coerce(row, row.def), row.def, `${row.key}'s default is outside its own range`)
  }
})

// --- finding 1: the two boolean decoders are NOT the same ------------------

/**
 * THE DEFECT THIS TEST EXISTS FOR, and it was live in the draft of `style.ts`.
 *
 * `fromMpv` was defined as `= coerce`, and `coerce` honours `boolMap`, which
 * encodes what the v0.1.1 CHECKBOX meant: `true` = "use my font" = `force`.
 * mpv's boolean readback means something else entirely — measured against the
 * pinned binary, `set sub-ass-override "yes"` reads back as `true`. So the old
 * `fromMpv(row, true)` answered `'force'` for a property that was `yes`: two
 * states apart, and the wrong one claims we are overriding a release group's
 * typesetting.
 *
 * Run against the OLD implementation (`export const fromMpv = coerce`) the third
 * assertion below fails with `'force' !== 'yes'`; the first two pass, which is
 * why a test that only checked `no` would have shipped the bug.
 */
test('fromMpv decodes mpv booleans as yes/no and never through boolMap', () => {
  const row = rowByKey('assOverride')
  assert.ok(row)
  assert.ok(row.boolMap, 'the boolMap this test is about is gone; re-read finding 1')

  assert.equal(fromMpv(row, false), 'no')
  assert.equal(fromMpv(row, 'scale'), 'scale')
  assert.equal(fromMpv(row, true), 'yes')
  assert.notEqual(fromMpv(row, true), 'force')
})

test('coerce still honours boolMap, because the legacy checkbox meant force', () => {
  const row = rowByKey('assOverride')
  assert.ok(row)
  assert.equal(coerce(row, true), 'force')
  assert.equal(coerce(row, false), 'no')
})

test('a boolean readback on an enum with no yes/no choice falls back, not invents', () => {
  const row = rowByKey('borderStyle')
  assert.ok(row)
  assert.equal(row.choices?.includes('yes'), false)
  assert.equal(fromMpv(row, true), row.def)
})

test('fromMpv folds the other measured readback shapes', () => {
  const vsf = rowByKey('vsfilterColorCompat')
  const peak = rowByKey('imageSubsHdrPeak')
  const regex = rowByKey('filterRegex')
  assert.ok(vsf && peak && regex)
  // set "no" -> get false
  assert.equal(fromMpv(vsf, false), 'no')
  // set "1000" -> get 1000
  assert.equal(fromMpv(peak, 1000), '1000')
  // set "x" -> get ["x"]
  assert.deepEqual(fromMpv(regex, ['x']), ['x'])
  assert.deepEqual(coerce(regex, 'x'), ['x'])
})

// --- colour ----------------------------------------------------------------

test('a six-digit hex is read as opaque and formatted the way mpv reads it back', () => {
  // Measured: set sub-color "#FF00FF" -> get "#FFFF00FF".
  const c = parseColor('#FF00FF')
  assert.ok(c)
  assert.deepEqual(c, { a: 255, r: 255, g: 0, b: 255 })
  assert.equal(formatColor(c), '#FFFF00FF')
})

test('#AARRGGBB round-trips, alpha first', () => {
  const c = parseColor('#80112233')
  assert.deepEqual(c, { a: 0x80, r: 0x11, g: 0x22, b: 0x33 })
  assert.equal(formatColor(c!), '#80112233')
})

test('an unreadable colour is rejected rather than half-parsed', () => {
  for (const bad of ['', '#FFF', '#12345', 'red', '#GGGGGG', 'rgba(1,2,3,4)', 42, null]) {
    assert.equal(parseColor(bad), null, `parsed ${JSON.stringify(bad)}`)
  }
})

test('a colour row coerces an unreadable value to its default, not to transparent', () => {
  const row = rowByKey('backColor')
  assert.ok(row)
  assert.equal(coerce(row, 'nonsense'), row.def)
  assert.equal(coerce(row, '#AF000000'), '#AF000000')
})

test('every colour row default is a canonical #AARRGGBB', () => {
  for (const row of ROWS) {
    if (row.kind !== 'color') continue
    const c = parseColor(row.def)
    assert.ok(c, `${row.key} default is not a colour`)
    assert.equal(formatColor(c), row.def, `${row.key} default is not canonical`)
  }
})

// --- spawn arguments -------------------------------------------------------

test('argFor spells booleans the way mpv CLI wants them', () => {
  const bold = rowByKey('bold')
  const embedded = rowByKey('embeddedFonts')
  assert.ok(bold && embedded)
  assert.equal(argFor(bold, true), '--sub-bold=yes')
  assert.equal(argFor(bold, false), '--sub-bold=no')
  assert.equal(argFor(embedded, false), '--embeddedfonts=no')
})

/**
 * The three String-list rows are never spawn args: mpv's CLI splits a list on
 * `,`, and `sub-filter-sdh-enclosures` has `,` and `(` INSIDE its default value
 * (`(),[],（）`, confirmed verbatim in `--list-options`).
 */
test('no list row is ever contributed as a spawn argument', () => {
  for (const row of ROWS) {
    if (row.kind !== 'list') continue
    assert.equal(row.noArg, true, `${row.key} is a list and not marked noArg`)
    assert.equal(argFor(row, row.def), null)
  }
})

test('an empty path or string contributes nothing rather than an empty option', () => {
  const dir = rowByKey('fontsDir')
  const styles = rowByKey('assStyles')
  const font = rowByKey('font')
  assert.ok(dir && styles && font)
  assert.equal(argFor(dir, ''), null)
  assert.equal(argFor(styles, ''), null)
  assert.equal(argFor(dir, 'C:/fonts'), '--sub-fonts-dir=C:/fonts')
  assert.equal(argFor(font, 'Malgun Gothic'), '--sub-font=Malgun Gothic')
})

test('no two rows produce the same option name — the §4 duplicate check', () => {
  const names = new Set<string>()
  for (const row of ROWS) {
    const arg = argFor(row, row.def === '' ? 'x' : row.def)
    if (arg === null) continue
    const name = arg.slice(0, arg.indexOf('='))
    assert.equal(names.has(name), false, `${name} contributed twice`)
    names.add(name)
  }
})

/**
 * Core reserves these prefixes and refuses a contributor that uses one, and 26
 * more are inert under `--wid`. None of M19's fifty may collide.
 */
test('no row contributes a core-reserved or wid-inert option', () => {
  const reserved = [
    '--wid',
    '--input-',
    '--no-config',
    '--config',
    '--osc',
    '--osd-',
    '--vo',
    '--gpu-context',
    '--idle',
    '--force-window',
    '--keep-open',
    '--terminal',
    '--msg-level',
    '--load-scripts',
    '--include',
    '--drag-and-drop',
    '--ytdl',
    '--border',
    '--title',
    '--geometry',
    '--autofit',
    '--ontop',
    '--fullscreen',
    '--fs'
  ]
  for (const row of ROWS) {
    const arg = argFor(row, row.def === '' ? 'x' : row.def)
    if (arg === null) continue
    const name = arg.slice(0, arg.indexOf('='))
    for (const r of reserved) {
      assert.equal(name === r || name.startsWith(r), false, `${name} collides with ${r}`)
    }
  }
})

// --- descriptors -----------------------------------------------------------

test('every descriptor id is namespaced and lands in the subtitles section', () => {
  for (const d of descriptors()) {
    assert.ok(d.id.startsWith('subs-style.'), d.id)
    assert.equal(d.section, 'subtitles')
    assert.ok(d.labelKey.startsWith('subs-style.'), d.labelKey)
    assert.ok((d.group ?? '').startsWith('subs-style.group.'), d.id)
    assert.equal(typeof d.order, 'number')
    assert.equal(d.mpvOption, rowBySettingId(d.id)?.mpv)
  }
})

test('the descriptor set and the table are the same size', () => {
  assert.equal(descriptors().length, ROWS.length)
  assert.equal(new Set(descriptors().map((d) => d.id)).size, ROWS.length)
})

test('every enum descriptor offers exactly the row choices, each with a label key', () => {
  for (const row of ROWS) {
    if (row.kind !== 'enum') continue
    const t = descriptorFor(row).type
    assert.equal(t.kind, 'enum')
    if (t.kind !== 'enum') return
    assert.deepEqual(
      t.options.map((o) => o.value),
      [...(row.choices ?? [])]
    )
    for (const o of t.options) {
      assert.equal(o.labelKey, `subs-style.opt.${row.key}.${o.value}`)
    }
  }
})

test('a colour row is the only escape hatch this module uses', () => {
  const custom = ROWS.filter((r) => descriptorFor(r).type.kind === 'custom')
  assert.deepEqual(
    custom.map((r) => r.key).sort(),
    ['backColor', 'color', 'outlineColor']
  )
  for (const r of custom) {
    const t = descriptorFor(r).type
    assert.equal(t.kind === 'custom' && t.rendererComponent, 'subs-style.color')
  }
})

test('the ASS styles path carries an ASS/SSA filter', () => {
  const row = rowByKey('assStyles')
  assert.ok(row)
  const t = descriptorFor(row).type
  assert.equal(t.kind, 'path')
  if (t.kind !== 'path') return
  assert.equal(t.mode, 'file')
  assert.deepEqual(t.filters, [{ name: 'ASS/SSA', extensions: ['ass', 'ssa'] }])
})

/**
 * The generated form buckets rows by `group` in the order it first meets them,
 * so a group whose orders interleave with another's renders its heading twice.
 */
test('group order blocks are contiguous', () => {
  const seen: string[] = []
  for (const row of [...ROWS].sort((a, b) => a.order - b.order)) {
    if (seen[seen.length - 1] !== row.group) {
      assert.equal(seen.includes(row.group), false, `group '${row.group}' is split in two blocks`)
      seen.push(row.group)
    }
  }
})

test('no two rows share an order', () => {
  const orders = ROWS.map((r) => r.order)
  assert.equal(new Set(orders).size, orders.length)
})

test('visibleWhen exists exactly where a row is meaningless without another', () => {
  const withVis = descriptors()
    .filter((d) => typeof d.visibleWhen === 'function')
    .map((d) => d.id)
    .sort()
  assert.deepEqual(withVis, [
    'subs-style.filterRegexEnable',
    'subs-style.filterRegexPlain',
    'subs-style.filterRegexWarn',
    'subs-style.filterSdhEnclosures',
    'subs-style.filterSdhHarder'
  ])
})

/**
 * `scaleSigns` is NOT on that list on purpose. The draft hid it whenever the ASS
 * override was `no`/`strip`, on the theory that nothing scales in those modes —
 * but S24 records, from the same manual, that `sub-scale` "affects ASS subtitles
 * as well" regardless of the override, which is why that row carries a warning.
 * Both cannot be fully true, and settling it needs a typeset ASS sample on
 * screen. A wrong `visibleWhen` hides a control and explains nothing; a wrong
 * sentence in a description is a wording fix. So the dependency lives in the
 * description, and this test pins that choice so nobody re-adds the predicate
 * without watching a sign scale first.
 */
test('scaleSigns is never hidden, because its dependency is unverified', () => {
  const d = descriptors().find((x) => x.id === 'subs-style.scaleSigns')
  assert.ok(d)
  assert.equal(d.visibleWhen, undefined)
})

test('the SDH enclosure list hides when SDH filtering is off, and shows when on', () => {
  const d = descriptors().find((x) => x.id === 'subs-style.filterSdhEnclosures')
  assert.ok(d?.visibleWhen)
  const get = (on: boolean) => (<V,>(): V => on as unknown as V)
  assert.equal(d.visibleWhen(get(false) as <V>(id: string) => V), false)
  assert.equal(d.visibleWhen(get(true) as <V>(id: string) => V), true)
})

// --- the ASS override, which is the module's one deliberate divergence -----

test('the ASS override defaults OFF and records that mpv defaults to scale', () => {
  const row = rowByKey('assOverride')
  assert.ok(row)
  assert.equal(row.def, 'no')
  assert.equal(row.mpvDefault, 'scale')
  assert.deepEqual([...(row.choices ?? [])], ['no', 'yes', 'scale', 'force', 'strip'])
})

test('every other row agrees with the binary default, or says why not', () => {
  // A divergence has to be DECLARED. `mpvDefault` is the only sanctioned way to
  // differ, so any row without one is asserting "this is mpv's default too".
  const declared = ROWS.filter((r) => r.mpvDefault !== undefined).map((r) => r.key)
  assert.deepEqual(declared, ['assOverride'])
})

/** S21's cycle is four states; the select offers five. */
test('the ASS override cycle skips yes and wraps', () => {
  const row = rowByKey('assOverride')
  assert.ok(row)
  const c = cycleChoicesOf(row)
  assert.deepEqual([...c], ['no', 'scale', 'force', 'strip'])
  assert.equal(cycleNext(c, 'no'), 'scale')
  assert.equal(cycleNext(c, 'scale'), 'force')
  assert.equal(cycleNext(c, 'force'), 'strip')
  assert.equal(cycleNext(c, 'strip'), 'no')
  // `yes` is reachable from the select but not in the cycle: land on the first
  // cycle state rather than silently on the second.
  assert.equal(cycleNext(c, 'yes'), 'no')
})

test('a row with no narrowed cycle cycles its full choice list', () => {
  const row = rowByKey('borderStyle')
  assert.ok(row)
  assert.deepEqual([...cycleChoicesOf(row)], [...(row.choices ?? [])])
  assert.equal(cycleNext(cycleChoicesOf(row), 'background-box'), 'outline-and-shadow')
})

// --- presets (S26) ---------------------------------------------------------

test('every preset writes only known rows, coerced', () => {
  for (const p of PRESETS) {
    const writes = presetWrites(p.id)
    assert.ok(Object.keys(writes).length > 0, `${p.id} writes nothing`)
    for (const [id, value] of Object.entries(writes)) {
      const row = rowBySettingId(id)
      assert.ok(row, `${p.id} writes unknown setting ${id}`)
      assert.deepEqual(value, coerce(row, value), `${p.id}/${id} is not coerced`)
    }
    assert.equal(Object.keys(writes).length, Object.keys(p.values).length)
  }
})

test('an unknown preset id writes nothing at all', () => {
  assert.deepEqual(presetWrites('no-such-preset'), {})
  assert.equal(presetById('no-such-preset'), undefined)
})

test('the fansub-safe preset leaves every font and colour row untouched', () => {
  const writes = presetWrites('fansub')
  for (const id of Object.keys(writes)) {
    const row = rowBySettingId(id)
    assert.ok(row)
    assert.notEqual(row.group, 'font', `fansub preset writes ${id}`)
    assert.notEqual(row.group, 'colour', `fansub preset writes ${id}`)
  }
  // and it is the one preset that turns the override OFF rather than forcing it
  assert.equal(writes['subs-style.assOverride'], 'no')
})

test('the readable and accessible presets force the override and scale signs', () => {
  for (const id of ['readable', 'accessible']) {
    const w = presetWrites(id)
    assert.equal(w['subs-style.assOverride'], 'force', id)
    assert.equal(w['subs-style.scaleSigns'], true, id)
    assert.equal(w['subs-style.borderStyle'], 'background-box', id)
  }
})

test('reset covers every row and lands on the declared defaults', () => {
  const writes = resetWrites()
  assert.equal(Object.keys(writes).length, ROWS.length)
  for (const row of ROWS) {
    assert.deepEqual(writes[settingIdOf(row)], row.def, row.key)
  }
})

// --- misc helpers ----------------------------------------------------------

test('image subtitle codecs are mpv codec names, and text codecs are not among them', () => {
  for (const c of ['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub']) {
    assert.equal(isImageSubCodec(c), true, c)
  }
  for (const c of ['ass', 'subrip', 'webvtt', 'mov_text', '', null, undefined, 42]) {
    assert.equal(isImageSubCodec(c), false, String(c))
  }
})

test('stepValue clamps at both ends instead of wrapping or overshooting', () => {
  const scale = rowByKey('scale')
  const pos = rowByKey('pos')
  assert.ok(scale && pos)
  assert.equal(stepValue(scale, 1, 0.1), 1.1)
  assert.equal(stepValue(scale, scale.max as number, 0.1), scale.max)
  assert.equal(stepValue(scale, scale.min as number, -0.1), scale.min)
  assert.equal(stepValue(pos, 150, 1), 150)
  assert.equal(stepValue(pos, 0, -1), 0)
  // A stored value outside the range still steps to something legal.
  assert.equal(stepValue(pos, 900, 1), 150)
})

test('toMpv never emits a value the row would reject on the way back in', () => {
  for (const row of ROWS) {
    const out = toMpv(row, row.def)
    assert.deepEqual(coerce(row, out), out, row.key)
  }
})

test('every row carries search keywords in both scripts', () => {
  for (const row of ROWS) {
    assert.ok(row.keywords.length > 0, `${row.key} has no keywords`)
    const hasHangul = row.keywords.some((k) => /[\uAC00-\uD7A3]/.test(k))
    const hasLatin = row.keywords.some((k) => /[a-z]/i.test(k))
    assert.ok(hasLatin, `${row.key} has no Latin keyword`)
    // A few rows are pure jargon in both languages (`sdh`, `vsfilter`, `dvd`),
    // so Hangul is required only where the row has a Korean name at all.
    if (!hasHangul) {
      assert.ok(
        ['filterSdhHarder', 'stretchDvdSubs', 'scaleByWindow', 'scaleWithWindow'].includes(row.key),
        `${row.key} has no Korean keyword and is not on the jargon list`
      )
    }
  }
})

test('rowByKey and rowBySettingId agree for every row', () => {
  for (const row of ROWS) {
    assert.equal(rowByKey(row.key), row)
    assert.equal(rowBySettingId(settingIdOf(row)), row)
  }
  assert.equal(rowByKey('nope'), undefined)
  assert.equal(rowBySettingId('subs-style.nope'), undefined)
})

test('the table is typed as declared — no row lies about its shape', () => {
  const kinds = new Set<StyleRow['kind']>([
    'bool',
    'int',
    'float',
    'enum',
    'string',
    'list',
    'path',
    'color'
  ])
  for (const row of ROWS) {
    assert.ok(kinds.has(row.kind), row.key)
    if (row.kind === 'enum') assert.ok((row.choices?.length ?? 0) > 1, row.key)
    else assert.equal(row.choices, undefined, `${row.key} has choices but is not an enum`)
    if (row.kind === 'path') assert.ok(row.pathMode, row.key)
    if (row.kind === 'int' || row.kind === 'float') {
      assert.equal(typeof row.def, 'number', row.key)
    }
    if (row.kind === 'bool') assert.equal(typeof row.def, 'boolean', row.key)
    if (row.kind === 'list') assert.ok(Array.isArray(row.def), row.key)
  }
})
