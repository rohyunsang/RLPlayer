import test from 'node:test'
import assert from 'node:assert/strict'
import { composeArgs, optionNameOf, validateArgContributions } from './reserved.ts'

/**
 * test:reserved-args (§6.2): "every module's contributeArgs output is disjoint
 * from the core-reserved prefix list AND from every other module's — the
 * V33/V36 --d3d11-output-format collision must fail the build."
 */

const core = (args: string[]): { ownerId: string; priority: number; args: string[] } => ({
  ownerId: 'core/mpv/bus',
  priority: 0,
  args
})

test('option names survive =value and mpv negation', () => {
  assert.equal(optionNameOf('--sub-auto=fuzzy'), 'sub-auto')
  assert.equal(optionNameOf('--no-config'), 'config')
  assert.equal(optionNameOf('--terminal'), 'terminal')
  assert.equal(optionNameOf('not-an-option'), null)
})

test('a module contributing a core-reserved option throws', () => {
  assert.throws(
    () =>
      validateArgContributions([
        core(['--vo=gpu-next']),
        { ownerId: 'video-decode', priority: 10, args: ['--vo=gpu'] }
      ]),
    /video-decode.*reserved by core\/mpv\/bus/s
  )
})

test('the --input-* and --osd-* families are core-reserved by prefix', () => {
  assert.throws(
    () =>
      validateArgContributions([
        { ownerId: 'shell-window', priority: 10, args: ['--input-doubleclick-time=400'] }
      ]),
    /reserved by core/
  )
})

test('an option that is INERT under --wid throws, naming the Electron API', () => {
  assert.throws(
    () =>
      validateArgContributions([
        { ownerId: 'shell-window', priority: 10, args: ['--fullscreen=yes'] }
      ]),
    (e: Error) => {
      assert.match(e.message, /INERT under --wid/)
      assert.match(e.message, /ctx\.window\.setFullScreen/)
      return true
    }
  )
  assert.throws(
    () => validateArgContributions([{ ownerId: 'shell-taskbar', priority: 10, args: ['--ontop'] }]),
    /setAlwaysOnTop/
  )
})

test('core itself may still set the two harmless inert flags §5.3 asks for', () => {
  assert.doesNotThrow(() =>
    validateArgContributions([core(['--cursor-autohide=no', '--taskbar-progress=no'])])
  )
})

test('two FEATURE modules contributing one option name is a boot error naming both', () => {
  // V33 (M05 HDR passthrough) vs V36 (M06 10-bit output). Both P1, mutually
  // exclusive, and last-one-wins would have been silent.
  assert.throws(
    () =>
      validateArgContributions([
        core([]),
        {
          ownerId: 'video-hdr',
          priority: 10,
          args: ['--d3d11-output-format=rgba16f', '--d3d11-output-csp=pq']
        },
        { ownerId: 'video-scaler', priority: 10, args: ['--d3d11-output-format=rgb10_a2'] }
      ]),
    (e: Error) => {
      assert.match(e.message, /d3d11-output-format/)
      assert.match(e.message, /video-hdr/)
      assert.match(e.message, /video-scaler/)
      return true
    }
  )
})

test('the additive *-append family is exempt, and nothing else is', () => {
  assert.doesNotThrow(() =>
    validateArgContributions([
      { ownerId: 'stream-ytdl', priority: 10, args: ['--script-opts-append=a=1'] },
      { ownerId: 'subs-formats', priority: 10, args: ['--script-opts-append=b=2'] }
    ])
  )
  assert.throws(
    () =>
      validateArgContributions([
        { ownerId: 'a-mod', priority: 10, args: ['--script-opts=a=1'] },
        { ownerId: 'b-mod', priority: 10, args: ['--script-opts=b=2'] }
      ]),
    /script-opts/
  )
})

test('the same module contributing one option twice is caught too', () => {
  assert.throws(
    () =>
      validateArgContributions([
        { ownerId: 'audio-volume', priority: 10, args: ['--volume=100', '--volume=80'] }
      ]),
    /twice in one batch/
  )
})

test('composition is priority-ascending and stable', () => {
  const argv = composeArgs([
    { ownerId: 'later', priority: 50, args: ['--b'] },
    { ownerId: 'core/mpv/bus', priority: 0, args: ['--a1', '--a2'] },
    { ownerId: 'mid', priority: 10, args: ['--c'] }
  ])
  assert.deepEqual(argv, ['--a1', '--a2', '--c', '--b'])
})
