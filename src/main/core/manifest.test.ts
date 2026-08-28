import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const ids = new Set(modules.map((m) => m.id))
  for (const m of modules) {
    for (const dep of m.dependsOn) {
      assert.ok(ids.has(dep), `${m.id} depends on '${dep}', which is not in the manifest`)
    }
  }
})

test('the dependency graph is acyclic', () => {
  const byId = new Map(modules.map((m) => [m.id, m]))
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
  for (const m of modules) visit(m.id, [])
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
