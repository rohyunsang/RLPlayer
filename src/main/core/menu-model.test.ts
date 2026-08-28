import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MENU_ROOTS, commandMenuGroups, validateMenuPlacement } from './menu-model.ts'
import type { MenuCommand } from './menu-model.ts'

/**
 * `menuPath` and `menuOrder` had ZERO consumers, so there was nothing to test
 * and three modules were declaring a menu location that did nothing. These are
 * the tests the fields should have shipped with.
 */

const slots = (): Map<string, string> => new Map()

test('a command with a menuPath becomes an item under its root', () => {
  const cmds: MenuCommand[] = [
    { id: 'audio-volume.toggleMute', labelKey: 'a', menuPath: 'audio', menuOrder: 10 },
    { id: 'audio-eq.toggle', labelKey: 'b', menuPath: 'audio', menuOrder: 20 },
    { id: 'subs-tracks.toggleVisibility', labelKey: 'c', menuPath: 'subtitles', menuOrder: 10 }
  ]
  const groups = commandMenuGroups(cmds)
  assert.deepEqual(
    groups.map((g) => [g.path, g.items.map((i) => i.commandId)]),
    [
      ['audio', ['audio-volume.toggleMute', 'audio-eq.toggle']],
      ['subtitles', ['subs-tracks.toggleVisibility']]
    ]
  )
  // The root's base order is what interleaves it with contributed sections.
  assert.equal(groups[0]?.order, 30)
  assert.equal(groups[1]?.order, 40)
})

test('menuOrder decides item order, NOT registration order', () => {
  // Registered second-first, which is the shape that made the seek-bar layers
  // depend on alphabetical directory discovery.
  const groups = commandMenuGroups([
    { id: 'b.late', labelKey: 'x', menuPath: 'audio', menuOrder: 90 },
    { id: 'a.early', labelKey: 'y', menuPath: 'audio', menuOrder: 10 }
  ])
  assert.deepEqual(groups[0]?.items.map((i) => i.commandId), ['a.early', 'b.late'])
})

test('a command with no menuPath is not in the menu, and that is not an error', () => {
  const cmds: MenuCommand[] = [{ id: 'nav-seek.forward5', labelKey: 'x' }]
  assert.doesNotThrow(() => validateMenuPlacement('nav-seek', cmds, slots()))
  assert.deepEqual(commandMenuGroups(cmds), [])
})

test('an internal command may not be in the menu', () => {
  assert.throws(
    () =>
      validateMenuPlacement(
        'playlist',
        [{ id: 'playlist.seriesPrefix', labelKey: 'x', menuPath: 'tools', menuOrder: 10, internal: true }],
        slots()
      ),
    /is internal: true and also sets menuPath/
  )
  // …and it is filtered out of the model too, belt and braces.
  assert.deepEqual(
    commandMenuGroups([
      { id: 'playlist.seriesPrefix', labelKey: 'x', menuPath: 'tools', menuOrder: 10, internal: true }
    ]),
    []
  )
})

test('menuOrder without menuPath is a contribution error, not a silent no-op', () => {
  assert.throws(
    () => validateMenuPlacement('m', [{ id: 'm.a', labelKey: 'x', menuOrder: 10 }], slots()),
    /sets menuOrder 10 but no menuPath/
  )
})

test('menuPath without menuOrder is a contribution error', () => {
  // This is the state all three declaring modules were in. Leaving it legal
  // would put item order back on module discovery order.
  assert.throws(
    () => validateMenuPlacement('m', [{ id: 'm.a', labelKey: 'x', menuPath: 'audio' }], slots()),
    /has menuPath 'audio' but no menuOrder/
  )
})

test('an unknown root is a boot error naming the eight that exist', () => {
  assert.throws(
    () =>
      validateMenuPlacement(
        'm',
        [{ id: 'm.a', labelKey: 'x', menuPath: 'equaliser', menuOrder: 10 }],
        slots()
      ),
    /not one of the fixed menu roots: playback video audio subtitles navigate capture window tools/
  )
})

test('menuPath does not nest, and the message says what to use instead', () => {
  assert.throws(
    () =>
      validateMenuPlacement(
        'audio-devices',
        [{ id: 'audio-devices.pick', labelKey: 'x', menuPath: 'audio/devices', menuOrder: 10 }],
        slots()
      ),
    /menuPath does not nest.*ctx\.menu\.contribute/s
  )
})

test('two modules claiming one menu slot is a boot error naming both', () => {
  const taken = slots()
  validateMenuPlacement('audio-eq', [
    { id: 'audio-eq.toggle', labelKey: 'x', menuPath: 'audio', menuOrder: 20 }
  ], taken)
  assert.throws(
    () =>
      validateMenuPlacement(
        'audio-volume',
        [{ id: 'audio-volume.toggleMute', labelKey: 'y', menuPath: 'audio', menuOrder: 20 }],
        taken
      ),
    /duplicate menu slot: 'audio-eq\.toggle' and 'audio-volume\.toggleMute'/
  )
})

test('the same order under DIFFERENT roots is fine', () => {
  const taken = slots()
  assert.doesNotThrow(() => {
    validateMenuPlacement('a', [{ id: 'a.x', labelKey: 'x', menuPath: 'audio', menuOrder: 10 }], taken)
    validateMenuPlacement('b', [{ id: 'b.x', labelKey: 'x', menuPath: 'video', menuOrder: 10 }], taken)
  })
})

test('the roots are eight, distinct, and their orders are distinct and ascending', () => {
  const paths = MENU_ROOTS.map((r) => r.path)
  const orders = MENU_ROOTS.map((r) => r.order)
  assert.equal(new Set(paths).size, paths.length)
  assert.equal(new Set(orders).size, orders.length)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
})

/**
 * ---------------------------------------------------------------------------
 * The live declarations, read off disk.
 *
 * The unit tests above prove the rules; this proves the eighteen implemented
 * modules OBEY them, without booting Electron. It is the check that would have
 * caught all three modules declaring a menuPath that did nothing, and it is
 * also the only cross-module duplicate-slot check that runs in `npm test`.
 * ---------------------------------------------------------------------------
 */
test('every menuPath declared by a real module is valid and slot-unique', () => {
  const featuresDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'features'
  )
  const taken = new Map<string, string>()
  let withPath = 0

  for (const dir of fs.readdirSync(featuresDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const file = path.join(featuresDir, dir.name, 'index.ts')
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')

    // Each descriptor literal, from its `id:` to the next `id:` or the end.
    const declared: MenuCommand[] = []
    const idRe = /\n\s*id: '([^']+)',/g
    const marks = [...src.matchAll(idRe)]
    for (let i = 0; i < marks.length; i++) {
      const from = marks[i]?.index ?? 0
      const to = marks[i + 1]?.index ?? src.length
      const body = src.slice(from, to)
      const id = marks[i]?.[1] as string
      if (!id.startsWith(`${dir.name}.`)) continue // module id, not a command
      const mp = /\n\s*menuPath: '([^']+)'/.exec(body)?.[1]
      const mo = /\n\s*menuOrder: (\d+)/.exec(body)?.[1]
      const internal = /\n\s*internal: true/.test(body)
      if (!mp && !mo) continue
      declared.push({
        id,
        labelKey: id,
        ...(mp === undefined ? {} : { menuPath: mp }),
        ...(mo === undefined ? {} : { menuOrder: Number(mo) }),
        ...(internal ? { internal: true } : {})
      })
      if (mp) withPath++
    }
    if (declared.length === 0) continue
    assert.doesNotThrow(
      () => validateMenuPlacement(dir.name, declared, taken),
      `${dir.name} has an invalid menu placement`
    )
  }

  // A parser that silently matched nothing would pass this test forever, which
  // is how the visibleWhen and orphan-counter checks lied. Three commands carry
  // a menuPath today; if that number drops to zero, the scan broke.
  assert.ok(withPath >= 3, `expected to find the live menuPath declarations, found ${withPath}`)
})
