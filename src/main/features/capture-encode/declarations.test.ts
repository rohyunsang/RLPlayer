/**
 * M23 capture-encode — the declarations, and the manifest they have to agree
 * with.
 *
 * THREE CLASSES OF DEFECT THAT NOTHING ELSE IN THE PIPELINE CATCHES:
 *
 *  1. **A `labelKey` with no catalog entry.** It renders as the raw key
 *     (`capture-encode.gifFpsLabel`) in the settings window. A typecheck cannot
 *     see it — `labelKey` is a `string` — and neither can a reviewer scanning a
 *     500-line descriptor array. This file resolves every key the descriptors,
 *     the commands, the menu and the RENDERER half name, against both catalogs.
 *  2. **An asymmetric catalog.** A key present in `EN` and missing from `KO`
 *     renders English in the middle of a Korean sentence, which is worse than an
 *     untranslated app because it looks like a bug in the sentence rather than a
 *     missing translation.
 *  3. **`ownsProperties` / `ownsCommands` drifting from
 *     `docs/parity/modules.json`.** §2 says `npm test` compares them "in both
 *     directions for every implemented module"; this is M23's half of that, and
 *     it reads the manifest rather than restating it.
 *
 * The command and menu declarations live in `index.ts`, which imports `electron`
 * and therefore cannot be loaded here (§13). They are read as TEXT — which is
 * exactly the kind of check that lies, so the extraction asserts it found a
 * plausible number of each thing before it asserts anything about them. A regex
 * that silently matched nothing would otherwise make this whole file pass by
 * checking an empty set, which is how the orphan counter green-lit real orphans.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AUDIO_FORMATS, CLIP_PRESETS, GIF_DITHERS } from './encode-args.ts'
import { EN, KO, descriptors, enumOptions } from './declarations.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const indexSrc = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')
const rendererSrc = fs.readFileSync(
  path.join(repo, 'src', 'renderer', 'src', 'features', 'capture-encode', 'index.ts'),
  'utf8'
)
const manifest = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
) as Array<{
  id: string
  path: string
  ownedFiles: string[]
  ownedProperties: string[]
  ownedCommands: string[]
  features: string[]
}>
const row = manifest.find((r) => r.id === 'M23')

/** Every `xKey: 'capture-encode.…'` literal in a source file. */
function keysIn(src: string): string[] {
  return [...src.matchAll(/(?:labelKey|titleKey|descriptionKey)\s*:\s*'(capture-encode\.[^']+)'/g)]
    .map((m) => m[1] as string)
    .concat([...src.matchAll(/ctx\.t\('(capture-encode\.[^']+)'\)/g)].map((m) => m[1] as string))
}

/** Every `toast(...)`/`t(...)` message key in the main half. */
function messageKeysIn(src: string): string[] {
  return [
    ...src.matchAll(/(?:toast\(\s*'(?:info|error)'\s*,|i18n\.t\()\s*'(capture-encode\.[^']+)'/g)
  ].map((m) => m[1] as string)
}

const commandIds = [...indexSrc.matchAll(/^\s{8}id: '(capture-encode\.[a-zA-Z]+)',$/gm)].map(
  (m) => m[1] as string
)

// ---------------------------------------------------------------------------
// The extraction itself, first
// ---------------------------------------------------------------------------

test('the text extraction actually found things', () => {
  // Guard against the failure mode this file is most exposed to: a regex that
  // matches nothing makes every set-based assertion below vacuously true.
  assert.ok(indexSrc.length > 10_000, 'index.ts looks truncated')
  assert.ok(rendererSrc.length > 3_000, 'the renderer half looks truncated')
  assert.ok(commandIds.length >= 10, `only ${commandIds.length} command ids extracted`)
  assert.ok(keysIn(indexSrc).length >= 10, 'no labelKeys found in index.ts')
  assert.ok(keysIn(rendererSrc).length >= 8, 'no labelKeys found in the renderer half')
  assert.ok(messageKeysIn(indexSrc).length >= 10, 'no toast keys found')
  assert.ok(descriptors().length >= 15, 'the descriptor list looks empty')
  assert.ok(row, 'M23 has no row in docs/parity/modules.json')
})

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test('the Korean and English catalogs have exactly the same keys', () => {
  const ko = new Set(Object.keys(KO))
  const en = new Set(Object.keys(EN))
  const missingKo = [...en].filter((k) => !ko.has(k))
  const missingEn = [...ko].filter((k) => !en.has(k))
  assert.deepEqual(missingKo, [], 'keys with no Korean string')
  assert.deepEqual(missingEn, [], 'keys with no English string')
  assert.ok(ko.size >= 90, `only ${ko.size} strings — the catalog looks truncated`)
})

test('every catalog key is inside this module\'s namespace', () => {
  // §11: "keys must be namespaced" and registering outside your own id throws at
  // boot. A boot error is a better outcome than a silent one, but not as good as
  // never shipping it.
  for (const k of [...Object.keys(KO), ...Object.keys(EN)]) {
    assert.ok(k.startsWith('capture-encode.'), `'${k}' is outside the namespace`)
  }
})

test('no catalog string is empty or left as a placeholder', () => {
  for (const [lang, cat] of [
    ['ko', KO],
    ['en', EN]
  ] as const) {
    for (const [k, v] of Object.entries(cat)) {
      assert.ok(v.trim().length > 0, `${lang}:${k} is empty`)
      assert.equal(v.includes('TODO'), false, `${lang}:${k} is a placeholder`)
    }
  }
})

test('every key named by a descriptor, command, menu, toast or the renderer resolves', () => {
  const known = new Set(Object.keys(KO))
  const missing: string[] = []
  const check = (key: string, where: string): void => {
    if (!known.has(key)) missing.push(`${key} (${where})`)
  }

  for (const d of descriptors()) {
    check(d.labelKey, `descriptor ${d.id}`)
    if (d.descriptionKey) check(d.descriptionKey, `descriptor ${d.id} description`)
    if (d.type.kind === 'enum') {
      for (const o of d.type.options) check(o.labelKey, `option ${d.id}/${o.value}`)
    }
  }
  // The enum tables again from their source data, so a preset added to
  // CLIP_PRESETS without a label is caught even if the descriptor changes shape.
  for (const o of enumOptions(CLIP_PRESETS, 'preset')) check(o.labelKey, 'preset')
  for (const o of enumOptions(AUDIO_FORMATS, 'audio')) check(o.labelKey, 'audio format')
  for (const d of GIF_DITHERS) check(`capture-encode.dither.${d}`, 'dither')

  for (const k of keysIn(indexSrc)) check(k, 'index.ts')
  for (const k of messageKeysIn(indexSrc)) check(k, 'index.ts message')
  for (const k of keysIn(rendererSrc)) check(k, 'renderer half')
  // The renderer builds two families by template.
  for (const s of ['queued', 'running', 'done', 'failed', 'cancelled']) {
    check(`capture-encode.state.${s}`, 'panel state')
  }
  for (const k of [...rendererSrc.matchAll(/'(capture-encode\.limits\.[a-z]+)'/g)]) {
    check(k[1] as string, 'limits list')
  }
  // Every command's labelKey: a command with no label is an empty row in the
  // keybind editor, which `core/menu.ts` then drops from the menu entirely.
  for (const id of commandIds) check(id, `command ${id}`)

  assert.deepEqual(missing, [])
})

test('a Korean sentence that interpolates a filename uses the 조사 helper', () => {
  // §11: write `{name}{을/를}`, not `{name}를`, or a consonant-final name reads
  // as "파일를". Every KO string with a {name}/{label} placeholder followed by a
  // particle has to spell the particle as a pair.
  const bare = /\{(?:name|label)\}(을|를|이|가|은|는|으로|로|와|과)(?![/])/
  for (const [k, v] of Object.entries(KO)) {
    assert.equal(bare.test(v), false, `${k} hard-codes a particle: ${v}`)
  }
  // ...and at least one string really does use it, so this is not vacuous.
  assert.ok(
    Object.values(KO).some((v) => /\{name\}\{[^}]+\/[^}]+\}/.test(v)),
    'no KO string uses the 조사 helper at all — is the check looking at the right catalog?'
  )
})

// ---------------------------------------------------------------------------
// Settings descriptors
// ---------------------------------------------------------------------------

test('every descriptor is namespaced, in a fixed section, and ordered', () => {
  const SECTIONS = new Set([
    'general',
    'playback',
    'video',
    'audio',
    'subtitles',
    'keys',
    'filetypes',
    'advanced'
  ])
  const ids = new Set<string>()
  for (const d of descriptors()) {
    assert.ok(d.id.startsWith('capture-encode.'), `'${d.id}' is outside the namespace`)
    assert.equal(ids.has(d.id), false, `duplicate descriptor id '${d.id}'`)
    ids.add(d.id)
    assert.ok(SECTIONS.has(d.section), `'${d.id}' claims section '${d.section}'`)
    assert.equal(typeof d.order, 'number', `'${d.id}' has no order`)
    assert.notEqual(d.default, undefined, `'${d.id}' has no default`)
  }
})

test('a bounded numeric descriptor\'s default is inside its own bounds', () => {
  // An out-of-range default renders a slider pinned to one end and writes a
  // value the store then persists as a "difference from default" for ever.
  for (const d of descriptors()) {
    if (d.type.kind !== 'int' && d.type.kind !== 'float') continue
    const t = d.type as { min?: number; max?: number }
    if (typeof d.default !== 'number') continue
    if (t.min !== undefined) assert.ok(d.default >= t.min, `${d.id} default below min`)
    if (t.max !== undefined) assert.ok(d.default <= t.max, `${d.id} default above max`)
  }
})

test('an enum descriptor\'s default is one of its own options', () => {
  for (const d of descriptors()) {
    if (d.type.kind !== 'enum') continue
    const values = d.type.options.map((o) => o.value)
    assert.ok(values.includes(String(d.default)), `${d.id} defaults to '${String(d.default)}'`)
  }
})

test('the clip preset default is a SOFTWARE encoder', () => {
  // C19: "Treat every hardware preset as probe, then fall back to libx264, never
  // a default." A GPU default is a black screen on the machines it does not
  // initialise on, and the probe only runs because the default is safe.
  const d = descriptors().find((x) => x.id === 'capture-encode.clipPreset')
  assert.ok(d)
  const preset = CLIP_PRESETS.find((p) => p.id === String(d?.default))
  assert.ok(preset, 'the default names no preset')
  assert.equal(preset?.hardware, false)
})

test('maxConcurrent defaults to one job', () => {
  // C18: "Run one job at a time (max 2) or libx265/libsvtav1 saturates every
  // core and stutters playback."
  const d = descriptors().find((x) => x.id === 'capture-encode.maxConcurrent')
  assert.equal(d?.default, 1)
})

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test('the module declares exactly the manifest\'s properties and commands', () => {
  const declared = (field: string): string[] => {
    const m = new RegExp(`${field}: \\[([^\\]]*)\\]`).exec(indexSrc)
    assert.ok(m, `index.ts declares no ${field}`)
    return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort()
  }
  assert.deepEqual(declared('ownsProperties'), [...(row?.ownedProperties ?? [])].sort())
  assert.deepEqual(declared('ownsCommands'), [...(row?.ownedCommands ?? [])].sort())
  // The two that matter: `stream-record` is C17's only write, and the two
  // cache-dump commands are §2.1's "capture owns everything that writes media to
  // disk".
  assert.deepEqual(row?.ownedProperties, ['stream-record'])
  assert.deepEqual(row?.ownedCommands, ['ab-loop-dump-cache', 'dump-cache'])
})

test('the module writes no property it does not own', () => {
  // Reads are unrestricted (§3.7) and this module reads plenty — ab-loop-a/b are
  // M26's, sid/sub-delay/sub-scale are M19's and M20's, aid is M11's — but the
  // only WRITE is stream-record. An `ctx.mpv.set(` on anything else would be an
  // OwnershipError at runtime; catching it here costs nothing.
  const written = [...indexSrc.matchAll(/ctx\.mpv\.set\('([^']+)'/g)].map((m) => m[1] as string)
  assert.deepEqual([...new Set(written)], ['stream-record'])
  // ...and no raw mpv command outside the two it owns, plus dump-cache's stop
  // form, which is the same command.
  const commanded = [...indexSrc.matchAll(/ctx\.mpv\.command\(\[\s*'([^']+)'/g)].map(
    (m) => m[1] as string
  )
  assert.deepEqual([...new Set(commanded)].sort(), ['ab-loop-dump-cache', 'dump-cache'])
})

test('this module ships no S43 command, because ffmpeg is not bundled', () => {
  // §7.3 R-5 and the S43 row: extracting an embedded subtitle is the only
  // feature that would force an ~80 MB ffmpeg into a build whose entire unpacked
  // budget is 80 MB, and the answer is "we will not". The manifest lists S43
  // against M23, so the absence has to be deliberate and visible.
  assert.ok(row?.features.includes('S43'), 'the manifest no longer assigns S43 here')

  // Comments are STRIPPED first, and that is the whole trick. The doc comments
  // in this module say the word "ffmpeg" a dozen times on purpose — that is the
  // decision being recorded — so a naive substring search fails on the very
  // documentation it should be reading. Only executable text is scanned.
  const code = [indexSrc, rendererSrc]
    .map((s) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        // i18n keys are not command lines. `capture-encode.limits.ffmpeg` is the
        // key of the sentence that TELLS the user no ffmpeg is shipped, and it
        // is the one thing a substring search for 'ffmpeg' must not trip on.
        .replace(/'capture-encode\.[^']*'/g, "'<key>'")
    )
    .join('\n')
  assert.ok(code.length > 5_000, 'stripping comments removed the whole file')
  for (const bad of ['ffmpeg', 'extractSub', '-map 0:s', '-c:s']) {
    assert.equal(code.includes(bad), false, `executable code mentions '${bad}'`)
  }
  // The only binary this module runs is the mpv already shipped, and it runs it
  // through the tracked engine — never child_process, which is what "no orphan
  // mpv on quit" rests on and what the §15 checklist forbids outright.
  assert.equal(code.includes('child_process'), false)
  assert.equal(code.includes('mpvBinary'), false)
})

test('every command id is namespaced and unique', () => {
  const seen = new Set<string>()
  for (const id of commandIds) {
    assert.ok(id.startsWith('capture-encode.'), `'${id}' is outside the namespace`)
    assert.equal(seen.has(id), false, `duplicate command id '${id}'`)
    seen.add(id)
  }
})

test('the renderer half only asks for commands that exist', () => {
  // `capture-encode:start` refuses anything outside this namespace at runtime,
  // but a quick-action button naming a command that does not exist is a dead
  // button, and a dead button is not a runtime error anybody sees.
  const asked = [...rendererSrc.matchAll(/command: '(capture-encode\.[a-zA-Z]+)'/g)].map(
    (m) => m[1] as string
  )
  assert.ok(asked.length >= 4, `only ${asked.length} quick actions extracted`)
  for (const id of asked) assert.ok(commandIds.includes(id), `no such command '${id}'`)
})

test('the two halves live only in files this row owns', () => {
  const owned = row?.ownedFiles ?? []
  /**
   * THE TRIPWIRE FIRED, AND THIS IS WHAT IT ASKED FOR.
   *
   * This assertion used to be `deepEqual(owned, [main, renderer])` plus
   * "the row now owns a shared wire directory — move JobWire into it and delete
   * the copy", because §10's `src/shared/features/<id>/` was listed for only 3
   * of 40 rows and adding it was a manifest edit a module may not make. All 40
   * rows carry it now, `JobWire`/`JobsWire` live in
   * `src/shared/features/capture-encode/wire.ts`, and the duplicate is gone.
   *
   * The two copies had already drifted, which is the argument in one line: the
   * main half typed `kind` as `JobKind` and the renderer half as `string`, so
   * the renderer compiled happily against a value main can never send.
   */
  assert.deepEqual(owned, [
    'src/main/features/capture-encode/',
    'src/renderer/src/features/capture-encode/',
    'src/shared/features/capture-encode/'
  ])
  assert.equal(
    fs.existsSync(path.join(repo, 'src', 'shared', 'features', 'capture-encode', 'wire.ts')),
    true,
    'the row owns the shared wire directory; the payload types belong in it'
  )
  // And the shape is declared ONCE: no `interface JobWire` in either half.
  for (const half of [
    'src/main/features/capture-encode/index.ts',
    'src/renderer/src/features/capture-encode/index.ts'
  ]) {
    const src = fs.readFileSync(path.join(repo, half), 'utf8')
    assert.equal(
      /interface\s+Job(?:s)?Wire\b/.test(src),
      false,
      `${half} still declares its own copy of the wire type`
    )
  }
})
