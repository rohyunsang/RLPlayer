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
