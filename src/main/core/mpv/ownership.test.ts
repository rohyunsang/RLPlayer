import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CORE_OWNERSHIP,
  OwnerMap,
  isChainCommand,
  propertyWrittenBy
} from './ownership.ts'

/**
 * test:property-ownership (§6.2).
 *
 * The acceptance criterion in §6.3 is exact: "boot a fixture where two modules
 * claim `aid`: the app FAILS TO START with both module names and the property
 * in the message. Then, at runtime, have M13 call set('aid', 2): rejected,
 * owner named, nothing written. Have it call requestSet instead: M11's arbiter
 * runs and the reply is propagated. Finally assert the boot map equals
 * docs/parity/modules.json in both directions."
 */

const noop = (): void => {}

test('two modules claiming one property is a boot error naming both', () => {
  assert.throws(
    () =>
      new OwnerMap([
        { id: 'audio-tracks', ownsProperties: ['aid', 'vid'] },
        { id: 'audio-devices', ownsProperties: ['audio-device', 'aid'] }
      ]),
    (e: Error) => {
      assert.match(e.message, /audio-tracks/)
      assert.match(e.message, /audio-devices/)
      assert.match(e.message, /'aid'/)
      return true
    }
  )
})

test('a glob that overlaps another claim is a boot error too', () => {
  assert.throws(
    () =>
      new OwnerMap([
        { id: 'capture-still', ownsProperties: ['screenshot-*'] },
        { id: 'video-hdr', ownsProperties: ['screenshot-format'] }
      ]),
    /screenshot-\*.*capture-still|capture-still.*screenshot-format/s
  )
})

test('a bare * and an interior * are rejected', () => {
  assert.throws(() => new OwnerMap([{ id: 'x', ownsProperties: ['*'] }]), /bare glob/)
  assert.throws(() => new OwnerMap([{ id: 'x', ownsProperties: ['sub-*-size'] }]), /TRAILING/)
})

test('set() on a property another module owns is refused, and names the owner', () => {
  const map = new OwnerMap([
    { id: 'audio-tracks', ownsProperties: ['aid', 'vid'] },
    { id: 'audio-loudness', ownsProperties: ['replaygain'], requestsProperties: ['aid'] }
  ])
  assert.equal(map.ownerOf('aid'), 'audio-tracks')
  assert.equal(map.owns('audio-loudness', 'aid'), false)

  assert.throws(
    () => map.assertWrite('audio-loudness', 'aid', true, noop),
    (e: Error) => {
      assert.match(e.message, /audio-loudness may not write 'aid'/)
      assert.match(e.message, /owned by audio-tracks/)
      assert.match(e.message, /requestSet/)
      return true
    }
  )
})

test('production drops and counts rather than throwing', () => {
  const map = new OwnerMap([{ id: 'audio-tracks', ownsProperties: ['aid'] }])
  const logged: string[] = []
  const ok = map.assertWrite('audio-loudness', 'aid', false, (m) => logged.push(m))
  assert.equal(ok, false, 'the write must still be refused')
  assert.equal(map.refusalCount('audio-loudness'), 1)
  assert.match(logged[0] ?? '', /owned by audio-tracks/)
})

test('an unowned property names nobody but is still refused', () => {
  const map = new OwnerMap([{ id: 'audio-tracks', ownsProperties: ['aid'] }])
  assert.equal(map.ownerOf('sub-delay'), null)
  assert.throws(() => map.assertWrite('subs-sync', 'sub-delay', true, noop), /no module owns it/)
})

test('globs match by prefix, longest first', () => {
  const map = new OwnerMap([
    { id: 'capture-still', ownsProperties: ['screenshot-*'] },
    { id: 'video-scaler', ownsProperties: ['scale', 'dscale'] }
  ])
  assert.equal(map.ownerOf('screenshot-directory'), 'capture-still')
  assert.equal(map.ownerOf('screenshot-webp-quality'), 'capture-still')
  assert.equal(map.ownerOf('scale'), 'video-scaler')
  assert.equal(map.ownerOf('screenshotless'), null)
})

test('requestsProperties gates the mediated path', () => {
  const map = new OwnerMap([
    { id: 'audio-tracks', ownsProperties: ['aid'] },
    { id: 'audio-devices', ownsProperties: ['audio-device'], requestsProperties: ['aid'] },
    { id: 'audio-eq', ownsProperties: [] }
  ])
  assert.equal(map.mayRequest('audio-devices', 'aid'), true)
  assert.equal(map.mayRequest('audio-eq', 'aid'), false)
})

test('property-writing commands are recognised, seeks are not', () => {
  assert.equal(propertyWrittenBy(['set_property', 'aid', 2]), 'aid')
  assert.equal(propertyWrittenBy(['cycle', 'sid']), 'sid')
  assert.equal(propertyWrittenBy(['add', 'chapter', 1]), 'chapter')
  assert.equal(propertyWrittenBy(['change-list', 'glsl-shaders', 'append', 'x']), 'glsl-shaders')
  assert.equal(propertyWrittenBy(['seek', 5, 'exact']), null)
  assert.equal(propertyWrittenBy(['loadfile', 'x.mkv', 'replace']), null)
})

test('raw vf/af commands are recognised so only the chains may issue them', () => {
  assert.equal(isChainCommand(['vf', 'set', '@x:lavfi=[cas]']), true)
  assert.equal(isChainCommand(['af-command', 'rleq', 'gain', '1', 'superequalizer']), true)
  assert.equal(isChainCommand(['seek', 1]), false)
})

// ---------------------------------------------------------------------------
// The boot map vs docs/parity/modules.json, in both directions.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')

interface ManifestModule {
  id: string
  path: string
  ownedProperties: string[]
}

function manifest(): ManifestModule[] {
  return JSON.parse(
    fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
  ) as ManifestModule[]
}

/** Declared properties, read out of the module source rather than imported —
 *  importing a module would drag Electron in. */
function declaredProperties(dir: string): string[] {
  const src = fs.readFileSync(path.join(repo, 'src', 'main', 'features', dir, 'index.ts'), 'utf8')
  const m = /ownsProperties:\s*\[([\s\S]*?)\]/.exec(src)
  if (!m) return []
  return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string)
}

function covers(declared: readonly string[], property: string): boolean {
  return declared.some((d) => (d.endsWith('*') ? property.startsWith(d.slice(0, -1)) : d === property))
}

test('every implemented module agrees with modules.json in both directions', () => {
  const man = manifest()
  const featuresDir = path.join(repo, 'src', 'main', 'features')
  const dirs = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  assert.ok(dirs.length > 0, 'no feature modules found')

  for (const dir of dirs) {
    const entry = man.find((m) => m.path === `src/main/features/${dir}/`)
    assert.ok(entry, `module '${dir}' has no entry in docs/parity/modules.json`)
    const declared = declaredProperties(dir)

    // manifest → code
    for (const p of entry.ownedProperties) {
      assert.ok(
        covers(declared, p),
        `${entry.id} (${dir}): modules.json lists '${p}' but the module does not declare it`
      )
    }
    // code → manifest
    for (const p of declared) {
      const listed: boolean = p.endsWith('*')
        ? entry.ownedProperties.some((x) => x === p || x.startsWith(p.slice(0, -1)))
        : entry.ownedProperties.includes(p)
      assert.ok(
        listed,
        `${entry.id} (${dir}): the module declares '${p}' but modules.json does not list it`
      )
    }
  }
})

test('the core pieces own the transport and the two filter properties', () => {
  const map = new OwnerMap(CORE_OWNERSHIP)
  assert.equal(map.ownerOf('pause'), 'core/mpv/bus')
  assert.equal(map.ownerOf('input-doubleclick-time'), 'core/mpv/bus')
  assert.equal(map.ownerOf('vf'), 'core/vf-chain')
  assert.equal(map.ownerOf('af'), 'core/af-chain')
})

test('no property is owned twice across core plus every implemented module', () => {
  const featuresDir = path.join(repo, 'src', 'main', 'features')
  const decls = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, ownsProperties: declaredProperties(d.name) }))
  // Constructing the map IS the assertion: it throws on any collision.
  const map = new OwnerMap([...CORE_OWNERSHIP, ...decls])
  assert.ok(map.entries().length > 100, 'expected a substantial owner map')
})
