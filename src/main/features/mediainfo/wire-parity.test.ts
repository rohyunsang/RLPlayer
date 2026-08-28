import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * THE SUBSTITUTE FOR A SHARED WIRE FILE, AND THE REASON ONE IS NEEDED.
 *
 * `docs/parity/02-wave0-api.md` section 10 gives every module a file both halves
 * compile -- `src/shared/features/<id>/` -- and says exactly why:
 *
 *   "`tsconfig.web.json` excludes `src/main` and `tsconfig.node.json` excludes
 *    `src/renderer`, so a type declared in one half and used in the other has to
 *    be written twice -- and nothing compares the two, so adding a field on one
 *    side is a silent `undefined` on the wire rather than a type error. Measured
 *    across the four pilots, FIVE wire types were hand-duplicated."
 *
 * M29's row in `docs/parity/modules.json` does not list that directory. It lists
 * two:
 *
 *   src/main/features/mediainfo/
 *   src/renderer/src/features/mediainfo/
 *
 * M12, M26 and M27 -- the three pilots that hit this -- each have the third
 * entry. `npm run check:partition` fails the build for any file under `src/` that
 * no row claims (untracked files included), so creating
 * `src/shared/features/mediainfo/` would break the build, and `modules.json` is
 * not this module's file to edit. This test is what stands in for the compiler
 * until the row gains its line, and it compares BYTES rather than shapes,
 * because comparing shapes would need the two files in one compilation unit --
 * which is precisely the thing that does not exist.
 *
 * When the manifest row is fixed: delete
 * `src/renderer/src/features/mediainfo/wire.ts`, move the main one to
 * `src/shared/features/mediainfo/wire.ts`, repoint both imports, and delete this
 * file.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const MAIN = path.join(repo, 'src', 'main', 'features', 'mediainfo', 'wire.ts')
const RENDERER = path.join(
  repo,
  'src',
  'renderer',
  'src',
  'features',
  'mediainfo',
  'wire.ts'
)

/** Everything from the first `export` on: the header differs on purpose. */
function body(file: string): string {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const at = text.indexOf('/** One `label: value` line.')
  assert.notEqual(at, -1, `${file} no longer starts its body with the InfoRow doc comment`)
  return text.slice(at)
}

test('the two wire files are byte-identical from the first declaration on', () => {
  const main = body(MAIN)
  const renderer = body(RENDERER)
  if (main !== renderer) {
    // A diff of the first differing line, because "they differ" is not
    // actionable at 100 lines.
    const a = main.split('\n')
    const b = renderer.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    assert.fail(
      `the two halves of M29's wire have diverged at body line ${i + 1}:\n` +
        `  main:     ${JSON.stringify(a[i])}\n` +
        `  renderer: ${JSON.stringify(b[i])}\n` +
        `This is the defect src/shared/features/<id>/ exists to make impossible; ` +
        `M29's manifest row does not list that directory (see this file's header).`
    )
  }
  assert.equal(main, renderer)
})

test('the comparison is not vacuous: it has real content on both sides', () => {
  // The guard the rest of this repo learned to add. `body()` returning '' on
  // both sides would satisfy the test above while comparing nothing, which is
  // exactly how the manifest dependency cross-check went green.
  const main = body(MAIN)
  assert.ok(main.length > 1500, `the wire body is only ${main.length} bytes`)
  for (const declaration of [
    'export interface InfoRow',
    'export interface InfoGroup',
    'export interface TrackRow',
    'export interface MediaInfoState',
    'export interface FileProperties',
    'export interface ProbeSummary',
    'export type InfoDensity',
    'export type InfoTab',
    'export type InfoGroupId'
  ]) {
    assert.ok(main.includes(declaration), `the wire no longer declares ${declaration}`)
  }
})

test('and it FAILS on a planted divergence, which is the only proof it works', () => {
  // Demonstrated rather than asserted-about: the body comparison is run against
  // a mutated copy, and the mutation must be detected. Without this the test
  // above is a check whose failure path has never executed.
  const main = body(MAIN)
  const mutated = main.replace('export interface MediaInfoState {\n', 'export interface MediaInfoState {\n  plantedField: string\n')
  assert.notEqual(mutated, main, 'the mutation did not apply; this self-check is inert')
  assert.notEqual(mutated, body(RENDERER))
})

test('neither wire file imports anything: it is types and values, no behaviour', () => {
  for (const file of [MAIN, RENDERER]) {
    const text = fs.readFileSync(file, 'utf8')
    // A wire file that imports `node:*` cannot be compiled by the web config,
    // and one that imports the DOM cannot be compiled by the node config. The
    // whole point of the file is that BOTH halves can read it.
    assert.equal(/^\s*import\s/m.test(text), false, `${file} has an import`)
    assert.equal(/from 'electron'/.test(text), false, `${file} imports electron`)
  }
})
