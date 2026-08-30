import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mod from './index.ts'
import { CACHE_PRESETS, LOW_LATENCY_FOREIGN } from './cache-presets.ts'
import { MISSING_MEDIATORS, UNOWNED_PROPERTIES, forbiddenPropertyNames } from './spec-gaps.ts'

/**
 * The manifest, read rather than restated.
 *
 * §2 says `docs/parity/modules.json` is the owner map in machine-readable form
 * and that `npm test` compares it against the code in both directions. That
 * comparison is about `ownsProperties`; this file asks the narrower question the
 * comparison cannot: is every property name this module MENTIONS — in a preset,
 * in a descriptor's `mpvOption`, in the low-latency gap table — actually
 * writable by somebody?
 *
 * The answer for seven of them is no. Writing a table of gaps in a report would
 * rot; a test that reads the manifest cannot.
 *
 * This paragraph used to add "and it is no for EVERY module, because
 * `OwnerMap.assertWrite()` refuses a property whose owner is `null` exactly as
 * hard as one owned by a stranger", which was false and is deleted: the owner
 * map is built from CODE, so a module that lists a property in its own
 * `ownsProperties` is granted it (measured — see the header of `spec-gaps.ts`).
 * The barrier is the manifest and the code-vs-manifest cross-check in
 * `src/main/core/mpv/ownership.test.ts`, which is exactly what the tests below
 * assert against, so nothing in this FILE relied on the wrong sentence.
 */

interface Row {
  id: string
  path?: string
  ownedProperties?: string[]
  features?: string[]
}

/** Resolved from this file, so the suite does not depend on the cwd. */
const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docs',
  'parity',
  'modules.json'
)
const manifest: Row[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

/**
 * The manifest keys rows by `M15`; code — `dependsOn`, and the owner names in
 * `LOW_LATENCY_FOREIGN` — uses the DIRECTORY id. §1 of the module guide is
 * explicit that these are one namespace now, so the mapping belongs here rather
 * than in two hand-written lists.
 */
const dirOf = (r: Row): string =>
  /^src\/main\/features\/([a-z0-9-]+)\/$/.exec(r.path ?? '')?.[1] ?? r.id

const row = (idOrDir: string): Row => {
  const r = manifest.find((m) => m.id === idOrDir || dirOf(m) === idOrDir)
  assert.notEqual(r, undefined, `no ${idOrDir} row in modules.json`)
  return r as Row
}

/** Every claim in the manifest, glob-aware, exactly as the owner map folds it. */
const claims = manifest.flatMap((m) =>
  (m.ownedProperties ?? []).map((p) => ({ module: dirOf(m), pattern: p }))
)

function ownerOf(property: string): string | null {
  for (const c of claims) {
    if (c.pattern.endsWith('*')) {
      if (property.startsWith(c.pattern.slice(0, -1))) return c.module
    } else if (c.pattern === property) return c.module
  }
  return null
}

test('the manifest still says nobody owns the properties spec-gaps.ts names', () => {
  // If this fails, somebody CLOSED a gap — good — and this module should start
  // using the property instead of recording it.
  for (const gap of UNOWNED_PROPERTIES) {
    assert.equal(
      ownerOf(gap.property),
      null,
      `${gap.property} now has an owner (${String(ownerOf(gap.property))}); ` +
        `${gap.row} can be implemented — remove the row from spec-gaps.ts`
    )
  }
  assert.equal(UNOWNED_PROPERTIES.length, 7)
  assert.equal(MISSING_MEDIATORS.length > 0, true)
})

test('every property this module writes is one M35 owns in the manifest', () => {
  const mine = row('M35').ownedProperties ?? []
  const mineOwns = (p: string): boolean =>
    mine.some((c) => (c.endsWith('*') ? p.startsWith(c.slice(0, -1)) : c === p))

  // The presets are the biggest source of writes, and every one must be ours.
  for (const preset of CACHE_PRESETS) {
    for (const property of Object.keys(preset.apply)) {
      assert.equal(mineOwns(property), true, `preset '${preset.id}' writes ${property}`)
      assert.equal(ownerOf(property), 'stream-open', property)
    }
  }
})

test("the low-latency gap table names each property's REAL owner", () => {
  for (const f of LOW_LATENCY_FOREIGN) {
    assert.equal(
      ownerOf(f.property),
      f.owner === null ? null : dirOf(row(f.owner)),
      `${f.property}: table says ${String(f.owner)}, manifest says ${String(ownerOf(f.property))}`
    )
  }
})

test('M35 owns none of the gap properties, so the guard list is not redundant', () => {
  // `forbiddenPropertyNames()` backs a runtime refusal in index.ts. If one of
  // these were in fact ours, that refusal would block a legitimate write.
  const mine = row('M35').ownedProperties ?? []
  for (const p of forbiddenPropertyNames()) {
    assert.equal(mine.includes(p), false, p)
  }
})

test('the code and the manifest agree on what M35 owns', () => {
  // Cheap locally, and it is the check §2 says exists — asserted here for this
  // module so a property added in one place and not the other fails in the suite
  // the author is already running.
  const declared = [...(row('M35').ownedProperties ?? [])].sort()
  const inCode = [...(mod.ownsProperties ?? [])].sort()
  assert.deepEqual(inCode, declared)
  assert.equal(mod.id, 'stream-open')
  // §2.1: this module issues no mpv command that only it may issue, and saying
  // so explicitly is the difference between "declared none" and "forgot".
  assert.equal(mod.ownsCommands, undefined)
})
