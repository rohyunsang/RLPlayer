import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MPV_COMMAND_PREFIXES,
  OwnerMap,
  assertCommandShape,
  commandNameOf,
  commandShapeProblem,
  isBannedCommand,
  isChainCommand,
  propertiesWrittenBy,
  propertyWrittenBy,
  verbOf
} from './ownership.ts'

/**
 * The enforcement leaks, closed.
 *
 * Every case in the first half of this file was MEASURED against the pinned
 * mpv (v0.41.0-923-g7b8915bc1) over JSON IPC: each one returned `success`,
 * wrote the property for real, and returned `null` from the old
 * `propertyWrittenBy` — i.e. sailed straight past the owner map. The old guard
 * was one regex, `head.replace(/^(async\s+|no-osd\s+)+/, '')`: two names, and
 * only in a spelling mpv does not even accept over IPC.
 */

const noop = (): void => {}

// --- prefixes ---------------------------------------------------------------

test('a prefix as its own array element no longer hides a property write', () => {
  // Verbatim from the audit. All eight wrote the property.
  assert.equal(propertyWrittenBy(['osd-msg', 'set', 'speed', '1.75']), 'speed')
  assert.equal(propertyWrittenBy(['no-osd', 'set', 'speed', '1.8']), 'speed')
  assert.equal(propertyWrittenBy(['osd-bar', 'add', 'speed', 0.2]), 'speed')
  assert.equal(propertyWrittenBy(['raw', 'set', 'speed', '1.9']), 'speed')
  assert.equal(propertyWrittenBy(['repeatable', 'multiply', 'speed', 1.2]), 'speed')
  assert.equal(propertyWrittenBy(['async', 'set', 'speed', '2.0']), 'speed')
  assert.equal(propertyWrittenBy(['set_property_string', 'aid', '1']), 'aid')
  assert.equal(propertyWrittenBy(['cycle_values', 'speed', '2.1', '2.2']), 'speed')
})

test('EVERY prefix mpv accepts is handled, not a hand-picked two', () => {
  // Each name was sent to the pinned binary as [prefix,'set','speed','1.5'] and
  // returned success; `allow-vo-dragging`, `osd` and `quiet` returned
  // `invalid parameter` and are deliberately absent.
  assert.equal(MPV_COMMAND_PREFIXES.length, 11)
  for (const prefix of MPV_COMMAND_PREFIXES) {
    assert.equal(
      propertyWrittenBy([prefix, 'set', 'speed', '1.5']),
      'speed',
      `prefix '${prefix}' hid a property write`
    )
    assert.equal(
      isChainCommand([prefix, 'vf', 'set', 'lavfi=[null]']),
      true,
      `prefix '${prefix}' walked past the chain guard`
    )
  }
})

test('a stacked or space-joined prefix run is stripped too', () => {
  // mpv answers `invalid parameter` to both of these over JSON IPC, so this is
  // deliberate over-strictness: a command mpv would refuse is not worth a hole,
  // and the space-joined form is what input.conf uses.
  assert.equal(propertyWrittenBy(['async', 'no-osd', 'set', 'speed', 2]), 'speed')
  assert.equal(propertyWrittenBy(['no-osd set', 'speed', 3]), 'speed')
  assert.equal(isChainCommand(['no-osd', 'vf', 'set', 'lavfi=[null]']), true)
  assert.equal(isChainCommand(['no-osd vf', 'set', 'lavfi=[null]']), true)
})

test('a word that merely looks like a prefix is left alone', () => {
  // Stripping too eagerly would make ordinary commands look like writes.
  assert.equal(propertyWrittenBy(['bogus-prefix', 'set', 'speed', 1]), null)
  assert.equal(propertyWrittenBy(['osd', 'set', 'speed', 1]), null)
  // `seek` DOES write a property -- `time-pos` -- through COMMAND_SIDE_EFFECTS.
  // This line used to assert `null`, which is the bug written down as a test:
  // it is why `assertCommand('nav-chapters','seek')` was never reached.
  assert.equal(propertyWrittenBy(['seek', 5, 'exact']), 'time-pos')
  assert.equal(commandNameOf(['seek', 5, 'exact']), 'seek')
  assert.equal(commandNameOf(['no-osd', 'seek', 5]), 'seek')
})

// --- command spellings ------------------------------------------------------

test('the underscore aliases are property writes and are guarded', () => {
  // Measured: set_property, set_property_string, cycle_values and change_list
  // all return success from the pinned binary. `set-property` does not exist in
  // mpv, but guarding a name mpv rejects costs nothing.
  assert.equal(propertyWrittenBy(['set_property', 'aid', 2]), 'aid')
  assert.equal(propertyWrittenBy(['set_property_string', 'aid', '2']), 'aid')
  assert.equal(propertyWrittenBy(['cycle_values', 'speed', '1', '2']), 'speed')
  assert.equal(propertyWrittenBy(['change_list', 'glsl-shaders', 'clr', '']), 'glsl-shaders')
  assert.equal(propertyWrittenBy(['change-list', 'glsl-shaders', 'append', 'x']), 'glsl-shaders')
  assert.equal(propertyWrittenBy(['del', 'glsl-shaders']), 'glsl-shaders')
  assert.equal(propertyWrittenBy(['cycle', 'sid']), 'sid')
  assert.equal(propertyWrittenBy(['add', 'chapter', 1]), 'chapter')
})

test("loadfile's options argument is a property write, in both spellings", () => {
  // Measured with --keep-open=yes on a 10s file: speed came back 2.5 for the
  // string form and 3.0 for the map form. A module could set anything it liked
  // simply by loading a file with options.
  assert.deepEqual(propertiesWrittenBy(['loadfile', 'x.mkv', 'replace', 0, 'speed=2.5']), [
    'speed'
  ])
  assert.deepEqual(
    propertiesWrittenBy(['loadfile', 'x.mkv', 'replace', -1, { speed: '3.0', 'sub-delay': 1 }]),
    ['speed', 'sub-delay']
  )
  assert.deepEqual(propertiesWrittenBy(['loadfile', 'x.mkv', 'replace', 0, 'vf=lavfi=[null],aid=2']), [
    'vf',
    'aid'
  ])
  // The forms without an options argument write nothing.
  assert.deepEqual(propertiesWrittenBy(['loadfile', 'x.mkv', 'replace']), [])
  assert.deepEqual(propertiesWrittenBy(['loadfile', 'x.mkv', 'replace', -1]), [])
  // And the prefix form of it is caught as well.
  assert.deepEqual(propertiesWrittenBy(['async', 'loadfile', 'x.mkv', 'replace', 0, 'speed=2']), [
    'speed'
  ])
})

test('screenshot-raw is banned outright, prefixed or not', () => {
  // §7.7 trap 5: it kills mpv over JSON IPC. No owner, because there is no
  // correct use of it here.
  assert.equal(isBannedCommand(['screenshot-raw']), true)
  assert.equal(isBannedCommand(['async', 'screenshot-raw']), true)
  assert.equal(isBannedCommand(['screenshot-to-file', 'x.png']), false)
})

// --- ownsCommands -----------------------------------------------------------

test('a command can have an owner, and a duplicate claim names both modules', () => {
  const map = new OwnerMap([
    { id: 'subs-tracks', ownsCommands: ['sub-reload', 'sub-add'] },
    { id: 'playlist', ownsCommands: ['loadfile', 'playlist-*'] }
  ])
  assert.equal(map.commandOwnerOf('sub-reload'), 'subs-tracks')
  assert.equal(map.commandOwnerOf('playlist-next'), 'playlist')
  assert.equal(map.commandOwnerOf('seek'), null, 'an unclaimed command stays free')

  assert.throws(
    () =>
      new OwnerMap([
        { id: 'subs-tracks', ownsCommands: ['sub-reload'] },
        { id: 'subs-formats', ownsCommands: ['sub-reload'] }
      ]),
    (e: Error) => {
      assert.match(e.message, /subs-tracks/)
      assert.match(e.message, /subs-formats/)
      assert.match(e.message, /sub-reload/)
      return true
    }
  )
})

test('a foreign command is refused at runtime with the owner named', () => {
  const map = new OwnerMap([{ id: 'subs-tracks', ownsCommands: ['sub-reload'] }])
  assert.equal(map.assertCommand('subs-tracks', 'sub-reload', true, noop), true)
  assert.equal(map.assertCommand('subs-style', 'seek', true, noop), true)
  assert.throws(
    () => map.assertCommand('subs-formats', 'sub-reload', true, noop),
    (e: Error) => {
      assert.match(e.message, /subs-formats/)
      assert.match(e.message, /subs-tracks/)
      assert.match(e.message, /COMMAND, not a property/)
      return true
    }
  )
})

test('command ownership survives the underscore spelling', () => {
  const map = new OwnerMap([{ id: 'playlist', ownsCommands: ['playlist-next'] }])
  assert.equal(map.commandOwnerOf('playlist_next'), 'playlist')
})

test('a command claim may use the same trailing glob a property claim may', () => {
  const map = new OwnerMap([{ id: 'playlist', ownsCommands: ['playlist-*'] }])
  assert.equal(map.commandOwnerOf('playlist-shuffle'), 'playlist')
  assert.equal(map.commandOwnerOf('playlistoid'), null)
  assert.throws(() => new OwnerMap([{ id: 'x', ownsCommands: ['*'] }]), /bare glob/)
  assert.throws(() => new OwnerMap([{ id: 'x', ownsCommands: ['sub-*-load'] }]), /TRAILING/)
})

// --- the shipped-build behaviour --------------------------------------------

test('a packaged build counts refusals and they can be read back', () => {
  // The old comment said the count was "surfaced in stats"; nothing in src/
  // read `refusalCount` at all, so a dropped write in a shipped build vanished.
  const map = new OwnerMap([
    { id: 'audio-tracks', ownsProperties: ['aid'] },
    { id: 'subs-tracks', ownsCommands: ['sub-reload'] }
  ])
  map.assertWrite('audio-eq', 'aid', false, noop)
  map.assertWrite('audio-eq', 'aid', false, noop)
  map.assertCommand('subs-formats', 'sub-reload', false, noop)
  assert.equal(map.refusalCount('audio-eq'), 2)
  assert.deepEqual(map.refusalEntries(), [
    { moduleId: 'audio-eq', count: 2 },
    { moduleId: 'subs-formats', count: 1 }
  ])
})

// --- the fix-hint must not point somewhere dead -----------------------------

test('the hint tells an undeclared caller to declare, not to call a dead path', () => {
  // `requestSet` refuses with 'no-arbiter' unless the owner registered one, and
  // no module registered any, so "Use ctx.mpv.requestSet(...)" sent every
  // developer down a path that could not work.
  const map = new OwnerMap([
    { id: 'audio-tracks', ownsProperties: ['aid'] },
    { id: 'video-hdr', ownsProperties: [], requestsProperties: ['aid'] }
  ])
  assert.throws(
    () => map.assertWrite('audio-eq', 'aid', true, noop),
    /Add 'aid' to your requestsProperties/
  )
  // NO arbiter is registered for `aid` in this fixture, and the hint must say
  // so. It used to promise "audio-tracks's arbiter will answer" regardless,
  // while `requestSet` answered 'no-arbiter' -- the error message walked the
  // developer into the one call that could not succeed.
  assert.throws(
    () => map.assertWrite('video-hdr', 'aid', true, noop),
    /has NOT registered an arbiter/
  )
  // With one registered, the hint flips to the mediated call.
  map.setArbiterProbe((p) => p === 'aid')
  assert.throws(
    () => map.assertWrite('video-hdr', 'aid', true, noop),
    /has registered an arbiter/
  )
  assert.throws(
    () => map.assertWrite('audio-eq', 'nobody-owns-this', true, noop),
    /Reads are unrestricted/
  )
})

// ---------------------------------------------------------------------------
// FAIL CLOSED: an unrecognised command SHAPE used to disable every guard here.
// ---------------------------------------------------------------------------

/**
 * The eleven probes from the audit, verbatim, with what each one put on the
 * wire. Nine landed and none threw, because `verbOf()` returned `null` for a
 * non-string head and every caller read `null` as "nothing to check".
 *
 * The fourth is the one that shows the bug is not really about the head:
 * `['set', new String('speed'), 4]` has a perfectly ordinary string head, so
 * `verbOf` was satisfied — and `explicitPropertiesWrittenBy` then did
 * `typeof name === 'string' ? [name] : []` and returned an empty list, so the
 * write was ownership-checked against nothing at all.
 */
const BOXED_ATTACKS: Array<[string, unknown[], string]> = [
  ['boxed set', [new String('set'), 'speed', 4], '["set","speed",4]'],
  ['boxed raw vf', [new String('vf'), 'set', 'hflip'], '["vf","set","hflip"]'],
  ['boxed apply-profile', [new String('apply-profile'), 'fast'], '["apply-profile","fast"]'],
  ['boxed property name', ['set', new String('speed'), 4], '["set","speed",4]'],
  ['boxed screenshot-raw', [new String('screenshot-raw')], '["screenshot-raw"]'],
  ['boxed af', [new String('af'), 'set', 'anull'], '["af","set","anull"]'],
  [
    'boxed loadfile with options',
    [new String('loadfile'), 'x.mkv', 'replace', 0, 'speed=9'],
    '["loadfile","x.mkv","replace",0,"speed=9"]'
  ],
  ['array head', [['set'], 'speed', 4], '[["set"],"speed",4]'],
  ['number head', [0, 'set', 'speed', 4], '[0,"set","speed",4]'],
  ['empty command', [], '[]'],
  [
    'toJSON smuggling',
    [{ toJSON: () => 'set' }, 'speed', 4],
    '["set","speed",4]'
  ]
]

const REFUSED = /refusing an mpv command whose shape|must start with a command NAME/

test('a command shape the guards cannot read is REFUSED, not waved through', () => {
  for (const [name, args, onWire] of BOXED_ATTACKS) {
    // EVERY guard funnels through `verbOf`, and every one of them must refuse
    // rather than answer "nothing here". Answering "nothing here" is what put
    // ${onWire} on the wire with no ownership check at all.
    for (const [guard, fn] of [
      ['propertiesWrittenBy', () => propertiesWrittenBy(args)],
      ['isChainCommand', () => isChainCommand(args)],
      ['isBannedCommand', () => isBannedCommand(args)],
      ['commandNameOf', () => commandNameOf(args)],
      ['verbOf', () => verbOf(args)]
    ] as Array<[string, () => unknown]>) {
      assert.throws(fn, REFUSED, `${guard} accepted '${name}', which reaches mpv as ${onWire}`)
    }
  }
})

test('a boxed primitive or a toJSON is named as a SHAPE problem, not a head problem', () => {
  // The distinction matters for the error message: a boxed argument anywhere in
  // the array is the bypass, and the developer needs to be told which argument.
  const boxed = BOXED_ATTACKS.filter(([n]) => /boxed|toJSON|empty/.test(n))
  assert.equal(boxed.length, 9)
  for (const [name, args] of boxed) {
    assert.notEqual(commandShapeProblem(args), null, `'${name}' is accepted as a legal shape`)
    assert.throws(() => assertCommandShape(args), /refusing an mpv command whose shape/, name)
  }
  // A flat array argument is LEGAL — `['subprocess', {args: […]}]` and
  // `['osd-overlay', …]` need one — so `[['set'],'speed',4]` is refused by the
  // head rule rather than by the shape rule. Both refuse; only one is a shape bug.
  assert.equal(commandShapeProblem([['set'], 'speed', 4]), null)
  assert.throws(() => verbOf([['set'], 'speed', 4]), /must start with a command NAME/)
})

test('the shapes mpv actually takes still pass untouched', () => {
  const legal: unknown[][] = [
    ['set', 'speed', 1.5],
    ['no-osd', 'set', 'speed', '1.5'],
    ['async', 'no-osd', 'set', 'speed', 2],
    ['no-osd set', 'speed', 3],
    ['seek', 5, 'exact'],
    ['loadfile', 'x.mkv', 'replace', 0, 'speed=2.5'],
    ['loadfile', 'x.mkv', 'replace', -1, { speed: '3.0', 'sub-delay': 1 }],
    ['script-message-to', 'x', 'y'],
    ['set', 'ab-loop-a', 'no'],
    ['change-list', 'glsl-shaders', 'clr', ''],
    ['osd-overlay', 1, 'ass-events', '', 0, 0, 0, 'no', true],
    ['sub-add', 'a.srt', 'select', 'title', null]
  ]
  for (const args of legal) {
    assert.equal(commandShapeProblem(args), null, JSON.stringify(args))
    assert.doesNotThrow(() => assertCommandShape(args))
  }
  // A string head that is simply not a known verb is NOT a shape error: mpv
  // rejects it on its own and the guards correctly find nothing to own.
  assert.equal(commandShapeProblem(['bogus-prefix', 'set', 'speed', 1]), null)
  assert.deepEqual(verbOf(['bogus-prefix', 'set', 'speed', 1]), { verb: 'bogus-prefix', at: 0 })
  assert.equal(propertyWrittenBy(['bogus-prefix', 'set', 'speed', 1]), null)
})

test('a nested object more than one level deep is refused', () => {
  // loadfile's options map is flat. Anything deeper is a shape the guards were
  // never taught to walk, and walking it wrongly is how the next hole opens.
  assert.notEqual(
    commandShapeProblem(['loadfile', 'x.mkv', 'replace', 0, { opts: { speed: 2 } }]),
    null
  )
})
