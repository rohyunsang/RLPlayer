import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    onKey: (e) => log.keys.push(`${e.handle}:${e.key}`),
    // Rule 4: an interactive layer is Tab-reachable. `makeLayer` builds
    // interactive layers, so it declares one.
    handles: atX === null ? undefined : () => [`${id}-handle`]
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

// ---------------------------------------------------------------------------
// THE HALF THAT ONLY THIS FILE EVER CALLED.
//
// `tooltips()`, `key()` and `focusHandle()` had ZERO production call sites --
// grep found this file's lines 170, 182 and 185 and nothing else. So the merged
// tooltip and the whole keyboard model were tested, green, and dead: the
// overlay assigned `seekHover.textContent = formatTime(...)` directly and
// returned early on every arrow key inside a range input. M25 had SHIPPED a
// `tooltip()` fragment that was never called.
//
// A test suite that is the only caller of the thing it tests proves the code
// runs, not that the product uses it. These assert on the properties the wiring
// depends on; `scripts/e2e-overlay.mjs` asserts on the wiring itself, in the
// packaged build, because that is the part a unit test cannot see.
// ---------------------------------------------------------------------------

test("core's own tooltip fragment merges with the layers' by order", () => {
  // The A1 collision, as a test. Three modules wanted a fragment in one
  // tooltip: the timecode (core), the chapter title (M25/N37) and the thumbnail
  // (M27/N36). While the timecode was an assignment in main.ts, the other two
  // each had to edit that line -- in a file all three list in `mustNotTouch`.
  const scrubs: Recorder['scrubs'] = []
  const el = (): HTMLElement => ({}) as HTMLElement
  const host = new SeekbarHost({
    el: {} as HTMLElement,
    duration: () => 100,
    width: () => 1000,
    scrub: (time, phase, cancelled) => scrubs.push({ time, phase, cancelled }),
    baseTooltip: () => ({ el: el(), order: 0 })
  })
  host.register({ id: 'chapter', order: 10, render: () => undefined, tooltip: () => ({ el: el(), order: 20 }) })
  host.register({ id: 'thumb', order: 20, render: () => undefined, tooltip: () => ({ el: el(), order: 10 }) })
  assert.deepEqual(
    host.tooltips(400).map((t) => t.order),
    [0, 10, 20],
    "core's timecode is order 0 and composes with the rest; it is not a separate box"
  )
})

test('a layer whose tooltip throws does not blank the timecode', () => {
  const el = (): HTMLElement => ({}) as HTMLElement
  const host = new SeekbarHost({
    el: {} as HTMLElement,
    duration: () => 100,
    width: () => 1000,
    scrub: () => undefined,
    baseTooltip: () => ({ el: el(), order: 0 })
  })
  host.register({
    id: 'broken',
    order: 10,
    render: () => undefined,
    tooltip: () => {
      throw new Error('boom')
    }
  })
  const { errors } = captureErrors(() => {
    assert.deepEqual(host.tooltips(400).map((t) => t.order), [0])
  })
  assert.equal(errors.length, 1)
})

test('Tab walks every handle in paint order and then LEAVES the bar', () => {
  const r = makeHost()
  r.host.register(makeLayer('ticks', 10, 100).layer)
  r.host.register(makeLayer('pins', 20, 300).layer)

  assert.deepEqual(
    r.host.focusables().map((f) => `${f.layerId}:${f.handle}`),
    ['ticks:ticks-handle', 'pins:pins-handle']
  )
  assert.equal(r.host.focusNext(1), true)
  assert.deepEqual(r.host.focusedTarget, { layerId: 'ticks', handle: 'ticks-handle' })
  assert.equal(r.host.focusNext(1), true)
  assert.deepEqual(r.host.focusedTarget, { layerId: 'pins', handle: 'pins-handle' })
  // Off the end: false, and focus released. A widget that traps Tab is a widget
  // whose keyboard support gets switched off again by the next person.
  assert.equal(r.host.focusNext(1), false)
  assert.equal(r.host.focusedTarget, null)
  // …and backwards from nothing lands on the last one.
  assert.equal(r.host.focusNext(-1), true)
  assert.deepEqual(r.host.focusedTarget, { layerId: 'pins', handle: 'pins-handle' })
})

test('key() answers FALSE when nothing is focused, which is what keeps the slider working', () => {
  // The overlay falls through to the native range input on a false. If this
  // ever returned true unconditionally, arrow-key seeking would stop working
  // for everyone who never pressed Tab.
  const r = makeHost()
  const layer = makeLayer('pins', 20, 300)
  r.host.register(layer.layer)
  assert.equal(r.host.key('ArrowRight', 1), false)
  r.host.focusNext(1)
  assert.equal(r.host.key('ArrowRight', 1), true)
  assert.deepEqual(layer.keys, ['pins-handle:ArrowRight'])
})

test('a layer that is grabbable but not Tab-reachable is reported, once', () => {
  // Rule 4 with teeth. Not a throw: refusing to register the layer would take a
  // working feature away from mouse users to punish its author.
  const r = makeHost()
  r.host.register({
    id: 'mouse-only',
    order: 10,
    render: () => undefined,
    hitTest: () => 'h',
    onKey: () => undefined
  })
  const { errors } = captureErrors(() => {
    r.host.focusables()
    r.host.focusables()
    r.host.focusables()
  })
  assert.equal(errors.length, 1, 'the warning repeats every frame instead of once')
  assert.match(errors[0] ?? '', /declares no handles\(\)/)
})

test('a layer knows which of ITS OWN handles is focused, and no other', () => {
  const r = makeHost()
  r.host.register(makeLayer('ticks', 10, 100).layer)
  r.host.register(makeLayer('pins', 20, 300).layer)
  r.host.focusHandle('pins', 'pins-handle')
  assert.equal(r.host.ctx('pins').focusedHandle, 'pins-handle')
  assert.equal(r.host.ctx('ticks').focusedHandle, null, 'a layer must not see another layer\'s focus')
})

test('unregistering the focused layer drops the focus with it', () => {
  const r = makeHost()
  const off = r.host.register(makeLayer('pins', 20, 300).layer)
  r.host.focusNext(1)
  assert.notEqual(r.host.focusedTarget, null)
  off()
  assert.equal(r.host.focusedTarget, null, 'arrows would nudge a handle that no longer exists')
})

/** console.error, captured, so a test can assert a warning happened once. */
function captureErrors(fn: () => void): { errors: string[] } {
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.error = original
  }
  return { errors }
}

// ---------------------------------------------------------------------------
// THE CHECK THAT WOULD HAVE CAUGHT ALL OF THE ABOVE.
// ---------------------------------------------------------------------------

/**
 * A contribution point nothing calls is a promise to module authors that the
 * product does not keep.
 *
 * `tooltips()`, `key()` and `focusHandle()` were implemented, documented in the
 * host's own four-rule contract, unit-tested, green -- and called from nowhere
 * but this file. M25 wrote a `tooltip()` fragment against the documented
 * contract and it was dead on arrival. Three modules (M25 ticks, M26 pins, M27
 * thumbnails) were then each going to edit the ONE line of `main.ts` that
 * assigned the hover readout instead, in a file all three list in
 * `mustNotTouch`.
 *
 * So: every method a module's contract depends on must have a caller in shipped
 * code. `node --test` cannot see the overlay, but it can see that the overlay
 * mentions the method -- which is exactly the fact that was false.
 */
test('every contribution point on the host is called from shipped code', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..', '..', '..')
  const callers: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
        // The host's own definition is not a call site, and neither is the
        // interface that declares the member. Counting them is how "is anything
        // calling this?" answers yes for code nothing calls.
        const relPath = path.relative(repo, full).split(path.sep).join('/')
        if (relPath === 'src/renderer/src/core/seekbar-host.ts') continue
        if (relPath === 'src/shared/renderer-api.ts') continue
        callers.push(fs.readFileSync(full, 'utf8'))
      }
    }
  }
  walk(path.join(repo, 'src'))
  const shipped = callers.join('\n')

  const contract: Array<[string, string]> = [
    ['tooltips', 'a layer\'s tooltip() fragment never reaches the screen'],
    ['key', 'a layer\'s onKey() never fires, so rule 4 is unsatisfiable'],
    ['focusNext', 'Tab cannot reach a contributed handle'],
    ['baseTooltip', "core's timecode is assigned directly again, and the merge point is gone"],
    ['focusedHandle', 'a layer cannot paint a focus ring, so the focus is invisible']
  ]
  const missing = contract
    .filter(([name]) => !new RegExp(`\\b${name}\\b`).test(shipped))
    .map(([name, why]) => `${name}(): ${why}`)
  assert.deepEqual(
    missing,
    [],
    'these host methods have no call site outside this test file, so they are dead code ' +
      'wearing a passing suite:\n  ' +
      missing.join('\n  ')
  )
})
