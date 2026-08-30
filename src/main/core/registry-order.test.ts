import test from 'node:test'
import assert from 'node:assert/strict'
import { deferredDeps, topoSort, validateIds } from './registry-order.ts'

/**
 * test:registry (§6.2), the static half: "boot with a deliberately bad module:
 * wrong id, duplicate setting, duplicate channel, dependency cycle, throwing
 * setup(). Each must fail loudly AND the app must still start."
 *
 * The duplicate-registration cases live with their own registries
 * (settings/registry, input/registry, core/ipc); the ordering cases are here.
 * Note the deliberate asymmetry: a COLLISION fails the boot, a throwing
 * setup() only disables that one module.
 */

test('a module whose id does not match its directory fails the boot, naming both', () => {
  assert.throws(
    () => validateIds([{ dir: 'audio-volume', id: 'audio-vol' }]),
    (e: Error) => {
      assert.match(e.message, /audio-vol/)
      assert.match(e.message, /audio-volume/)
      return true
    }
  )
})

test('ids must be kebab-case', () => {
  assert.throws(() => validateIds([{ dir: 'AudioVolume', id: 'AudioVolume' }]), /kebab-case/)
  assert.doesNotThrow(() => validateIds([{ dir: 'nav-seek', id: 'nav-seek' }]))
})

test('two modules with one id cannot both pass: the directory check catches it', () => {
  // Directory names are unique by construction, so a duplicate id always shows
  // up first as an id/directory mismatch. Both checks exist; this is the one
  // that fires, and the message has to point at the right pair of names.
  assert.throws(
    () =>
      validateIds([
        { dir: 'playlist', id: 'playlist' },
        { dir: 'playlist2', id: 'playlist' }
      ]),
    (e: Error) => {
      assert.match(e.message, /playlist2/)
      return true
    }
  )
  assert.throws(
    () =>
      validateIds([
        { dir: 'playlist', id: 'playlist' },
        { dir: 'playlist', id: 'playlist' }
      ]),
    /duplicate module id/
  )
})

test('dependencies are set up before their dependents', () => {
  const ordered = topoSort([
    { dir: 'stream-ytdl', id: 'stream-ytdl', dependsOn: ['stream-open'] },
    { dir: 'stream-open', id: 'stream-open' },
    { dir: 'subs-browser', id: 'subs-browser', dependsOn: ['subs-formats'] },
    { dir: 'subs-formats', id: 'subs-formats' }
  ]).map((m) => m.id)
  assert.ok(ordered.indexOf('stream-open') < ordered.indexOf('stream-ytdl'))
  assert.ok(ordered.indexOf('subs-formats') < ordered.indexOf('subs-browser'))
})

test('a dependency cycle throws and NAMES the cycle', () => {
  assert.throws(
    () =>
      topoSort([
        { dir: 'a', id: 'a', dependsOn: ['b'] },
        { dir: 'b', id: 'b', dependsOn: ['c'] },
        { dir: 'c', id: 'c', dependsOn: ['a'] }
      ]),
    (e: Error) => {
      assert.match(e.message, /cycle/)
      assert.match(e.message, /a → b → c → a|b → c → a → b|c → a → b → c/)
      return true
    }
  )
})

/**
 * `dependsOn` HAS ONE NAMESPACE now — see MANIFEST_CORE_IDS in
 * registry-order.ts. This test used to assert that depending on `mediainfo`
 * THREW, and that was the defect: `mediainfo` is M29's reserved directory, so
 * the assertion enshrined "a module cannot name a dependency this build has not
 * implemented yet", which every module whose manifest row names an unbuilt
 * helper would have hit on the first line of its own feature. Four cases, four
 * different answers.
 */
test('a dep on a RESERVED but unbuilt module is deferred, not a boot error', () => {
  // M29's row depends on audio-tracks; M17's depends on subs-formats, which
  // does not exist yet. Neither may fail the boot.
  assert.doesNotThrow(() =>
    topoSort([{ dir: 'nav-thumbnails', id: 'nav-thumbnails', dependsOn: ['mediainfo'] }])
  )
  assert.deepEqual(
    deferredDeps([{ dir: 'nav-thumbnails', id: 'nav-thumbnails', dependsOn: ['mediainfo'] }]),
    [{ id: 'nav-thumbnails', dep: 'mediainfo' }]
  )
})

test('a dep on a CORE piece is satisfied by construction', () => {
  assert.doesNotThrow(() =>
    topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['core-af-chain'] }])
  )
  // …and it is not reported as deferred: core is up, there is nothing to say.
  assert.deepEqual(
    deferredDeps([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['core-af-chain'] }]),
    []
  )
})

test('a dep naming a manifest ROW id says which namespace it came from', () => {
  assert.throws(
    () => topoSort([{ dir: 'video-hdr', id: 'video-hdr', dependsOn: ['M07'] }]),
    /is a docs\/parity\/modules\.json ROW id, not a module id/
  )
})

test('a dep in NO namespace is still a boot error, and names the nearest id', () => {
  assert.throws(
    () => topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['core-af-chian'] }]),
    /Did you mean 'core-af-chain'\?/
  )
  assert.throws(
    () => topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['navthumbnails'] }]),
    /Did you mean 'nav-thumbnails'\?/
  )
  assert.throws(
    () => topoSort([{ dir: 'audio-eq', id: 'audio-eq', dependsOn: ['totally-made-up'] }]),
    /neither a loaded feature module, a module reserved in/
  )
})

test('a real edge is still a real edge, and ordering still comes out right', () => {
  const ordered = topoSort([
    { dir: 'subs-style', id: 'subs-style', dependsOn: ['subs-tracks'] },
    { dir: 'subs-tracks', id: 'subs-tracks', dependsOn: ['core-mpv-bus', 'subs-formats'] }
  ]).map((m) => m.id)
  assert.deepEqual(ordered, ['subs-tracks', 'subs-style'])
})
