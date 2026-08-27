import test from 'node:test'
import assert from 'node:assert/strict'
import { topoSort, validateIds } from './registry-order.ts'

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

test('depending on a module that is not loaded throws', () => {
  assert.throws(
    () => topoSort([{ dir: 'nav-thumbnails', id: 'nav-thumbnails', dependsOn: ['mediainfo'] }]),
    /dependsOn 'mediainfo'/
  )
})
