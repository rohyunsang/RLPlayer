import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * U47's THREE DENSITIES vs. `StatsSection.levels`, which is a contract member
 * whose non-default values nothing in shipped code can reach.
 *
 * WHAT WAS MEASURED. `StatsSection.levels?: ReadonlyArray<'full'|'short'|'misc'>`
 * is in `src/shared/renderer-api.ts`; `stats-host.ts` honours it
 * (`wanted(s) = !s.levels || s.levels.includes(level)`); `setStatsVisible(on,
 * which)` and `toggleStats(which)` both take a level. And:
 *
 *   $ grep -rn 'toggleStats(|setStatsVisible(' --include=*.ts src/ | grep -v test
 *   src/renderer/src/core/stats-host.ts:155   export function setStatsVisible(…)
 *   src/renderer/src/core/stats-host.ts:168   export function toggleStats(…)
 *   src/renderer/src/main.ts:593              if (name === 'toggleStats') toggleStats('full')
 *
 * Two definitions and ONE call, with a literal `'full'`. So a section declaring
 * `levels: ['misc']` is a section with no reachable home, and U47's
 * `Shift+Tab` / `Scroll Lock` densities cannot be built on the stats overlay by
 * any module: `RendererFeatureContext` has no method that opens it at a level,
 * and importing `core/stats-host` fails `check:forbidden`.
 *
 * THIS IS THE SAME SHAPE `seekbar-host.test.ts` already guards for its own
 * host -- "every method a module's contract depends on must have a caller in
 * shipped code" -- and that guard names five seek-bar methods and nothing about
 * the stats overlay, so it reports clean here. The general fix belongs in core
 * (either route a level through `ui:command`, or add a level argument to a
 * renderer-context method). What M29 can do from inside its own directory is
 * refuse to ship a section whose declared home does not exist, and render U47's
 * tiering on its own panel instead.
 *
 * This test is deliberately written so it FAILS if this module ever declares a
 * level the overlay cannot be put into, rather than passing and documenting the
 * gap in a comment nobody reads.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const src = path.join(repo, 'src')
const RENDERER_HALF = path.join(src, 'renderer', 'src', 'features', 'mediainfo', 'index.ts')

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) shippedFiles(full, out)
    else if (/\.ts$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * Which levels shipped code can actually put the stats overlay into.
 *
 * Read off the CALL SITES, not off the type: the type says three and the calls
 * say one, and the whole point of this file is that the difference is invisible
 * to every other check in the repo.
 */
function reachableLevels(): Set<string> {
  const levels = new Set<string>()
  const callRe = /\b(?:toggleStats|setStatsVisible)\s*\(([^)]*)\)/g
  for (const file of shippedFiles(src)) {
    const rel = path.relative(repo, file).split(path.sep).join('/')
    // The host's own definitions are not call sites. Counting a definition is
    // how "is anything calling this?" answers yes for code nothing calls.
    if (rel === 'src/renderer/src/core/stats-host.ts') continue
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(callRe)) {
      for (const q of (m[1] ?? '').matchAll(/'(full|short|misc)'/g)) levels.add(q[1] as string)
    }
  }
  return levels
}

/** `levels: ['full', 'misc']` -> ['full','misc'], for every section declared. */
function declaredLevels(): Array<{ id: string; levels: string[] }> {
  const text = fs.readFileSync(RENDERER_HALF, 'utf8')
  const out: Array<{ id: string; levels: string[] }> = []
  const sectionRe = /statsSection\(\{([\s\S]*?)\n {4}\}\)/g
  for (const m of text.matchAll(sectionRe)) {
    const block = m[1] ?? ''
    const id = /\bid:\s*'([^']+)'/.exec(block)?.[1] ?? '(unnamed)'
    const raw = /\blevels:\s*\[([^\]]*)\]/.exec(block)?.[1]
    const levels = raw === undefined ? [] : [...raw.matchAll(/'([a-z]+)'/g)].map((x) => x[1] as string)
    out.push({ id, levels })
  }
  return out
}

// ---------------------------------------------------------------------------

test("the only level shipped code can open the stats overlay at is 'full'", () => {
  const reachable = reachableLevels()
  // If this ever grows, the assertion below relaxes on its own and this module's
  // sections can claim the new level. That is the point of deriving it.
  assert.deepEqual(
    [...reachable].sort(),
    ['full'],
    "the set of reachable stats levels changed; if 'short'/'misc' are now routed " +
      'through, M29 can move its pipeline/frames/stream sections into the misc ' +
      'glance view as U47 asks'
  )
})

test('every stats section M29 declares claims a level that exists', () => {
  const reachable = reachableLevels()
  const declared = declaredLevels()
  // The guard: an extraction that found no sections would satisfy the loop
  // below trivially.
  assert.ok(declared.length >= 6, `found only ${declared.length} stats sections to check`)

  const unreachable: string[] = []
  for (const { id, levels } of declared) {
    assert.ok(
      levels.length > 0,
      `'${id}' declares no levels. stats-host.ts treats that as EVERY level, while ` +
        `U47 says the default is 'full' only ("so a new section never clutters the ` +
        `glance view"). Declare it, so the section agrees with the spec rather than ` +
        `with the host's fallback.`
    )
    for (const l of levels) {
      if (!reachable.has(l)) unreachable.push(`${id}: '${l}'`)
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    'these sections declare a stats-overlay level no shipped code can open, so the ' +
      'user can never see them there:\n  ' + unreachable.join('\n  ')
  )
})

test('and the extraction can see itself, in both directions', () => {
  // Planted call sites and a planted declaration, so neither half is a regex
  // that quietly stopped matching.
  const probe = "toggleStats('misc')\nsetStatsVisible(true, 'short')"
  const found = new Set<string>()
  for (const m of probe.matchAll(/\b(?:toggleStats|setStatsVisible)\s*\(([^)]*)\)/g)) {
    for (const q of (m[1] ?? '').matchAll(/'(full|short|misc)'/g)) found.add(q[1] as string)
  }
  assert.deepEqual([...found].sort(), ['misc', 'short'])

  const declared = declaredLevels()
  assert.ok(
    declared.every((d) => d.id.startsWith('mediainfo.')),
    `the section-block regex matched something that is not ours: ${JSON.stringify(declared)}`
  )
  assert.ok(declared.some((d) => d.id === 'mediainfo.pipeline'))
})

test("U47's short and misc densities are implemented on M29's OWN panel", () => {
  // The compensating implementation has to exist, or this module has quietly
  // dropped a P1 row and the test above is only guarding an absence.
  const renderer = fs.readFileSync(RENDERER_HALF, 'utf8')
  assert.match(renderer, /state\.density === 'short'/)
  assert.match(renderer, /state\.density === 'misc'/)
  const main = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')
  for (const id of ['mediainfo.showFull', 'mediainfo.showShort', 'mediainfo.showMisc']) {
    assert.ok(main.includes(`id: '${id}'`), `${id} is not registered`)
  }
})
