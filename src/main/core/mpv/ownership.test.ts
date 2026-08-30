import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CORE_OWNERSHIP,
  isBannedCommand,
  propertiesNeedingOwnership,
  propertiesWrittenBy,
  OwnerMap,
  isChainCommand,
  propertyWrittenBy
} from './ownership.ts'
import { VF_ORDER, AF_ORDER } from './chain.ts'
import {
  moduleDirs,
  readModuleDeclaration,
  type ModuleDeclaration
} from '../../../../scripts/lib/module-decl.mjs'

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

test('property-writing commands are recognised, by name AND by side effect', () => {
  assert.equal(propertyWrittenBy(['set_property', 'aid', 2]), 'aid')
  assert.equal(propertyWrittenBy(['cycle', 'sid']), 'sid')
  assert.equal(propertyWrittenBy(['add', 'chapter', 1]), 'chapter')
  assert.equal(propertyWrittenBy(['change-list', 'glsl-shaders', 'append', 'x']), 'glsl-shaders')
  assert.equal(propertyWrittenBy(['loadfile', 'x.mkv', 'replace']), null)
})

/**
 * THIS TEST IS THE ONE THAT WAS MISSING, and its previous shape actively
 * asserted the bug: it said `propertyWrittenBy(['seek', 5, 'exact'])` must be
 * `null`, i.e. that a seek writes nothing. Running as an unrelated module,
 * `['frame-step']` and `['frame-back-step']` therefore flipped core-owned
 * `pause` (measured false -> true), `['ab-loop']` set M26's `ab-loop-a`
 * ("no" -> 2.466667) and `['apply-profile','fast']` rewrote M06's `scale`
 * (lanczos -> bilinear). No throw, no refusal counted, nothing logged.
 */
test('commands that write a property WITHOUT naming it are caught', () => {
  assert.deepEqual(propertiesWrittenBy(['frame-step']), ['pause', 'time-pos'])
  assert.deepEqual(propertiesWrittenBy(['frame-back-step']), ['pause', 'time-pos'])
  assert.deepEqual(propertiesWrittenBy(['ab-loop']), ['ab-loop-a', 'ab-loop-b'])
  assert.deepEqual(propertiesWrittenBy(['seek', 5, 'exact']), ['time-pos'])
  assert.deepEqual(propertiesWrittenBy(['sub-seek', 1]), ['time-pos'])
  assert.deepEqual(propertiesWrittenBy(['ao-reload']), ['audio-device'])
  // The prefix forms have to reach the table too, or the guard is one word away
  // from being bypassed.
  assert.deepEqual(propertiesWrittenBy(['no-osd', 'frame-step']), ['pause', 'time-pos'])
  assert.deepEqual(propertiesWrittenBy(['async', 'no-osd', 'ab-loop']), ['ab-loop-a', 'ab-loop-b'])
  // Underscore spelling, which mpv accepts.
  assert.deepEqual(propertiesWrittenBy(['frame_step']), ['pause', 'time-pos'])
})

/**
 * THE REGRESSION THIS TEST EXISTS FOR, and it is a regression the FIX
 * introduced.
 *
 * Giving `seek` an owner immediately broke seeking: `['seek', 200,
 * 'absolute+exact']` implies a write to `time-pos`, which nobody owns, so M24 —
 * the module that owns seeking — was refused its own command. In a packaged
 * build a refusal is DROPPED, and M28's four seek call sites all had
 * `.catch(() => undefined)` on them, so resume simply stopped working and
 * nothing said a word. It was caught by driving the packaged app and finding
 * resume.json empty, not by any test that existed.
 */
test('a command owner may cause the side effects its command implies', () => {
  // Not owning it: the implied write is checked, and refused.
  assert.deepEqual(propertiesNeedingOwnership(['frame-step'], false), ['pause', 'time-pos'])
  assert.deepEqual(propertiesNeedingOwnership(['seek', 200, 'absolute+exact'], false), ['time-pos'])
  // Owning it: the decision was already made in modules.json, so the implied
  // set is not re-litigated at a call site whose only answer is "drop silently".
  assert.deepEqual(propertiesNeedingOwnership(['frame-step'], true), [])
  assert.deepEqual(propertiesNeedingOwnership(['seek', 200, 'absolute+exact'], true), [])
})

test('owning a command never means owning the properties it NAMES', () => {
  // `loadfile` is M28's, and `['loadfile', f, 'replace', 0, 'speed=2.5']` was
  // measured to really set speed to 2.5. If ownership of the command exempted
  // the options map, M28 would own every property in the app through it.
  const withOptions = ['loadfile', 'x.mkv', 'replace', 0, 'speed=2.5,sub-delay=1']
  assert.deepEqual(propertiesNeedingOwnership(withOptions, true), ['speed', 'sub-delay'])
  assert.deepEqual(propertiesNeedingOwnership(['set', 'aid', 2], true), ['aid'])
  assert.deepEqual(propertiesNeedingOwnership(['no-osd', 'set', 'speed', 2], true), ['speed'])
})

test('apply-profile is banned outright: its side effects are unbounded', () => {
  // Measured: ['apply-profile','fast'] rewrote `scale` lanczos -> bilinear from
  // a module that owns nothing. There is no way to police the set of properties
  // a profile touches, so nobody may issue it.
  assert.equal(isBannedCommand(['apply-profile', 'fast']), true)
  assert.equal(isBannedCommand(['no-osd', 'apply-profile', 'fast']), true)
  assert.equal(isBannedCommand(['screenshot-raw']), true)
})

test('a command that writes a property is refused when the module owns neither', () => {
  const map = new OwnerMap([
    ...CORE_OWNERSHIP,
    { id: 'nav-seek', ownsCommands: ['seek', 'frame-step', 'frame-back-step', 'revert-seek'] },
    { id: 'nav-chapters', ownsProperties: ['chapter'] }
  ])
  const refused: string[] = []
  // M25 seeks "through M24's command"; issuing it itself is refused by name.
  assert.equal(
    map.assertCommand('nav-chapters', 'frame-step', false, (m) => refused.push(m)),
    false
  )
  assert.match(refused.join(''), /nav-seek/)
  // And the side effect is caught even for a module M24 would allow the command
  // to: `pause` is core's, so M24 has to mediate rather than write it.
  assert.equal(
    map.assertWrite('nav-seek', 'pause', false, () => {}),
    false
  )
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
  ownedCommands: string[]
  ownedFilterLabels?: string[]
  requestsProperties?: string[]
}

function manifest(): ManifestModule[] {
  return JSON.parse(
    fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
  ) as ManifestModule[]
}

/**
 * Declared names, read out of the module source rather than imported -- an
 * import would drag Electron in.
 *
 * IT USED TO BE A REGEX, AND IT WAS BLIND THREE WAYS. The old helper stripped
 * comments from the whole file first (a real fix for a real defect: a doc
 * comment quoting `ownsCommands: []` matched first and the test believed it) and
 * then did
 *
 *     new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`).exec(src)
 *
 * over `<dir>/index.ts`. That reports AGREEMENT it never checked whenever:
 *
 *   1. the array is not all literals. `ownsProperties: [...forbiddenPropertyNames(),
 *      'cache']` captures only the quoted names, so a module can claim any
 *      number of properties the manifest never sees and BOTH directions pass.
 *      Verified by planting exactly that on M35: 1144 tests, 0 failures, while
 *      `OwnerMap` -- which is built from CODE, `registry.ts:126` -- hands the
 *      module write access to every one of them;
 *   2. there is no array. `ownsProperties: KNOWN` matches nothing, `exec`
 *      returns null, the helper returns `[]`, and for a row whose manifest list
 *      is also empty both directions pass vacuously;
 *   3. the module object is not in `index.ts`. M22 and M23 already split a
 *      `manifest.ts` out because their `index.ts` imports `electron` and is
 *      therefore unloadable by any test.
 *
 * `scripts/lib/module-decl.mjs` parses instead, resolves the DEFAULT EXPORT
 * wherever it lives, and reports a declaration it cannot read statically rather
 * than returning an empty list -- which is the only honest answer, and is
 * asserted below.
 */
const declFor = (dir: string): ModuleDeclaration | null =>
  readModuleDeclaration(path.join(repo, 'src', 'main', 'features', dir))

const declaredField = (dir: string, field: string): string[] => [
  ...(declFor(dir)?.fields[field] ?? [])
]

const declaredProperties = (dir: string): string[] => declaredField(dir, 'ownsProperties')
const declaredCommands = (dir: string): string[] => declaredField(dir, 'ownsCommands')
const declaredLabels = (dir: string): string[] => declaredField(dir, 'ownsFilterLabels')

/**
 * A declaration this reader cannot read is a failure of the reader, not an
 * absence. Without this, closing hole 1 and hole 2 above would only move them:
 * a spread would become "the field is missing" instead of "the field is short".
 */
test('every module declaration is statically readable', () => {
  const dirs = moduleDirs(repo)
  assert.ok(dirs.length > 0, 'no feature modules found')
  let read = 0
  for (const dir of dirs) {
    const decl = declFor(dir)
    assert.ok(decl, `${dir} has an index.ts but no default-exported module object`)
    assert.equal(
      decl.id,
      dir,
      `${dir}: the module's own id is '${decl.id}'; id must equal the directory name`
    )
    assert.deepEqual(
      decl.unreadable,
      [],
      `${dir} (${path.basename(decl.file)}) declares ${decl.unreadable
        .map((u) => `${u.field}: ${u.text} (${u.why})`)
        .join('; ')}. Every manifest cross-check below reads these fields; one it ` +
        `cannot parse is one it reports clean. Use a plain array of string literals.`
    )
    read++
  }
  assert.equal(read, dirs.length)
})

function covers(declared: readonly string[], property: string): boolean {
  return declared.some((d) => (d.endsWith('*') ? property.startsWith(d.slice(0, -1)) : d === property))
}

test('every implemented module agrees with modules.json in both directions', () => {
  const man = manifest()
  const dirs = moduleDirs(repo)

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

    // ownsCommands gets the same cross-check, in both directions. `sub-reload`
    // is exactly why: it was declared as a PROPERTY, where the guard never
    // fired, and the manifest happily agreed with the mistake.
    assert.deepEqual(
      [...declaredCommands(dir)].sort(),
      [...(entry.ownedCommands ?? [])].sort(),
      `${entry.id} (${dir}): ownsCommands and modules.json ownedCommands disagree`
    )
  }
})

/**
 * `requestsProperties`, the third declaration the manifest carries and the only
 * one nothing compared against the code.
 *
 * `manifest.test.ts` checks it thoroughly WITHIN the manifest -- an entry the
 * row also owns, an entry that is really a command, an entry nobody owns -- and
 * `ownership.test.ts` checks what it DOES at runtime (it decides which fix-hint
 * an OwnershipError gives, and `requestSet` refuses without it). Neither asked
 * whether the row and the module agree, so a module could reach for
 * `ctx.mpv.requestSet('aid', ...)` with no manifest entry, and the reviewer who
 * reads the manifest to answer "who depends on M11's `aid`?" would get the wrong
 * answer -- which is the whole reason the field is documented as existing "so
 * the dependency is visible in review".
 *
 * Both directions, like properties and commands.
 */
test("every module agrees with modules.json on requestsProperties", () => {
  const man = manifest()
  let compared = 0
  for (const dir of moduleDirs(repo)) {
    const entry = man.find((m) => m.path === `src/main/features/${dir}/`)
    assert.ok(entry, `module '${dir}' has no entry in docs/parity/modules.json`)
    const declared = declaredField(dir, 'requestsProperties')
    const listed = entry.requestsProperties ?? []
    assert.deepEqual(
      [...declared].sort(),
      [...listed].sort(),
      `${entry.id} (${dir}): requestsProperties and modules.json disagree -- code ` +
        `[${declared.join(', ')}] vs manifest [${listed.join(', ')}]`
    )
    compared++
  }
  // A comparison that compared nothing is a failure, not a pass.
  assert.ok(compared > 0, 'no module was compared')
})

test('no module claims one of mpv’s COMMANDS as a property', () => {
  // `sub-reload` is a command -- it is in --input-cmdlist, and mpv answers
  // "property not found" when you read it. Declaring it in ownsProperties
  // enforced precisely nothing while M18 and M19 could call it at will.
  const commandNames = new Set([
    'sub-reload',
    'sub-add',
    'sub-remove',
    'audio-add',
    'audio-remove',
    'audio-reload',
    'video-add',
    'video-remove',
    'video-reload',
    'ao-reload',
    'rescan-external-files',
    'screenshot',
    'screenshot-to-file',
    'screenshot-raw',
    'loadfile',
    'loadlist',
    'stop',
    'quit',
    'frame-step',
    'frame-back-step',
    'ab-loop',
    'drop-buffers',
    'revert-seek',
    'show-progress',
    'playlist-shuffle',
    'playlist-clear'
  ])
  for (const dir of moduleDirs(repo)) {
    for (const p of declaredProperties(dir)) {
      assert.ok(
        !commandNames.has(p),
        `${dir} declares '${p}' in ownsProperties, but it is a COMMAND. ` +
          `Move it to ownsCommands, which is where the guard actually fires.`
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
  const decls = moduleDirs(repo).map((d) => ({ id: d, ownsProperties: declaredProperties(d) }))
  // Constructing the map IS the assertion: it throws on any collision.
  const map = new OwnerMap([...CORE_OWNERSHIP, ...decls])
  assert.ok(map.entries().length > 100, 'expected a substantial owner map')
})

/**
 * `ownsFilterLabels`, checked in both directions — which nothing did.
 *
 * A reserved vf/af label is boot-claimed exactly like a property:
 * `chain.claim()` throws on a collision and refuses a label that is not in the
 * §5.5 order table, so a label is every bit as much a partition of a shared
 * namespace as `aid` is. But the manifest-vs-code test above only ever compared
 * `ownsProperties` and `ownsCommands`, so `ownedFilterLabels` in modules.json
 * and `ownsFilterLabels` in the module could disagree indefinitely and only a
 * boot would say so. M12 wrote this assertion into its OWN module.test.ts,
 * which is the wrong place: it belongs here, once, for all forty.
 *
 * The third direction is the one that actually bit: a label that is in the
 * manifest but NOT in `VF_ORDER`/`AF_ORDER` is a boot error at `claim()` time
 * for whoever gets there first. M04's `rl-idet` (spec §2 V21) was exactly that.
 */
test('every module agrees with modules.json on ownsFilterLabels, and the labels exist', () => {
  const man = manifest()
  const known = new Set([...VF_ORDER, ...AF_ORDER])

  for (const dir of moduleDirs(repo)) {
    const entry = man.find((m) => m.path === `src/main/features/${dir}/`)
    assert.ok(entry, `module '${dir}' has no entry in docs/parity/modules.json`)
    const declared = declaredLabels(dir)
    const listed = entry.ownedFilterLabels ?? []

    /**
     * ONE direction is strict, and it is deliberately not the one properties
     * use. `ownedFilterLabels` in the manifest is a RESERVATION -- the same
     * thing an empty Wave-1 feature directory is -- so a row may reserve
     * `rlac3` for a feature nobody has written yet (M15 does, today) and that
     * is the partition working, not drifting: the reservation is exactly what
     * stops a second module taking the label first.
     *
     * A CLAIM without a reservation is the failure, because that is the one
     * that can collide: `chain.claim()` would hand the label to whichever
     * module booted first and the manifest would never have said who owns it.
     */
    for (const l of declared) {
      assert.ok(
        listed.includes(l),
        `${entry.id} (${dir}): the module claims filter label '${l}' but modules.json does not ` +
          `reserve it. Two modules can then claim it and only a boot will say so.`
      )
    }
  }

  // Every label ANY row reserves must be in the order table, or claim() throws
  // at boot for a module that has done nothing wrong.
  for (const m of man) {
    for (const l of m.ownedFilterLabels ?? []) {
      assert.ok(
        known.has(l),
        `modules.json reserves filter label '${l}' for ${m.id}, but it is in neither VF_ORDER ` +
          `nor AF_ORDER in core/mpv/chain.ts, so chain.claim() will throw the moment ${m.id} ` +
          `boots. Add it to the §5.5 order table in its policy position.`
      )
    }
  }
})
