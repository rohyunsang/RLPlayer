import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `core/shell.ts` imports Electron, so it cannot be imported here — the same
 * wall that made M22's and M23's `index.ts` untestable, which is exactly why the
 * file exists. What IS testable without Electron is the contract: that the
 * promised surface and the implemented one are the same shape, and that the
 * modules stopped importing Electron.
 *
 * That first check is not hypothetical bookkeeping. `ctx.paths.artCacheDir()`
 * was promised by `02-wave0-api.md` §12, existed in `core/paths.ts`, and was in
 * NEITHER the `PathService` interface nor the `pathService` object — so every
 * module that followed the guide would have crashed on "artCacheDir is not a
 * function", and the gap survived because nothing compared the promised surface
 * against the implemented one.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8')

/** Method names declared between `interface X {` and its closing brace. */
function methodsOf(source: string, iface: string): string[] {
  const start = source.indexOf(`export interface ${iface} {`)
  assert.notEqual(start, -1, `no interface ${iface}`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) break
  }
  const body = source.slice(from + 1, i)
  // Blank comments, then take every `name(` and `readonly name` at depth 0.
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const names = new Set<string>()
  for (const m of bare.matchAll(/^\s*(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)\s*[(:]/gm)) {
    names.add(m[1] as string)
  }
  return [...names].sort()
}

test('every method ShellService promises is implemented in core/shell.ts', () => {
  const api = read('src/shared/feature-api.ts')
  const impl = read('src/main/core/shell.ts')
  const promised = methodsOf(api, 'ShellService')
  assert.deepEqual(promised, [
    'appPath',
    'copyImagePng',
    'copyText',
    'openPath',
    'showItemInFolder',
    'trashItem'
  ])
  for (const name of promised) {
    assert.match(
      impl,
      new RegExp(`\\b(?:async\\s+)?${name}\\s*\\(`),
      `ShellService promises '${name}' and core/shell.ts does not implement it`
    )
  }
})

test('every method ImageService and DecodedImage promise is implemented', () => {
  const api = read('src/shared/feature-api.ts')
  const impl = read('src/main/core/shell.ts')
  assert.deepEqual(methodsOf(api, 'ImageService'), ['encodableFormats', 'read'])
  assert.deepEqual(methodsOf(api, 'DecodedImage'), ['height', 'resize', 'toJpeg', 'toPng', 'width'])
  for (const name of ['read', 'resize', 'toPng', 'toJpeg']) {
    assert.match(impl, new RegExp(`\\b${name}\\s*\\(`), `DecodedImage promises '${name}'`)
  }
})

test('the registry mints both services for every module', () => {
  const registry = read('src/main/core/registry.ts')
  assert.match(registry, /shell:\s*createShellService\(id\)/)
  assert.match(registry, /image:\s*createImageService\(\)/)
})

/**
 * C03, and why `copyImagePng` exists rather than the row's own prescription.
 *
 * §2.4 C03 said `clipboard.writeImage(nativeImage.createFromPath(tmp))`.
 * Verified against the RUNNING Electron 44, not its typings:
 *
 *   Object.getOwnPropertyNames(Object.getPrototypeOf(clipboard))
 *     -> clear, has, read, readText, write, writeText  (+ selection)
 *   typeof clipboard.writeImage -> 'undefined'
 *
 * So the row was a runtime `writeImage is not a function`, past typecheck and
 * past any test that mocks Electron. The row is corrected in the spec; this
 * asserts core does not follow the old one, because a spec fix that nothing
 * enforces comes back.
 */
test('nothing in the tree calls the clipboard method Electron 44 does not have', () => {
  for (const rel of ['src/main/core/shell.ts', 'src/main/features/capture-still/index.ts']) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    assert.equal(/clipboard\.(?:writeImage|readImage)/.test(src), false, rel)
  }
  /**
   * THE MAPPING CELL, not the whole row — and the distinction is one this test
   * got wrong on its first run, which is the point of writing it down.
   *
   * The corrected row explains the correction, so it QUOTES
   * `clipboard.writeImage(nativeImage.createFromPath(tmpPng))` in its notes on
   * purpose: a module author has to be able to see what the row used to say and
   * why it was wrong. A test that greps the whole line cannot tell a
   * prescription from a post-mortem about one, and would force the fix to
   * delete its own reasoning. §2's tables put the mpv/Electron mapping in cell 7
   * and the prose in cell 8; only cell 7 is a prescription.
   */
  const spec = read('docs/parity/00-parity-spec.md')
  const c03 = spec.split('\n').find((l) => l.startsWith('| C03 '))
  assert.ok(c03, 'no C03 row in the spec')
  const cells = c03.split('|').map((c) => c.trim())
  const mapping = cells[7] ?? ''
  assert.ok(mapping.includes('screenshot-to-file'), `C03 mapping cell moved: ${mapping}`)
  assert.equal(
    /clipboard\.(?:writeImage|readImage)/.test(mapping),
    false,
    'the C03 row still PRESCRIBES clipboard.writeImage, which Electron 44 does not have'
  )
  assert.match(
    cells[8] ?? '',
    /CORRECTED/,
    'the C03 note must say the old prescription was wrong, or the next reader repeats it'
  )
})

/**
 * THE CLIPBOARD TOAST WAS NOT EVIDENCE.
 *
 * Measured with the pinned Electron 44 on a box that denies clipboard access
 * (`clip.exe` answers "Access denied", `GetClipboardSequenceNumber` frozen at
 * 1359 across writes), running the real code path:
 *
 *     clipboard.writeText('RLPLAYER-PROBE-…')  -> RESOLVED
 *     clipboard.readText()                     -> ""
 *     clipboard.write([ClipboardItem png])     -> RESOLVED
 *     clipboard.has('image/png')               -> false
 *     clipboard.read()                         -> [ { types: [] } ]
 *
 * and the app showed "클립보드에 복사했습니다". A resolved promise is evidence
 * that the call returned, not that anything reached the clipboard. Both paths
 * read it back now, and these assertions exist because the readback is the ONLY
 * thing standing between a denied write and a success toast — deleting it would
 * leave every test passing.
 */
test('copyText reads the clipboard back before it claims success', () => {
  const src = read('src/main/core/shell.ts')
  const body = src.slice(src.indexOf('async copyText'), src.indexOf('async copyImagePng'))
  assert.match(body, /clipboard\.readText\(\)/, 'copyText must read the clipboard back')
  assert.match(body, /back !== text/, 'copyText must compare what came back with what went in')
  assert.match(body, /throw new Error/, 'a write that did not land must reject, not resolve')
})

test('copyImagePng asks TWO independent questions, because Electron 44 has no readImage', () => {
  const src = read('src/main/core/shell.ts')
  assert.match(src, /clipboard\.has\('image\/png'\)/)
  assert.match(src, /clipboard\.read\(\)/)
  const body = src.slice(src.indexOf('async copyImagePng'))
  assert.match(body, /clipboardHasPng\(\)/, 'copyImagePng must verify before resolving')
  assert.match(body, /throw new Error/)
})

test('the C03 caller shows a CLIPBOARD failure, not a generic capture failure', () => {
  const src = read('src/main/features/capture-still/index.ts')
  assert.match(src, /capture-still\.clipboardFailed/)
  const manifest = read('src/main/features/capture-still/manifest.ts')
  // Both catalogs, or the Korean user gets a raw key at the moment it fails.
  assert.equal(
    (manifest.match(/'capture-still\.clipboardFailed'/g) ?? []).length,
    2,
    'the clipboard failure message must exist in ko AND en'
  )
})

/**
 * The four §2 rows that name `clipboard.writeText` and read as synchronous.
 *
 * C03's note has said since last round that `clipboard.writeText` is a Promise
 * in Electron 44 and that S39, L25, L26 and L34 all get it wrong — and all four
 * rows still PRESCRIBED it, in the mapping cell a module author copies from.
 * ~25 modules are about to be written from these tables; a correction that
 * lives only in a neighbouring row's prose is a correction nobody applies.
 */
test('no §2 row prescribes the synchronous clipboard call', () => {
  const spec = read('docs/parity/00-parity-spec.md')
  const offenders: string[] = []
  for (const line of spec.split('\n')) {
    if (!/^\|\s*[A-Z]\d+\s*\|/.test(line)) continue
    const cells = line.split('|').map((c) => c.trim())
    const id = cells[1] ?? ''
    const mapping = cells[7] ?? ''
    if (/clipboard\.(?:writeText|writeImage|readImage)/.test(mapping)) offenders.push(id)
  }
  assert.deepEqual(
    offenders,
    [],
    `these rows still prescribe Electron's clipboard directly instead of ctx.shell.copyText, ` +
      `which is async AND verifies: ${offenders.join(', ')}`
  )
})

/**
 * The point of the whole exercise, asserted on the tree rather than described:
 * a feature module's `index.ts` is loadable.
 */
test('no feature module imports electron', () => {
  const roots = ['src/main/features', 'src/renderer/src/features']
  let scanned = 0
  for (const root of roots) {
    const base = path.join(repo, root)
    if (!fs.existsSync(base)) continue
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(full)
          continue
        }
        if (!e.name.endsWith('.ts')) continue
        const src = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
        // A regex literal that quotes the specifier is not an import; this is
        // the false positive `check:forbidden`'s version of this rule produced.
        const stripped = src.replace(/\/(?![*/])(?:\\.|\[[^\]]*\]|[^\\/\n])+\/[dgimsuvy]*/g, ' ')
        assert.equal(
          /(?:from|import|require)\s*\(?\s*['"]electron['"]/.test(stripped),
          false,
          `${path.relative(repo, full)} imports electron; use ctx.shell / ctx.image / ` +
            `ctx.dialog / ctx.window`
        )
        scanned++
      }
    }
    walk(base)
  }
  assert.ok(scanned > 50, `only ${scanned} feature files scanned`)
})
