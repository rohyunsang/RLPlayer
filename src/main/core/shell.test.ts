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
