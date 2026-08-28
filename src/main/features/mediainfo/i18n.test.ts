import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assertModule from 'node:assert'
import test from 'node:test'
import { EN, KEYS, KO } from './i18n.ts'

/**
 * The message catalogue, and the check that it is actually COMPLETE.
 *
 * A missing i18n key does not throw and does not fail a typecheck: `t()` returns
 * the key unchanged, by design, because that is what lets a metadata TAG name be
 * its own label. So a label key the panel can emit and the catalogue does not
 * carry renders as `mediainfo.f.trackDemuxPar` on screen, in both languages, and
 * nothing anywhere notices.
 *
 * The check therefore has to be the other way round: EXTRACT every key the code
 * can emit and require the catalogue to hold it. And it has to count what it
 * extracted, because a regex that stops matching reports "clean" -- the exact
 * shape of the `wantedCount` guard in `manifest.test.ts`, which went green while
 * comparing nothing.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.resolve(here, '..', '..', '..', 'renderer', 'src', 'features', 'mediainfo')

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Every `mediainfo.…` literal in a KEY POSITION.
 *
 * Not every `'mediainfo.x'` in the source is a message key: command ids, panel
 * ids, stats-section ids and IPC channels share the namespace by design (the
 * guide requires it). A regex that took them all reported twelve false
 * positives -- `mediainfo.toggle`, `mediainfo.general`, `mediainfo.reportText`
 * -- and a check that cries wolf twelve times is a check people delete. So the
 * extraction is anchored on the five positions a string can actually reach
 * `t()` from.
 */
const KEY_POSITIONS: readonly RegExp[] = [
  // ctx.i18n.t('…') and the renderer's ctx.t('…')
  /\bt\(\s*'(mediainfo\.[A-Za-z0-9_.-]+)'/g,
  /\b(?:labelKey|titleKey|descriptionKey)\s*:\s*'(mediainfo\.[A-Za-z0-9_.-]+)'/g,
  // toolButton('…', …) in the renderer half and push('…', …) in the main half
  /\b(?:toolButton|push)\(\s*'(mediainfo\.[A-Za-z0-9_.-]+)'/g,
  // row('…', …) / { labelKey: … } object literals written inline
  /\brow\(\s*'(mediainfo\.[A-Za-z0-9_.-]+)'/g
]

function keysIn(text: string): string[] {
  const out: string[] = []
  for (const re of KEY_POSITIONS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) out.push(m[1] as string)
  }
  return out
}

/** `F('videoCodec')` in snapshot.ts expands to `mediainfo.f.videoCodec`. */
function fKeysIn(text: string): string[] {
  return [...text.matchAll(/\bF\('([A-Za-z0-9_]+)'\)/g)].map((m) => `mediainfo.f.${m[1]}`)
}

/** `mediainfo.f.duration` etc. spelled in full in probe.ts / properties.ts. */
const mainFiles = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => path.join(here, f))

const rendererFiles = fs.existsSync(rendererDir)
  ? fs
      .readdirSync(rendererDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(rendererDir, f))
  : []

// ---------------------------------------------------------------------------

test('the two catalogues have identical key sets', () => {
  // Declared as ONE table of pairs precisely so this cannot drift -- but the
  // assertion is still here, because the derivation could be changed.
  assert.deepEqual(Object.keys(KO).sort(), Object.keys(EN).sort())
  assert.deepEqual([...KEYS].sort(), Object.keys(KO).sort())
})

test('every key is namespaced, or core/i18n throws at boot', () => {
  for (const k of KEYS) {
    assert.ok(k.startsWith('mediainfo.'), `'${k}' is not under this module's namespace`)
  }
})

test('no message is empty, and Korean is never the English string', () => {
  const untranslated: string[] = []
  for (const k of KEYS) {
    const ko = KO[k]
    const en = EN[k]
    assert.ok(ko && ko.length > 0, `${k} has no Korean message`)
    assert.ok(en && en.length > 0, `${k} has no English message`)
    // A handful of keys are legitimately identical -- proper nouns and
    // acronyms. Anything else identical is a key somebody forgot to translate.
    if (ko === en) untranslated.push(k)
  }
  assert.deepEqual(
    untranslated.sort(),
    ['mediainfo.f.maxCll', 'mediainfo.f.maxFall'],
    'these keys have the same Korean and English text; if that is deliberate ' +
      '(an acronym or a proper noun) add it to the list, otherwise translate it'
  )
})

test('every interpolation placeholder appears in BOTH languages', () => {
  // `t()` substitutes `{name}`; a placeholder present in one catalogue and not
  // the other renders the literal braces to half the users.
  for (const k of KEYS) {
    const ko = new Set([...(KO[k] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
    const en = new Set([...(EN[k] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
    assert.deepEqual([...ko].sort(), [...en].sort(), `${k}: placeholders differ`)
  }
})

test('EVERY key either half can emit is in the catalogue, and the extraction is not empty', () => {
  const emitted = new Set<string>()
  let scanned = 0
  for (const file of [...mainFiles, ...rendererFiles]) {
    const text = read(file)
    scanned++
    for (const k of keysIn(text)) emitted.add(k)
    for (const k of fKeysIn(text)) emitted.add(k)
  }
  // Template keys the code builds at runtime: `mediainfo.density.${which}` and
  // `mediainfo.tab.${tb}`. Spelled out here because a regex cannot see them,
  // and asserted below so this list cannot rot silently either.
  for (const d of ['full', 'short', 'misc']) emitted.add(`mediainfo.density.${d}`)
  for (const t of ['info', 'tracks', 'properties']) emitted.add(`mediainfo.tab.${t}`)

  // The guard: an extraction that finds nothing must fail, not pass.
  assert.ok(scanned >= 8, `expected to scan both halves, scanned ${scanned} files`)
  assert.ok(emitted.size >= 60, `extracted only ${emitted.size} keys; the regex has rotted`)

  const missing = [...emitted].filter((k) => !(k in KO)).sort()
  assert.deepEqual(
    missing,
    [],
    'these keys are emitted by the code and absent from the catalogue, so they ' +
      'would render as raw keys in both languages:\n  ' + missing.join('\n  ')
  )
})

test('and nothing in the catalogue is DEAD, which is the other half of the same rot', () => {
  /**
   * The direction above catches a key the panel needs and the catalogue lacks.
   * This one catches a key the catalogue carries and nothing emits -- which is
   * how a catalogue accumulates strings for features that were renamed or never
   * built, and how a reviewer's "is this translated?" stops meaning anything.
   *
   * Five were found the first time it ran: `mediainfo.expand`,
   * `mediainfo.noArt`, `mediainfo.probing`, `mediainfo.probeDisabled` and
   * `mediainfo.group.file` -- all four of the first written against panel
   * behaviour that ended up expressed differently, and the fifth a group title
   * for a group `properties.ts` renders without one.
   */
  const emitted = new Set<string>()
  const source = [...mainFiles, ...rendererFiles]
    .filter((f) => !f.endsWith('i18n.ts'))
    .map(read)
    .join('\n')
  // Deliberately GENEROUS here: any literal spelling of the key anywhere counts,
  // and so does an `F('…')` expansion. A key is dead only if it appears nowhere
  // at all, so this half can never be the reason a real key is deleted.
  for (const m of source.matchAll(/'(mediainfo\.[A-Za-z0-9_.-]+)'/g)) emitted.add(m[1] as string)
  for (const k of fKeysIn(source)) emitted.add(k)
  for (const d of ['full', 'short', 'misc']) emitted.add(`mediainfo.density.${d}`)
  for (const t of ['info', 'tracks', 'properties']) emitted.add(`mediainfo.tab.${t}`)

  assert.ok(emitted.size >= 60, `extracted only ${emitted.size} literals; the regex has rotted`)
  const dead = KEYS.filter((k) => !emitted.has(k)).sort()
  assert.deepEqual(
    dead,
    [],
    'these catalogue keys are emitted by nothing:\n  ' + dead.join('\n  ')
  )
})

test('the runtime-built density and tab keys really are in the catalogue', () => {
  // The list above is only trustworthy if the shapes it names still exist in
  // the source. This is the half that notices a rename.
  const renderer = rendererFiles.map(read).join('\n')
  assert.match(renderer, /mediainfo\.density\.\$\{/)
  assert.match(renderer, /mediainfo\.tab\.\$\{/)
  for (const d of ['full', 'short', 'misc']) assert.ok(`mediainfo.density.${d}` in KO)
  for (const t of ['info', 'tracks', 'properties']) assert.ok(`mediainfo.tab.${t}` in KO)
})

test('and the extraction can see itself: a planted key is reported missing', () => {
  // The self-check the check needs. Without it, "no missing keys" is equally
  // true of a regex that matches nothing -- which is how the manifest
  // dependency cross-check went green while comparing zero pairs.
  const planted = keysIn("ctx.i18n.t('mediainfo.doesNotExist')")
  assertModule.deepEqual(planted, ['mediainfo.doesNotExist'])
  assertModule.equal('mediainfo.doesNotExist' in KO, false)
  assertModule.deepEqual(fKeysIn("row(F('plantedField'), 'x')"), ['mediainfo.f.plantedField'])
})
