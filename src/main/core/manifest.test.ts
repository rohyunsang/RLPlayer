import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MANIFEST_CORE_IDS,
  MANIFEST_FEATURE_IDS,
  deferredDeps,
  topoSort
} from './registry-order.ts'

/**
 * `docs/parity/modules.json` is the machine-readable partition: who owns which
 * property, which command, which file. Thirty-eight modules are about to be
 * built in parallel on the strength of it, so it has to be internally
 * consistent, and it has to stay that way without anyone remembering to check.
 *
 * `scripts/check-partition.mjs` covers the file half against what is actually
 * on disk. This covers the manifest's own coherence, which is the half that
 * rots quietly: a `dependsOn` naming a module that was renamed, a
 * `mustNotTouch` still listing `src/main/player.ts` two waves after the Player
 * class was deleted, a module both owning a property and declaring it in
 * `requestsProperties`.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

interface Row {
  id: string
  path: string
  wave: number
  dependsOn: string[]
  ownedProperties: string[]
  ownedCommands: string[]
  requestsProperties: string[]
  arbitrates: string[]
  ownedFilterLabels: string[]
  mediates: Record<string, string[]>
  usesMediators: string[]
  ownedFiles: string[]
  features: string[]
  mustNotTouch: string[]
}

const modules: Row[] = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
)
const specText = fs.readFileSync(
  path.join(repo, 'docs', 'parity', '00-parity-spec.md'),
  'utf8'
)
const specLines = specText.split(String.fromCharCode(10)).map((l) => l.trimEnd())

/**
 * The feature id a spec table row is FOR, or null when the line is not one.
 *
 * The first cell is the id and nothing else -- `L30`, `**L47**`, `` `U06` `` --
 * so a cell carrying prose is a header, a different table, or a continuation.
 */
function featureIdOf(line: string): string | null {
  if (!line.startsWith('|')) return null
  const cells = line.split('|').map((c) => c.trim())
  if (cells.length < 8) return null
  return /^\**`?([A-Z]\d{2})`?\**$/.exec(cells[1] ?? '')?.[1] ?? null
}

test('the manifest is 55 rows with unique ids', () => {
  assert.equal(modules.length, 55)
  const ids = modules.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate module id')
})

test('every row carries every field the tooling reads', () => {
  for (const m of modules) {
    for (const field of [
      'dependsOn',
      'ownedProperties',
      'ownedCommands',
      'requestsProperties',
      'arbitrates',
      'usesMediators',
      'ownedFilterLabels',
      'ownedFiles',
      'features',
      'mustNotTouch'
    ] as const) {
      assert.ok(Array.isArray(m[field]), `${m.id} is missing '${field}'`)
    }
  }
})

test('every dependsOn names a module that exists', () => {
  /**
   * ONE NAMESPACE. `dependsOn` used to name manifest ROW ids (`M07`) while code
   * `dependsOn` names module DIRECTORIES (`video-decode`), so the two files
   * could not be compared and a module mirroring its own row failed to boot.
   * The manifest side moved: a feature dependency is spelled with the module
   * id, a core dependency with the core piece id, and both are exactly what
   * goes in the code.
   */
  const coreIds = new Set(modules.filter((m) => m.id.startsWith('core-')).map((m) => m.id))
  const moduleIds = new Set(featureRowDirs().values())
  for (const m of modules) {
    for (const dep of m.dependsOn) {
      assert.ok(
        coreIds.has(dep) || moduleIds.has(dep),
        `${m.id} depends on '${dep}', which is neither a core piece id nor a module id`
      )
      assert.ok(
        !/^[A-Z]\d{2}$/.test(dep),
        `${m.id} depends on '${dep}', a row id. dependsOn names module ids on both sides now.`
      )
    }
  }
})

test('the dependency graph is acyclic', () => {
  // Keyed by whatever `dependsOn` names: a core row by its id, a feature row by
  // its module id.
  const dirs = featureRowDirs()
  const byId = new Map(modules.map((m) => [dirs.get(m.id) ?? m.id, m]))
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return
    assert.ok(
      state.get(id) !== 'open',
      `dependency cycle: ${[...trail, id].join(' -> ')}`
    )
    state.set(id, 'open')
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id])
    state.set(id, 'done')
  }
  for (const m of modules) visit(dirs.get(m.id) ?? m.id, [])
})

test('no file is claimed by two rows', () => {
  const seen = new Map<string, string>()
  for (const m of modules) {
    for (const f of m.ownedFiles) {
      const other = seen.get(f)
      assert.ok(!other, `'${f}' is claimed by both '${other}' and '${m.id}'`)
      seen.set(f, m.id)
    }
  }
})

test('no property or command is claimed by two rows', () => {
  for (const field of ['ownedProperties', 'ownedCommands'] as const) {
    const seen = new Map<string, string>()
    for (const m of modules) {
      for (const p of m[field]) {
        const other = seen.get(p)
        assert.ok(!other, `${field}: '${p}' is claimed by both '${other}' and '${m.id}'`)
        seen.set(p, m.id)
      }
    }
  }
})

test('a module never both owns a property and requests it', () => {
  for (const m of modules) {
    for (const p of m.requestsProperties) {
      assert.ok(
        !m.ownedProperties.includes(p),
        `${m.id} owns '${p}' and also lists it in requestsProperties; pick one`
      )
    }
  }
})

test('every row carries the mediator table, even if it is empty', () => {
  for (const m of modules) {
    assert.equal(typeof m.mediates, 'object', `${m.id} is missing 'mediates'`)
    assert.ok(!Array.isArray(m.mediates), `${m.id}'s 'mediates' must be an object`)
  }
})

test('every requested property has an owner', () => {
  // A `requestsProperties` entry nobody owns means `requestSet` can never
  // succeed, and the module has no idea. That is a design gap, and it should be
  // visible here rather than at runtime months later.
  const owns = (p: string): string | undefined =>
    modules.find((m) =>
      m.ownedProperties.some((o) => (o.endsWith('*') ? p.startsWith(o.slice(0, -1)) : o === p))
    )?.id
  const commands = new Set(modules.flatMap((m) => m.ownedCommands))
  for (const m of modules) {
    for (const p of m.requestsProperties) {
      assert.ok(
        !commands.has(p),
        `${m.id} lists '${p}' in requestsProperties, but it is a COMMAND. ` +
          `requestSet cannot reach a command; call the owner's mediator.`
      )
      assert.ok(owns(p), `${m.id} requests '${p}', which no module owns`)
    }
  }
})

test('a module only arbitrates properties it owns', () => {
  for (const m of modules) {
    for (const p of m.arbitrates) {
      assert.ok(
        m.ownedProperties.includes(p),
        `${m.id} claims to arbitrate '${p}', which it does not own`
      )
    }
  }
})

test('every property another module requests has an arbiter or a mediator', () => {
  // The audit's finding: no module registered an arbiter anywhere in src/, so
  // every requestSet returned 'no-arbiter' -- while the OwnershipError told the
  // developer to use exactly that call. This is the manifest half of that fix.
  // If someone declares a dependency on your property, you owe them one of the
  // two sanctioned paths, and which one is a design decision worth writing
  // down: an arbiter for a value you police, a mediator for a change that is
  // really several writes at once (M11's `vid` and `aid` are one decision;
  // M02's fit mode also resets zoom and pan, which V23 requires).
  const arbiters = new Set(modules.flatMap((m) => m.arbitrates))
  const mediated = new Set(modules.flatMap((m) => Object.values(m.mediates).flat()))
  const missing: string[] = []
  for (const m of modules) {
    for (const p of m.requestsProperties) {
      if (!arbiters.has(p) && !mediated.has(p)) missing.push(`${p} (requested by ${m.id})`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `requested, but neither arbitrated nor covered by a mediator:\n  ${missing.join('\n  ')}`
  )
})

test('every mediator command belongs to the module that owns what it mediates', () => {
  for (const m of modules) {
    for (const [command, properties] of Object.entries(m.mediates)) {
      assert.ok(
        command.startsWith(`${m.path.replace(/^src\/main\/features\//, '').replace(/\/$/, '')}.`),
        `${m.id} lists mediator '${command}', which is outside its command namespace`
      )
      for (const p of properties) {
        const owns = m.ownedProperties.some((o) =>
          o.endsWith('*') ? p.startsWith(o.slice(0, -1)) : o === p
        )
        assert.ok(owns, `${m.id}'s mediator '${command}' covers '${p}', which it does not own`)
      }
    }
  }
})

test('a module that uses a mediator names one that exists', () => {
  const commands = new Set(modules.flatMap((m) => Object.keys(m.mediates)))
  for (const m of modules) {
    for (const c of m.usesMediators) {
      assert.ok(commands.has(c), `${m.id} uses mediator '${c}', which no module declares`)
    }
  }
})

test('mustNotTouch never names a file that no longer exists', () => {
  // `src/main/player.ts` was deleted when the Player class was retired in Wave
  // 0 and stayed in 38 mustNotTouch lists and one ownedFiles list, telling
  // every implementer not to edit a file they could not have found.
  for (const m of modules) {
    for (const entry of [...m.mustNotTouch, ...m.ownedFiles]) {
      if (!entry.startsWith('src/')) continue
      if (entry.includes('*') || entry.includes(' ')) continue
      const abs = path.join(repo, entry)
      const isFeatureReservation = /\/features\//.test(entry) && entry.endsWith('/')
      assert.ok(
        fs.existsSync(abs) || isFeatureReservation,
        `${m.id} names '${entry}', which does not exist`
      )
    }
  }
})

test('every implemented module directory has a manifest row', () => {
  const dirs = fs
    .readdirSync(path.join(repo, 'src', 'main', 'features'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  for (const dir of dirs) {
    assert.ok(
      modules.some((m) => m.path === `src/main/features/${dir}/`),
      `src/main/features/${dir}/ has no row in modules.json`
    )
  }
})

test('every renderer half belongs to the module of the same name', () => {
  const rendererDir = path.join(repo, 'src', 'renderer', 'src', 'features')
  if (!fs.existsSync(rendererDir)) return
  for (const d of fs.readdirSync(rendererDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const owner = modules.find((m) =>
      m.ownedFiles.includes(`src/renderer/src/features/${d.name}/`)
    )
    assert.ok(owner, `src/renderer/src/features/${d.name}/ is owned by nobody`)
    assert.equal(
      owner.path,
      `src/main/features/${d.name}/`,
      `the renderer half '${d.name}' is owned by ${owner.id}, whose main half is ${owner.path}`
    )
  }
})

// ---------------------------------------------------------------------------
// THE SPEC'S MODULE COLUMN, CROSS-CHECKED AGAINST THE MANIFEST.
// ---------------------------------------------------------------------------

/**
 * WHAT THIS WOULD HAVE CAUGHT. §2.6 line 601 gave L30 (playlist thumbnail view
 * mode) to M27, and M27's `features` array agreed -- while the files that row
 * describes editing, `src/renderer/src/features/playlist/` and the queue panel,
 * are M28's `ownedFiles`. So building L30 as written meant M27 editing M28's
 * directory: the exact collision `check:partition` exists to prevent, written
 * into the spec and mirrored into the manifest so the two agreed with each other
 * and both were wrong.
 *
 * Two documents that agree are not two sources of truth. The check that means
 * something is the one against the OWNERSHIP: a feature the spec assigns to a
 * module must be claimed by that module, and `check:partition` separately proves
 * that module owns the files it would have to edit.
 *
 * Twelve rows also turned out to be assigned in the spec and claimed by NOBODY
 * (A39, A46, S41, N34, N48, N49, L45, R21, R32, P25, P59, P62) -- unowned work
 * that would have surfaced as "whose is this?" in the middle of Wave 1.
 */
test('every feature the spec assigns to one module is claimed by that module', () => {
  const claimedBy = new Map<string, Set<string>>()
  for (const m of modules) {
    for (const f of m.features ?? []) {
      if (!claimedBy.has(f)) claimedBy.set(f, new Set())
      claimedBy.get(f)?.add(m.id)
    }
  }

  const problems: string[] = []
  let checked = 0
  for (const line of specText.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 8) continue
    // The first cell is the feature id and nothing else: `L30`, `**L47**`,
    // `` `U06` ``. A cell carrying prose is a header or a different table.
    const id = /^\**`?([A-Z]\d{2})`?\**$/.exec(cells[1] ?? '')?.[1]
    if (!id) continue
    // The Module column. Rows naming several modules ("**core/osd** + M31",
    // "M01-M09") are shared by design and are not a single-owner claim.
    const named = [...new Set([...(cells[6] ?? '').matchAll(/\bM(\d{2})\b/g)].map((m) => `M${m[1]}`))]
    if (named.length !== 1) continue
    checked++
    const owners = claimedBy.get(id)
    if (!owners) {
      problems.push(`${id}: the spec gives it to ${named[0]}; no row in modules.json claims it`)
    } else if (!owners.has(named[0] as string)) {
      problems.push(
        `${id}: the spec gives it to ${named[0]}; modules.json gives it to ${[...owners].join(', ')}`
      )
    }
  }

  assert.ok(checked > 300, `only ${checked} rows parsed; the extraction is broken, not the manifest`)
  assert.deepEqual(
    problems,
    [],
    `the spec and the manifest disagree about who builds what:\n  ${problems.join('\n  ')}\n` +
      `Fix whichever is wrong -- and check the winner actually OWNS the files that feature ` +
      `edits, because L30 was assigned to a module that did not.`
  )
})

/**
 * The half of the L30 bug the row-vs-row check above cannot see: the spec and
 * the manifest can AGREE with each other and still name a module that has no
 * right to the files. For L30 they did -- line 601 said M27 and M27's `features`
 * array said M27 -- so two documents agreeing proved nothing.
 *
 * LIMIT, stated plainly. This catches a row that spells out another module's
 * owned DIRECTORY, which is precise and has no false positives. It did NOT catch
 * L30, whose row said "playlist rows" in prose. Matching prose against directory
 * basenames was tried and produces 7 hits of which 4 are legitimate
 * cross-module design (R03 "Recent-URL history" is not M30's history; R27's
 * "playlist selection" is a Blu-ray playlist), so it would be noise people learn
 * to suppress. L30 was found by a human reading the row against `ownedFiles`,
 * and that is still the only thing that finds this class -- which is worth
 * knowing when the next Wave-1 row is written.
 */
test('a feature assigned to one module is not owned by a directory another module owns', () => {
  const dirOwner = new Map<string, string>()
  for (const m of modules) {
    for (const f of m.ownedFiles ?? []) if (f.endsWith('/')) dirOwner.set(f, m.id)
  }
  const problems: string[] = []
  for (const m of modules) {
    for (const f of m.features ?? []) {
      // A feature whose row names another module's DIRECTORY in its mpv-mapping
      // cell is being built in a place its owner may not touch.
      const line = specLines.find((l) => featureIdOf(l) === f)
      if (!line) continue
      for (const [dir, owner] of dirOwner) {
        if (owner === m.id || !dir.includes('/features/')) continue
        if (line.includes(dir)) {
          problems.push(`${f} is ${m.id}'s, but its row names ${dir} (${owner}'s)`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '))
})

/**
 * ---------------------------------------------------------------------------
 * `dependsOn` — the manifest's graph and the code's graph are ONE graph.
 *
 * Before this block the two were different namespaces with nothing comparing
 * them, and mirroring your own manifest row was a boot failure. See
 * MANIFEST_CORE_IDS in registry-order.ts for the whole argument.
 * ---------------------------------------------------------------------------
 */

/** Feature-row id (`M12`) -> module directory id (`audio-eq`). */
function featureRowDirs(): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of modules) {
    const hit = /^src\/main\/features\/([a-z0-9-]+)\/$/.exec(m.path ?? '')
    if (hit) out.set(m.id, hit[1] as string)
  }
  return out
}

/** The `dependsOn: [...]` array literal declared by a module's index.ts. */
function codeDependsOn(dir: string): string[] | null {
  const file = path.join(repo, 'src', 'main', 'features', dir, 'index.ts')
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, 'utf8')
  const hit = /\n\s*dependsOn:\s*\[([^\]]*)\]/.exec(src)
  if (!hit) return null
  return [...(hit[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

const implementedDirs = fs
  .readdirSync(path.join(repo, 'src', 'main', 'features'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => fs.existsSync(path.join(repo, 'src/main/features', d.name, 'index.ts')))
  .map((d) => d.name)

test('registry-order.ts knows exactly the core piece ids the manifest has', () => {
  const fromManifest = modules.filter((m) => m.id.startsWith('core-')).map((m) => m.id)
  assert.deepEqual(
    [...MANIFEST_CORE_IDS].sort(),
    [...fromManifest].sort(),
    'MANIFEST_CORE_IDS has drifted from docs/parity/modules.json'
  )
})

test('registry-order.ts knows exactly the feature module ids the manifest reserves', () => {
  const fromManifest = [...featureRowDirs().values()]
  assert.deepEqual(
    [...MANIFEST_FEATURE_IDS].sort(),
    [...fromManifest].sort(),
    'MANIFEST_FEATURE_IDS has drifted from docs/parity/modules.json'
  )
})

test('a module mirroring its manifest row VERBATIM sorts instead of failing to boot', () => {
  // This is the reported defect, in the two shapes the manifest actually
  // contains: a core piece, and a module that is reserved but not built.
  const rows = featureRowDirs()
  for (const m of modules) {
    const dir = rows.get(m.id)
    if (!dir) continue
    const mirrored = { dir, id: dir, dependsOn: m.dependsOn }
    assert.doesNotThrow(
      () => topoSort([mirrored]),
      `'${dir}' cannot declare its own manifest row: dependsOn ${JSON.stringify(m.dependsOn)}`
    )
  }
  // …and a name in no namespace is still a hard boot error, with the namespace
  // it reached into named.
  assert.throws(
    () => topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['M03'] }]),
    /is a docs\/parity\/modules\.json ROW id, not a module id/
  )
  assert.throws(
    () => topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['core-af-chian'] }]),
    /Did you mean 'core-af-chain'\?/
  )
})

test("every implemented module's code dependsOn matches its manifest row", () => {
  const rows = featureRowDirs()
  let compared = 0
  /**
   * AND THIS ASSERTION LIED ON ITS FIRST RUN, in the way this project keeps
   * finding. It was written while the manifest still spelled feature
   * dependencies as ROW ids, so it translated `M11 -> audio-tracks` through a
   * row-id map. Once the manifest moved to module ids the translation matched
   * NOTHING, every `wantedFeatures` came out empty, and the test went green
   * while five implemented modules declared none of the four dependencies their
   * rows record. `wantedCount` below is the guard: a comparison that compares
   * nothing is a failure, not a pass.
   */
  let wantedCount = 0

  for (const m of modules) {
    const dir = rows.get(m.id)
    if (!dir || !implementedDirs.includes(dir)) continue

    // Same namespace on both sides now: a feature dependency is a module id.
    const wantedFeatures = m.dependsOn.filter((d) => !d.startsWith('core-')).sort()
    wantedCount += wantedFeatures.length

    const declared = codeDependsOn(dir) ?? []
    const declaredFeatures = declared.filter((d) => !d.startsWith('core-')).sort()

    assert.deepEqual(
      declaredFeatures,
      wantedFeatures,
      `${m.id} (${dir}): modules.json says it depends on ${JSON.stringify(
        wantedFeatures
      )}; its index.ts declares ${JSON.stringify(declaredFeatures)}. ` +
        `These are the same graph — setup order comes from the code half, and the ` +
        `review reads the manifest half.`
    )

    // A core entry in code is optional documentation, but it must be spelled
    // right and it must be one the manifest row actually claims.
    for (const dep of declared.filter((d) => d.startsWith('core-'))) {
      assert.ok(
        MANIFEST_CORE_IDS.includes(dep),
        `${dir} dependsOn '${dep}', which is not a core piece id`
      )
      assert.ok(
        m.dependsOn.includes(dep),
        `${dir} dependsOn '${dep}' in code, but ${m.id}'s manifest row does not`
      )
    }
    compared++
  }
  assert.ok(compared >= 18, `expected to compare every implemented module, compared ${compared}`)
  assert.ok(
    wantedCount >= 5,
    `the manifest records feature dependencies for the implemented modules; this test ` +
      `found ${wantedCount}, so it is comparing nothing`
  )
})

test('deferredDeps names the reserved-but-unbuilt dependencies and nothing else', () => {
  const mods = [
    { dir: 'subs-tracks', id: 'subs-tracks', dependsOn: ['core-mpv-bus', 'subs-formats'] },
    { dir: 'subs-style', id: 'subs-style', dependsOn: ['subs-tracks'] }
  ]
  assert.deepEqual(deferredDeps(mods), [{ id: 'subs-tracks', dep: 'subs-formats' }])
})
