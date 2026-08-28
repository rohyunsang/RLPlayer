#!/usr/bin/env node
/**
 * `npm run check:ordering` — the ordering partition, enforced.
 *
 * A duplicate `order` in any of the seven cross-module ordering namespaces is a
 * BOOT FAILURE: `claimSlot()` and `MenuRegistry.contribute()` throw a
 * ContributionError, the registry re-throws it rather than isolating it, and the
 * app does not start. It collided twice in one nine-module round, and the check
 * that was supposed to catch it — a regex with a 400-character window pairing
 * `id:` to `order:` — could not see two of M25's own contributions, because M25
 * had added a comment between the two keys to document the previous collision.
 *
 * So the partition moved into `docs/parity/modules.json`, exactly like
 * `ownedProperties` and `ownedFiles`: every ordered contribution is a declared
 * claim, and a second claimant is a MANIFEST CONFLICT this script names from the
 * manifest alone, without running anything. The code side is read with the
 * TypeScript AST (`scripts/lib/ordering.mjs`), so a comment cannot separate two
 * properties of one object literal and `order: MENU_ORDER` resolves to 60.
 *
 * Both directions, because one direction is half a check:
 *   - a code order that no row declares       -> fail, with the JSON to paste
 *   - a declared order that no code contributes -> fail, because a reserved slot
 *     nobody uses is how a partition rots while 25 modules queue up for one
 *
 * Usage:
 *   node scripts/check-ordering.mjs               check this tree
 *   node scripts/check-ordering.mjs --self-test   the rules against fixtures, then the tree
 *   node scripts/check-ordering.mjs --list        print the partition as read
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NAMESPACES,
  checkOrdering,
  readClaimsFromFile,
  readMenuRoots,
  scanRepoClaims,
  summarise
} from './lib/ordering.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const modules = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
)

// ---------------------------------------------------------------------------
// --self-test: the rules against the defects they were written for
// ---------------------------------------------------------------------------

/**
 * Fixtures are SOURCE TEXT, not claim objects, because every one of the three
 * ways the old check went blind was a reading failure rather than a rule
 * failure. A fixture made of pre-parsed claims would pass on all three.
 */
const SOURCES = {
  'the shape the old regex read correctly': `
    ctx.transportButton({ id: 'a.one', order: 10, labelKey: 'x' })
  `,
  'a comment between id: and order: — THE M25 BLINDING': `
    ctx.transportButton({
      id: 'a.one',
      /**
       * Eleven lines of comment documenting the previous collision, which is
       * exactly what M25 added and exactly what pushed 'order' past the
       * 400-character window the old regex allowed. A comment is not a
       * separator: this property and the one below are siblings in one object
       * literal, and the parser cannot be persuaded otherwise.
       */
      order: 10,
      labelKey: 'x'
    })
  `,
  'order: before id:': `
    ctx.transportButton({ order: 10, id: 'a.one', labelKey: 'x' })
  `,
  'order: a named constant, in this file': `
    const MENU_ORDER = 10
    ctx.transportButton({ id: 'a.one', order: MENU_ORDER, labelKey: 'x' })
  `
}

function selfTest() {
  const failures = []
  const note = (m) => failures.push(m)

  // 1. The reader sees the same claim in all four shapes.
  for (const [name, text] of Object.entries(SOURCES)) {
    const { claims, unresolved } = readClaimsFromFile(
      path.join(repo, 'src', 'renderer', 'src', 'features', 'fixture', 'index.ts'),
      text
    )
    if (unresolved.length > 0) note(`${name}: reader could not resolve: ${unresolved[0].why}`)
    if (claims.length !== 1) {
      note(`${name}: expected 1 claim, read ${claims.length}`)
      continue
    }
    const c = claims[0]
    if (c.ns !== 'transportButton' || c.id !== 'a.one' || c.order !== 10) {
      note(`${name}: read ${JSON.stringify(c)}`)
    }
  }

  /**
   * 1b. THE RETIRED REGEX, RUN ON THE REAL TREE.
   *
   * Not on a synthetic fixture — the point of the finding is that M25's actual
   * source defeated it. The four `ctx.transportButton` contributions in
   * `src/renderer/src/features/**` are all read by the AST; the regex reads
   * three, and the one it misses is `nav-chapters.skipPrompt`, whose `id:` and
   * `order:` are separated by the comment M25 wrote about the last collision.
   * If that ever stops being true this assertion says so rather than quietly
   * becoming decoration.
   */
  {
    const OLD = /ctx\.transportButton\(\{\s*\n?\s*id:\s*'([^']+)'[\s\S]{0,400}?order:\s*(\d+)/g
    const dir = path.join(repo, 'src', 'renderer', 'src', 'features')
    const seenByRegex = new Set()
    const seenByAst = new Set()
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, d.name, 'index.ts')
      if (!d.isDirectory() || !fs.existsSync(f)) continue
      const text = fs.readFileSync(f, 'utf8')
      OLD.lastIndex = 0
      for (let m = OLD.exec(text); m !== null; m = OLD.exec(text)) seenByRegex.add(m[1])
      for (const c of readClaimsFromFile(f, text).claims) {
        if (c.ns === 'transportButton') seenByAst.add(c.id)
      }
    }
    const missed = [...seenByAst].filter((id) => !seenByRegex.has(id))
    if (!missed.includes('nav-chapters.skipPrompt')) {
      note(
        `the retired regex is supposed to be measurably blind to ` +
          `'nav-chapters.skipPrompt'; the AST read ${seenByAst.size} transport buttons, the ` +
          `regex read ${seenByRegex.size}, missing: ${missed.join(', ') || '(none)'}`
      )
    }
  }

  // 2. An order that is not static is a reported failure, not a silent skip.
  {
    const { claims, unresolved } = readClaimsFromFile(
      path.join(repo, 'src', 'renderer', 'src', 'features', 'fixture', 'index.ts'),
      `ctx.transportButton({ id: 'a.one', order: base + 1, labelKey: 'x' })`
    )
    if (claims.length !== 0 || unresolved.length !== 1) {
      note('a computed order must be reported as unresolvable, not dropped')
    }
  }

  // 3. The collision rule fires from the MANIFEST ALONE.
  {
    const fixture = [
      {
        id: 'F1',
        path: 'src/main/features/aa/',
        ownedFiles: ['src/main/features/aa/'],
        ownedOrders: { transportButton: [{ id: 'aa.toggle', order: 50 }] }
      },
      {
        id: 'F2',
        path: 'src/main/features/bb/',
        ownedFiles: ['src/main/features/bb/'],
        ownedOrders: { transportButton: [{ id: 'bb.toggle', order: 50 }] }
      }
    ]
    const problems = checkOrdering({ modules: fixture, codeClaims: [], unresolved: [] })
    const hit = problems.find((p) => p.includes('ORDERING COLLISION'))
    if (!hit) note('two rows claiming transportButton 50 must be a collision from the manifest')
    if (hit && !(hit.includes('aa.toggle') && hit.includes('bb.toggle'))) {
      note('the collision message must name BOTH claimants: ' + hit)
    }
  }

  // 4. Scope narrows the namespace exactly where the runtime narrows it.
  {
    const rows = (scopeB) => [
      {
        id: 'F1',
        path: 'src/main/features/aa/',
        ownedFiles: ['src/main/features/aa/'],
        ownedOrders: { settingsSection: [{ id: 'aa.x', order: 6, scope: 'playback' }] }
      },
      {
        id: 'F2',
        path: 'src/main/features/bb/',
        ownedFiles: ['src/main/features/bb/'],
        ownedOrders: { settingsSection: [{ id: 'bb.x', order: 6, scope: scopeB }] }
      }
    ]
    const code = (scopeB) => [
      { ns: 'settingsSection', id: 'aa.x', order: 6, scope: 'playback', file: 'src/main/features/aa/index.ts', line: 1 },
      { ns: 'settingsSection', id: 'bb.x', order: 6, scope: scopeB, file: 'src/main/features/bb/index.ts', line: 1 }
    ]
    const apart = checkOrdering({ modules: rows('video'), codeClaims: code('video') })
    if (apart.length !== 0) {
      note('two settings sections in DIFFERENT pages may share an order: ' + apart.join(' | '))
    }
    const together = checkOrdering({ modules: rows('playback'), codeClaims: code('playback') })
    if (!together.some((p) => p.includes('COLLISION'))) {
      note('two settings sections in the SAME page may not share an order')
    }
  }

  // 5. A band namespace does NOT reject a tie — eight modules share 10.
  {
    const fixture = [
      {
        id: 'F1',
        path: 'src/main/features/aa/',
        ownedFiles: ['src/main/features/aa/'],
        ownedOrders: { spawnArgPriority: [{ order: 10 }] }
      },
      {
        id: 'F2',
        path: 'src/main/features/bb/',
        ownedFiles: ['src/main/features/bb/'],
        ownedOrders: { spawnArgPriority: [{ order: 10 }] }
      }
    ]
    const problems = checkOrdering({
      modules: fixture,
      codeClaims: [
        { ns: 'spawnArgPriority', id: null, order: 10, scope: '', file: 'src/main/features/aa/index.ts', line: 1 },
        { ns: 'spawnArgPriority', id: null, order: 10, scope: '', file: 'src/main/features/bb/index.ts', line: 1 }
      ]
    })
    if (problems.length !== 0) note('a spawn-arg BAND tie is legal: ' + problems.join(' | '))
  }

  // 6. BOTH directions, on the same fixture.
  {
    const row = {
      id: 'F1',
      path: 'src/main/features/aa/',
      ownedFiles: ['src/main/features/aa/'],
      ownedOrders: { panel: [{ id: 'aa', order: 10 }] }
    }
    const code = { ns: 'panel', id: 'aa', order: 10, scope: '', file: 'src/main/features/aa/index.ts', line: 1 }
    if (checkOrdering({ modules: [row], codeClaims: [code] }).length !== 0) {
      note('an agreeing pair must be clean')
    }
    if (
      !checkOrdering({ modules: [row], codeClaims: [] }).some((p) =>
        p.includes('no code contributes it')
      )
    ) {
      note('manifest -> code: a declared order with no contribution must fail')
    }
    if (
      !checkOrdering({ modules: [{ ...row, ownedOrders: {} }], codeClaims: [code] }).some((p) =>
        p.includes('NO row declares it')
      )
    ) {
      note('code -> manifest: an undeclared contribution must fail')
    }
    if (
      !checkOrdering({
        modules: [row],
        codeClaims: [{ ...code, order: 20 }]
      }).some((p) => p.includes('says 10'))
    ) {
      note('a code order that disagrees with the declared one must fail')
    }
  }

  // 7. A missing `ownedOrders` key is not the same as an empty one.
  {
    const problems = checkOrdering({
      modules: [{ id: 'F1', path: 'src/main/features/aa/', ownedFiles: [] }],
      codeClaims: []
    })
    if (!problems.some((p) => p.includes("has no 'ownedOrders' key"))) {
      note('a row with no ownedOrders key must be reported')
    }
  }

  // 8. The menu's one space: a section on a fixed root's order needs saying so.
  {
    const row = {
      id: 'F1',
      path: 'src/main/features/aa/',
      ownedFiles: ['src/main/features/aa/'],
      ownedOrders: { menuSection: [{ id: 'aa.menu', order: 60 }] }
    }
    const code = { ns: 'menuSection', id: 'aa.menu', order: 60, scope: '', file: 'src/main/features/aa/index.ts', line: 1 }
    const roots = [{ path: 'capture', order: 60 }]
    if (
      !checkOrdering({ modules: [row], codeClaims: [code], menuRoots: roots }).some((p) =>
        p.includes('fixed menu ROOT')
      )
    ) {
      note('a menu section sharing a fixed root order must be declared')
    }
    row.ownedOrders.menuSection[0].tiesRoot = 'capture'
    if (checkOrdering({ modules: [row], codeClaims: [code], menuRoots: roots }).length !== 0) {
      note('an acknowledged root tie must be clean')
    }
    row.ownedOrders.menuSection[0].order = 61
    const stale = checkOrdering({
      modules: [row],
      codeClaims: [{ ...code, order: 61 }],
      menuRoots: roots
    })
    if (!stale.some((p) => p.includes('stale acknowledgement'))) {
      note('a tiesRoot that no longer ties anything must be reported')
    }
  }

  // 9. A claim outside the row's own id namespace.
  {
    const problems = checkOrdering({
      modules: [
        {
          id: 'F1',
          path: 'src/main/features/aa/',
          ownedFiles: ['src/main/features/aa/'],
          ownedOrders: { panel: [{ id: 'bb.panel', order: 10 }] }
        }
      ],
      codeClaims: []
    })
    if (!problems.some((p) => p.includes('outside its own namespace'))) {
      note('a claim id outside the row namespace must be reported')
    }
  }

  if (failures.length > 0) {
    console.error('check:ordering SELF-TEST FAILED:\n')
    for (const f of failures) console.error('  - ' + f + '\n')
    process.exit(1)
  }
  console.log(
    'check:ordering: self-test passed (%d source shapes, %d rule fixtures, %d namespaces)',
    Object.keys(SOURCES).length,
    9,
    NAMESPACES.length
  )
}

// ---------------------------------------------------------------------------

if (argv.includes('--self-test')) selfTest()

const { claims, unresolved, fileCount } = scanRepoClaims(repo)
const menuRoots = readMenuRoots(repo)

if (argv.includes('--list')) {
  for (const spec of NAMESPACES) {
    console.log(`\n${spec.ns}  (${spec.unique ? 'slot' : 'BAND'}) — ${spec.what}`)
    for (const c of claims
      .filter((c) => c.ns === spec.ns)
      .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)))) {
      console.log(
        `   ${String(c.order).padStart(4)}  ${(c.id ?? '(band)').padEnd(30)} ${c.scope || ''}  ${c.file}:${c.line}`
      )
    }
  }
  process.exit(0)
}

const problems = checkOrdering({ modules, codeClaims: claims, unresolved, menuRoots })

console.log(
  'check:ordering: %d file(s) parsed, %d claim(s) in %d namespace(s), %d fixed menu root(s)',
  fileCount,
  claims.length,
  NAMESPACES.length,
  menuRoots.length
)
for (const line of summarise(claims)) console.log('  ' + line)

if (problems.length > 0) {
  console.error('\ncheck:ordering found %d problem(s):\n', problems.length)
  for (const p of problems) console.error('  ' + p + '\n')
  console.error(
    '  A duplicate `order` is not a layout preference. It throws out of the contribution host,\n' +
      '  the registry re-throws a ContributionError, and the packaged app does not start — which\n' +
      '  is why the partition belongs in the manifest next to ownedProperties, where a second\n' +
      '  claimant is caught by reading one file.\n'
  )
  process.exit(1)
}

console.log('check:ordering: clean')
