import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRegistry, type KeybindFile } from './registry.ts'
import type { CommandDescriptor } from '@shared/feature-api'

/**
 * The keybind half of test:registry, plus the P18 storage-direction check.
 *
 * The point being proved: there is no hand-written preset table. All three
 * presets are the FOLD of every registered command's own defaults, so a module
 * that ships a command ships its Default/PotPlayer/mpv bindings with it.
 */

function backing(initial?: Partial<KeybindFile>): {
  read(): KeybindFile
  write(p: Partial<KeybindFile>): void
  file: KeybindFile
} {
  const file: KeybindFile = { preset: 'default', bindings: {}, ...initial }
  return {
    file,
    read: () => file,
    write: (p) => Object.assign(file, p)
  }
}

const cmd = (over: Partial<CommandDescriptor> & { id: string }): CommandDescriptor => ({
  labelKey: over.id,
  category: 'test',
  run: () => undefined,
  ...over
})

test('a command outside the module namespace fails the boot', () => {
  const r = new CommandRegistry(backing())
  assert.throws(
    () => r.register('audio-volume', [cmd({ id: 'subs-sync.setDelay' })]),
    /outside its namespace/
  )
})

test('two modules registering one command id fails the boot, naming both', () => {
  const r = new CommandRegistry(backing())
  r.register('audio-volume', [cmd({ id: 'audio-volume.set' })])
  assert.throws(
    () => r.register('audio-volume', [cmd({ id: 'audio-volume.set' })]),
    /duplicate command id/
  )
})

test('invoking an unknown command throws rather than silently no-opping', async () => {
  const r = new CommandRegistry(backing())
  await assert.rejects(() => r.invoke('nav-seek.forward5'), /unknown command/)
})

test('presets are DERIVED by folding the commands, not authored', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('nav-seek', [
    cmd({
      id: 'nav-seek.forward60',
      defaults: {
        default: ['Shift+ArrowRight'],
        potplayer: ['Ctrl+ArrowRight'],
        mpv: ['ArrowUp']
      }
    })
  ])
  r.register('capture-still', [
    cmd({ id: 'capture-still.save', defaults: { default: ['KeyS'], potplayer: ['KeyS'] } })
  ])

  assert.deepEqual(r.presetBindings('default'), {
    'nav-seek.forward60': ['Shift+ArrowRight'],
    'capture-still.save': ['KeyS']
  })
  assert.deepEqual(r.presetBindings('mpv'), { 'nav-seek.forward60': ['ArrowUp'] })
  assert.deepEqual(r.presetBindings('potplayer')['nav-seek.forward60'], ['Ctrl+ArrowRight'])
})

test('P18: storage is command -> accels, and accel -> command is derived', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('capture-still', [
    cmd({ id: 'capture-still.save', defaults: { default: ['KeyS', 'F12'] } })
  ])
  // "What keys run screenshot?" is the question a rebinding UI asks.
  assert.deepEqual(r.effectiveBindings()['capture-still.save'], ['KeyS', 'F12'])
  // "What is F12 bound to?" is derived.
  assert.equal(r.resolve()['F12'], 'capture-still.save')
})

test('user overrides replace a command s whole accel list, and can clear it', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('capture-still', [
    cmd({ id: 'capture-still.save', defaults: { default: ['KeyS'] } }),
    cmd({ id: 'capture-still.toClipboard', defaults: { default: ['Ctrl+KeyS'] } })
  ])
  r.setBinding('capture-still.save', ['Ctrl+Shift+KeyP'])
  assert.deepEqual(r.effectiveBindings()['capture-still.save'], ['Ctrl+Shift+KeyP'])
  assert.equal(r.resolve()['KeyS'], undefined)

  r.setBinding('capture-still.toClipboard', [])
  assert.equal(r.effectiveBindings()['capture-still.toClipboard'], undefined)
})

test('overrides are normalised so Shift+Ctrl+X and Ctrl+Shift+X are one binding', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('capture-still', [cmd({ id: 'capture-still.save' })])
  r.setBinding('capture-still.save', ['Shift+Ctrl+KeyS'])
  assert.equal(r.resolve()['Ctrl+Shift+KeyS'], 'capture-still.save')
})

test('conflict detection is scope-aware and reports rather than resolving', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('nav-seek', [cmd({ id: 'nav-seek.forward5', defaults: { default: ['KeyX'] } })])
  r.register('playlist', [
    cmd({ id: 'playlist.next', defaults: { default: ['KeyX'] } }),
    cmd({ id: 'playlist.sortByName', scope: 'playlist', defaults: { default: ['KeyX'] } })
  ])

  const conflicts = r.conflicts()
  const player = conflicts.find((c) => c.scope === 'player')
  assert.ok(player, 'two player-scope commands on KeyX is a conflict')
  assert.deepEqual(player.commandIds.sort(), ['nav-seek.forward5', 'playlist.next'])
  assert.equal(
    conflicts.filter((c) => c.scope === 'playlist').length,
    0,
    'a playlist-scope binding may reuse a player key'
  )
})

test('resolve() hides internal mediators from the player scope by scope, not by luck', () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('audio-tracks', [
    cmd({ id: 'audio-tracks.reinitDecoder', internal: true }),
    cmd({ id: 'audio-tracks.cycle', defaults: { default: ['KeyA'] } })
  ])
  assert.deepEqual(Object.values(r.resolve()), ['audio-tracks.cycle'])
})

test('query() returns the command value that invoke() throws away', async () => {
  const b = backing()
  const r = new CommandRegistry(b)
  r.register('playlist', [
    cmd({ id: 'playlist.seriesPrefix', internal: true, run: (arg) => `prefix:${String(arg)}` })
  ])
  assert.equal(await r.query<string>('playlist.seriesPrefix', 'Show.S01E04'), 'prefix:Show.S01E04')
})
