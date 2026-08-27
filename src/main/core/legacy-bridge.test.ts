import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_ACTIONS } from './legacy-bridge.ts'

/**
 * test:legacy-shim (§6.2, §5.10): "the 22-entry table only ever shrinks; the
 * suite FAILS THE BUILD once all 22 have owners, forcing the shim's deletion."
 *
 * A compatibility layer with no expiry date becomes permanent, and a permanent
 * one here means every action in the list keeps a second writer forever.
 *
 * DEVIATION, documented in docs/parity/02-wave0-api.md: the build-failing half
 * cannot fire on "all 22 have owners", because Wave 0 itself gave all 22 an
 * owner while the renderer still speaks the legacy vocabulary. The deadline is
 * therefore "all 22 owned AND no renderer call site left", counted below.
 */

const ORIGINAL_22 = [
  'volume',
  'mute',
  'speed',
  'speedReset',
  'frameBack',
  'frameForward',
  'screenshot',
  'screenshotClipboard',
  'toggleSubs',
  'cycleSub',
  'cycleAudio',
  'subDelay',
  'audioDelay',
  'chapterNext',
  'chapterPrev',
  'next',
  'previous',
  'fullscreen',
  'alwaysOnTop',
  'togglePlaylist',
  'seek',
  'stop'
]

test('the table never grows: every entry is one of the original 22', () => {
  for (const name of Object.keys(LEGACY_ACTIONS)) {
    assert.ok(
      ORIGINAL_22.includes(name),
      `'${name}' is not one of the 22 legacy actions. The shim may shrink; it may never grow. ` +
        `A new action belongs to a module, as a CommandDescriptor.`
    )
  }
})

test('the table only shrinks', () => {
  assert.ok(
    Object.keys(LEGACY_ACTIONS).length <= ORIGINAL_22.length,
    'the shim has grown, which is exactly what its expiry date exists to prevent'
  )
})

test('every remaining entry forwards to a namespaced command id, never to mpv', () => {
  for (const [name, target] of Object.entries(LEGACY_ACTIONS)) {
    assert.match(
      target.commandId,
      /^[a-z0-9-]+\.[A-Za-z0-9]+$/,
      `'${name}' must forward to '<feature-id>.<verb>'`
    )
    assert.ok(
      !target.commandId.startsWith('core.') || name === 'stop',
      `'${name}' should belong to a feature module, not to core`
    )
  }
})

test('the eleven owners §5.10 names are the ones the table points at', () => {
  const owners = new Set(Object.values(LEGACY_ACTIONS).map((t) => t.commandId.split('.')[0]))
  for (const expected of [
    'audio-volume',
    'audio-tracks',
    'subs-tracks',
    'subs-sync',
    'capture-still',
    'nav-seek',
    'nav-chapters',
    'playlist',
    'shell-window'
  ]) {
    assert.ok(owners.has(expected), `no legacy action forwards to ${expected}`)
  }
})
