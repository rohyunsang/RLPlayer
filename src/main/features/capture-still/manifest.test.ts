import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPTURE_KEYS,
  COMMAND_VERBS,
  EN,
  KO,
  MENU_ENTRIES,
  MENU_ORDER,
  commandMeta,
  descriptors
} from './manifest.ts'
import { CAPTURE_FORMATS, templateWarnings } from './capture.ts'

/**
 * The DECLARATIVE half, checked against itself.
 *
 * None of this could be asserted before `manifest.ts` existed: everything below
 * lived in `index.ts`, which statically imports `electron` and is therefore
 * unloadable by any test (measured; see the header of `manifest.ts`). So the two
 * defects this file is aimed at were unverifiable by construction:
 *
 *  1. a `labelKey` with no catalog entry. `t()` falls back to the KEY ITSELF, so
 *     the failure mode is a settings row reading
 *     `capture-still.resizeWidthLabel` in the shipped UI. It throws nothing, it
 *     logs nothing, and a typecheck cannot see it.
 *  2. C22's keybindings. §2.4 says the `potplayer` column was read out of
 *     PotPlayer's own shipped `English.ini` `[MenuString]` table and is 8/8
 *     correct — and nothing in the tree encoded that, so a later tidy-up of the
 *     table had nothing to fail against.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

// --- i18n -----------------------------------------------------------------

test('both catalogs carry exactly the same keys, all inside this module', () => {
  const ko = Object.keys(KO).sort()
  const en = Object.keys(EN).sort()
  assert.deepEqual(
    ko.filter((k) => !(k in EN)),
    [],
    'Korean keys with no English string'
  )
  assert.deepEqual(
    en.filter((k) => !(k in KO)),
    [],
    'English keys with no Korean string'
  )
  for (const k of ko) {
    assert.ok(k.startsWith('capture-still.'), `'${k}' is outside this module's i18n namespace`)
    assert.ok(KO[k]!.trim().length > 0, `'${k}' has an empty Korean string`)
    assert.ok(EN[k]!.trim().length > 0, `'${k}' has an empty English string`)
  }
})

test('every key a setting descriptor names is translated in both languages', () => {
  const missing: string[] = []
  const want = (key: string | undefined): void => {
    if (key === undefined) return
    if (!(key in KO) || !(key in EN)) missing.push(key)
  }
  for (const d of descriptors()) {
    want(d.labelKey)
    want(d.descriptionKey)
    if (d.type.kind === 'enum') for (const o of d.type.options) want(o.labelKey)
  }
  assert.deepEqual(missing, [], 'a missing key renders as the raw id in the settings window')
})

test('every command label and the menu title are translated', () => {
  const missing: string[] = []
  for (const verb of COMMAND_VERBS) {
    const key = commandMeta(verb).labelKey
    if (!(key in KO) || !(key in EN)) missing.push(key)
  }
  for (const key of ['capture-still.menuTitle', 'capture-still.burstProgress']) {
    if (!(key in KO) || !(key in EN)) missing.push(key)
  }
  assert.deepEqual(missing, [])
})

test('every DYNAMICALLY built key has a catalog entry (C05 warnings, C06 formats)', () => {
  /**
   * `t(`capture-still.warn.${w}`)` and `capture-still.format.${f}` are assembled
   * at runtime, so neither the compiler nor a grep for a literal key can see
   * them. These are the keys most likely to be missing and least likely to be
   * noticed.
   */
  const warnings = new Set<string>()
  for (const tpl of ['%F-%p-%n', '%F 12:30 %n', '%F', 'shot%%n']) {
    for (const w of templateWarnings(tpl)) warnings.add(w)
  }
  assert.equal(warnings.size, 3, 'the sample templates must exercise every warning kind')
  for (const w of warnings) {
    assert.ok(`capture-still.warn.${w}` in KO, `no Korean string for warning '${w}'`)
    assert.ok(`capture-still.warn.${w}` in EN, `no English string for warning '${w}'`)
  }
  for (const f of CAPTURE_FORMATS) {
    assert.ok(`capture-still.format.${f}` in KO, `no Korean label for format '${f}'`)
    assert.ok(`capture-still.format.${f}` in EN, `no English label for format '${f}'`)
  }
})

test('every capture-still key index.ts asks t() for is in both catalogs', () => {
  /**
   * A source scan, because `index.ts` cannot be imported. It is not elegant, and
   * it is the only thing standing between a toast and a raw key in the shipped
   * UI: `t('capture-still.savedResized', …)` typechecks perfectly with no
   * catalog entry at all.
   */
  const src = fs.readFileSync(path.join(HERE, 'index.ts'), 'utf8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/\bt\(\s*'(capture-still\.[A-Za-z0-9._-]+)'/g)) keys.add(m[1]!)
  assert.ok(keys.size > 10, `expected many t() keys, found ${keys.size} — did the regex rot?`)
  assert.deepEqual(
    [...keys].filter((k) => !(k in KO) || !(k in EN)).sort(),
    []
  )
})

// --- settings -------------------------------------------------------------

test('setting ids are namespaced, sections are legal and orders do not tie', () => {
  const ds = descriptors()
  const byOrder = new Map<number, string>()
  for (const d of ds) {
    assert.ok(d.id.startsWith('capture-still.'), `'${d.id}' is outside this module's namespace`)
    assert.equal(d.section, 'general', 'capture settings all live in the general section')
    assert.equal(d.group, 'capture')
    const order = d.order ?? -1
    assert.ok(order >= 0, `'${d.id}' has no order, so its position is discovery order`)
    const clash = byOrder.get(order)
    assert.equal(clash, undefined, `'${d.id}' and '${clash}' share order ${order}`)
    byOrder.set(order, d.id)
  }
  assert.equal(new Set(ds.map((d) => d.id)).size, ds.length, 'duplicate descriptor id')
})

test('the C06/C07 defaults are the MEASURED ones, not mpv’s', () => {
  const by = new Map(descriptors().map((d) => [d.id, d]))
  /**
   * MEASURED: mpv defaults `screenshot-high-bit-depth` to `yes`, which turned
   * every PNG from an 8-bit H.264 source into a 16-bit file — 5.37 MB for one
   * 1280×720 frame. This module ships `false`.
   */
  assert.equal(by.get('capture-still.highBitDepth')?.default, false)
  // mpv's own screenshot-format default is `jpg`; a player's should not be.
  assert.equal(by.get('capture-still.format')?.default, 'png')
  // C07 costs a read-back and a re-encode per capture, so it is opt-in.
  assert.equal(by.get('capture-still.resizeWidth')?.default, 0)
  // The shipped template must already disambiguate — mpv refuses to overwrite.
  assert.match(String(by.get('capture-still.template')?.default), /%n|%wT/)
})

// --- C22 keybindings ------------------------------------------------------

test('C22: the PotPlayer column is the verified English.ini table', () => {
  /**
   * Five of C22's eight keys are M22's; the other three (`Alt+N` thumbnail
   * sheet, `Alt+C` record video, `Shift+G` record audio) are M23's. Physical
   * codes, modifiers in the fixed Ctrl+Alt+Shift order (P16).
   */
  assert.deepEqual(CAPTURE_KEYS['save']?.potplayer, ['Ctrl+KeyE']) // Save Current Source Frame
  assert.deepEqual(CAPTURE_KEYS['toClipboard']?.potplayer, ['Ctrl+KeyC']) // Copy Source Frame
  assert.deepEqual(CAPTURE_KEYS['saveDisplay']?.potplayer, ['Ctrl+Alt+KeyE']) // Save Screen Frame
  assert.deepEqual(CAPTURE_KEYS['displayToClipboard']?.potplayer, ['Ctrl+Alt+KeyC']) // Copy Screen
  assert.deepEqual(CAPTURE_KEYS['burstToggle']?.potplayer, ['Ctrl+KeyG']) // Capture Consecutive

  /**
   * PotPlayer's bare `S` is the Pixel Shaders menu, NOT a screenshot — one of the
   * ten entries §7.8 lists as wrong in the seed preset. It may appear in
   * `default` and `mpv`; never in `potplayer`.
   */
  for (const [verb, presets] of Object.entries(CAPTURE_KEYS)) {
    for (const accel of presets.potplayer ?? []) {
      assert.notEqual(accel, 'KeyS', `${verb}: PotPlayer's S is the Pixel Shaders menu`)
    }
  }
})

test('C22: the {source,screen}×{save,clipboard} matrix is complete and modifier-shaped', () => {
  // "Users find the fourth key by pattern" only holds if all four exist.
  for (const verb of ['save', 'toClipboard', 'saveDisplay', 'displayToClipboard']) {
    assert.ok(COMMAND_VERBS.includes(verb), `${verb} is missing from the matrix`)
    assert.ok((CAPTURE_KEYS[verb]?.default ?? []).length > 0, `${verb} has no default binding`)
  }
  // The screen-frame keys differ from the source-frame keys by a modifier only.
  const base = (a: string): string => a.split('+').pop()!
  assert.equal(
    base(CAPTURE_KEYS['saveDisplay']!.potplayer![0]!),
    base(CAPTURE_KEYS['save']!.potplayer![0]!)
  )
  assert.equal(
    base(CAPTURE_KEYS['displayToClipboard']!.potplayer![0]!),
    base(CAPTURE_KEYS['toClipboard']!.potplayer![0]!)
  )
})

test('no two of this module’s commands claim the same accelerator in one preset', () => {
  for (const preset of ['default', 'potplayer', 'mpv'] as const) {
    const seen = new Map<string, string>()
    for (const verb of COMMAND_VERBS) {
      for (const accel of CAPTURE_KEYS[verb]?.[preset] ?? []) {
        const other = seen.get(accel)
        assert.equal(other, undefined, `${preset}: '${accel}' is on both ${verb} and ${other}`)
        seen.set(accel, verb)
      }
    }
  }
})

test('accelerators are PHYSICAL codes in Ctrl+Alt+Shift order (P16)', () => {
  /**
   * With the Korean IME composing, `e.key` is 'Process' for every letter, so a
   * character-shaped binding stops working the moment someone switches to 한글.
   * A single-character final segment is the tell.
   */
  const ORDER = ['Ctrl', 'Alt', 'Shift']
  for (const verb of COMMAND_VERBS) {
    for (const preset of ['default', 'potplayer', 'mpv'] as const) {
      for (const accel of CAPTURE_KEYS[verb]?.[preset] ?? []) {
        const parts = accel.split('+')
        const code = parts[parts.length - 1]!
        const mods = parts.slice(0, -1)
        assert.ok(code.length > 1, `${verb}/${preset}: '${accel}' looks like a character, not a code`)
        for (const m of mods) {
          assert.ok(ORDER.includes(m), `${verb}/${preset}: '${accel}' has an unknown modifier '${m}'`)
        }
        assert.deepEqual(
          mods,
          [...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
          `${verb}/${preset}: '${accel}' is not in Ctrl+Alt+Shift order`
        )
      }
    }
  }
})

// --- C23 menu -------------------------------------------------------------

test('C23: the submenu names only real commands, and every command is in it', () => {
  const verbs = new Set(COMMAND_VERBS)
  const inMenu: string[] = []
  for (const e of MENU_ENTRIES) {
    if ('separator' in e) continue
    assert.ok(verbs.has(e.verb), `the menu names '${e.verb}', which is not a registered command`)
    inMenu.push(e.verb)
  }
  assert.equal(new Set(inMenu).size, inMenu.length, 'a command appears twice in the submenu')
  // A capture action reachable only by a keybind is a discoverability bug: the
  // context menu is where a PotPlayer user looks first.
  assert.deepEqual(
    COMMAND_VERBS.filter((v) => !inMenu.includes(v)),
    [],
    'these commands have no menu entry'
  )
  assert.equal(MENU_ORDER, 60, 'M23 documents 62 for its own section on the basis that M22 holds 60')
})

test('C23: the wrapper submenu is needed because core never draws a section title', () => {
  /**
   * `core/menu.ts#buildTemplate()` renders a contributed section as a bare block
   * of its `items` separated by separators and never reads `section.labelKey`.
   * The whole shape of this module's menu contribution rests on that, so it is
   * CHECKED against the real core file rather than trusted. If core starts
   * drawing section titles, this module's wrapper item becomes a doubled heading
   * and this test is what says so.
   */
  const core = fs.readFileSync(path.join(HERE, '..', '..', 'core', 'menu.ts'), 'utf8')
  const start = core.indexOf('buildTemplate()')
  const end = core.indexOf('private node(')
  assert.ok(start > 0 && end > start, 'could not find buildTemplate() — did core/menu.ts move?')
  assert.ok(
    !core.slice(start, end).includes('section.labelKey'),
    'core now renders a section title; drop this module’s wrapper submenu item'
  )
})
