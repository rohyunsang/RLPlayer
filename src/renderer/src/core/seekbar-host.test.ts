import test from 'node:test'
import assert from 'node:assert/strict'
import { SeekbarHost } from './seekbar-host.ts'
import type { SeekbarLayer } from '../../../shared/renderer-api.ts'

/**
 * test:seekbar-interaction (§6.2): "a synthetic pointer sequence over three
 * registered layers hits the topmost claimant only; a claimed press suppresses
 * the host scrub; every onPointerDown gets exactly one onPointerUp, including
 * on pointercancel and window blur; keyboard nudging moves the same handle."
 *
 * The host calls no DOM API, so the whole interaction model runs here.
 */

interface Recorder {
  host: SeekbarHost
  scrubs: Array<{ time: number; phase: string; cancelled: boolean }>
}

function makeHost(duration = 100, width = 1000): Recorder {
  const scrubs: Recorder['scrubs'] = []
  const host = new SeekbarHost({
    el: {} as HTMLElement,
    duration: () => duration,
    width: () => width,
    scrub: (time, phase, cancelled) => scrubs.push({ time, phase, cancelled })
  })
  return { host, scrubs }
}

interface LayerLog {
  layer: SeekbarLayer
  down: string[]
  up: Array<{ handle: string; cancelled: boolean }>
  move: string[]
  hover: Array<string | null>
  keys: string[]
}

function makeLayer(id: string, order: number, atX: number | null): LayerLog {
  const log: LayerLog = { layer: null as never, down: [], up: [], move: [], hover: [], keys: [] }
  log.layer = {
    id,
    order,
    render: () => undefined,
    hitTest:
      atX === null
        ? undefined
        : (c) => (Math.abs(c.x - atX) <= c.tolerancePx ? `${id}-handle` : null),
    onPointerDown: (e) => log.down.push(e.handle),
    onPointerMove: (e) => log.move.push(e.handle),
    onPointerUp: (e) => log.up.push({ handle: e.handle, cancelled: e.cancelled }),
    onHover: (e) => log.hover.push(e?.handle ?? null),
    onKey: (e) => log.keys.push(`${e.handle}:${e.key}`)
  }
  return log
}

test('the visually topmost claimant wins, and lower layers see nothing', () => {
  const { host } = makeHost()
  const low = makeLayer('low', 10, 500)
  const high = makeLayer('high', 30, 500)
  const mid = makeLayer('mid', 20, 500)
  host.register(low.layer)
  host.register(high.layer)
  host.register(mid.layer)

  assert.equal(host.pointerDown(500), true)
  assert.deepEqual(high.down, ['high-handle'])
  assert.deepEqual(mid.down, [])
  assert.deepEqual(low.down, [])
  host.pointerUp(500)
})

test('a claimed press suppresses the host scrub entirely', () => {
  const r = makeHost()
  const layer = makeLayer('abloop', 20, 300)
  r.host.register(layer.layer)

  assert.equal(r.host.pointerDown(300), true)
  r.host.pointerMove(320)
  r.host.pointerUp(320)
  assert.equal(r.scrubs.length, 0, 'grabbing an A-B handle must not also seek')
  assert.deepEqual(layer.move, ['abloop-handle'])
  assert.deepEqual(layer.up, [{ handle: 'abloop-handle', cancelled: false }])
})

test('an unclaimed press falls through to the host scrub, which is never stolen', () => {
  const r = makeHost()
  const layer = makeLayer('pins', 20, 300)
  r.host.register(layer.layer)

  assert.equal(r.host.pointerDown(700), false)
  r.host.pointerMove(750)
  r.host.pointerUp(800)
  assert.deepEqual(
    r.scrubs.map((s) => s.phase),
    ['down', 'move', 'up']
  )
  assert.equal(r.scrubs[0]?.time, 70, 'x 700 of 1000 over a 100s file is 70s')
  assert.deepEqual(layer.down, [])
})

test('a layer with no hitTest never receives pointer events at all', () => {
  const r = makeHost()
  const ticks = makeLayer('ticks', 40, null)
  r.host.register(ticks.layer)
  r.host.pointerDown(500)
  r.host.pointerUp(500)
  assert.deepEqual(ticks.down, [], 'chapter ticks stay three lines long')
  assert.equal(r.scrubs.length, 2)
})

test('every onPointerDown gets exactly one onPointerUp, including on cancel', () => {
  const r = makeHost()
  const layer = makeLayer('abloop', 20, 300)
  r.host.register(layer.layer)

  r.host.pointerDown(300)
  r.host.cancel() // pointercancel / window blur / Esc
  assert.deepEqual(layer.up, [{ handle: 'abloop-handle', cancelled: true }])

  // A second up must NOT produce a second callback.
  r.host.pointerUp(300)
  assert.equal(layer.up.length, 1)
  assert.equal(r.host.dragging, false)
})

test('a new press while one is live closes the old gesture first', () => {
  const r = makeHost()
  const layer = makeLayer('abloop', 20, 300)
  r.host.register(layer.layer)
  r.host.pointerDown(300)
  r.host.pointerDown(300)
  assert.equal(layer.up.length, 1, 'the first gesture was closed as cancelled')
  assert.equal(layer.up[0]?.cancelled, true)
  assert.equal(layer.down.length, 2)
})

test('hover reaches EVERY layer that wants it, with a null handle off-target', () => {
  const r = makeHost()
  const a = makeLayer('a', 10, 200)
  const b = makeLayer('b', 20, 800)
  r.host.register(a.layer)
  r.host.register(b.layer)

  r.host.hover(800)
  assert.deepEqual(a.hover, [null])
  assert.deepEqual(b.hover, ['b-handle'])

  r.host.hover(null)
  assert.deepEqual(a.hover, [null, null])
})

test('tooltip fragments from several layers are merged by order, not stacked', () => {
  const r = makeHost()
  const el = (): HTMLElement => ({}) as HTMLElement
  r.host.register({
    id: 'time',
    order: 10,
    render: () => undefined,
    tooltip: () => ({ el: el(), order: 30 })
  })
  r.host.register({
    id: 'thumb',
    order: 20,
    render: () => undefined,
    tooltip: () => ({ el: el(), order: 10 })
  })
  const tips = r.host.tooltips(400)
  assert.deepEqual(
    tips.map((t) => t.order),
    [10, 30]
  )
})

test('keyboard nudging moves the handle the last press focused', () => {
  const r = makeHost()
  const layer = makeLayer('abloop', 20, 300)
  r.host.register(layer.layer)

  assert.equal(r.host.key('ArrowRight', 1), false, 'nothing focused yet')
  r.host.pointerDown(300)
  r.host.pointerUp(300)
  assert.equal(r.host.key('ArrowRight', 1), true)
  assert.deepEqual(layer.keys, ['abloop-handle:ArrowRight'])
})

test('a live stream (duration 0) does not divide by zero', () => {
  const r = makeHost(0, 1000)
  const ctx = r.host.ctx()
  assert.equal(ctx.timeToX(50), 0)
  assert.equal(ctx.xToTime(500), 0)
  r.host.pointerDown(500)
  r.host.pointerUp(500)
  assert.equal(r.scrubs[0]?.time, 0)
})

test('duplicate layer ids are rejected', () => {
  const r = makeHost()
  const a = makeLayer('same', 10, 100)
  const b = makeLayer('same', 20, 200)
  r.host.register(a.layer)
  assert.throws(() => r.host.register(b.layer), /duplicate seek-bar layer id/)
})

test('unregistering a layer mid-drag closes its gesture', () => {
  const r = makeHost()
  const layer = makeLayer('abloop', 20, 300)
  const off = r.host.register(layer.layer)
  r.host.pointerDown(300)
  off()
  assert.deepEqual(layer.up, [{ handle: 'abloop-handle', cancelled: true }])
})
