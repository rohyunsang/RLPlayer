import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_STATE,
  clock,
  rangeLabel,
  regionBands,
  sanitizePrompt,
  type SkipPanelState
} from './skip-regions.ts'

const state = (over: Partial<SkipPanelState>): SkipPanelState => ({ ...EMPTY_STATE, ...over })

test('the intro band starts at the window start, not at zero', () => {
  const bands = regionBands(state({ duration: 1200, introStart: 12, introEnd: 95 }))
  assert.equal(bands.length, 1)
  assert.equal(bands[0]?.kind, 'intro')
  assert.ok(Math.abs((bands[0]?.leftPct ?? 0) - 1) < 1e-9)
  assert.ok(Math.abs((bands[0]?.widthPct ?? 0) - (83 / 1200) * 100) < 1e-9)
})

test('an intro with no explicit start begins at the head of the bar', () => {
  const bands = regionBands(state({ duration: 1200, introEnd: 120 }))
  assert.equal(bands[0]?.leftPct, 0)
  assert.equal(bands[0]?.widthPct, 10)
})

test('the ending band runs to the end of the bar', () => {
  const bands = regionBands(state({ duration: 1200, endingStart: 1080 }))
  assert.equal(bands.length, 1)
  assert.equal(bands[0]?.kind, 'ending')
  assert.equal(bands[0]?.leftPct, 90)
  assert.equal(bands[0]?.widthPct, 10)
})

test('both bands paint, in the order intro then ending', () => {
  const bands = regionBands(state({ duration: 1200, introEnd: 95, endingStart: 1080 }))
  assert.deepEqual(
    bands.map((b) => b.kind),
    ['intro', 'ending']
  )
})

test('no duration means nothing to paint, which is the live-stream case', () => {
  assert.deepEqual(regionBands(state({ duration: 0, introEnd: 95, endingStart: 1080 })), [])
})

test('a degenerate band is dropped rather than painted as a sliver', () => {
  // A stripe narrower than about a pixel on a 700 px bar is a lie the user has
  // to squint at; showing nothing is the honest answer.
  assert.deepEqual(regionBands(state({ duration: 1200, introStart: 10, introEnd: 11 })), [])
  // An inverted or out-of-range window cannot produce a band at all.
  assert.deepEqual(regionBands(state({ duration: 1200, introStart: 900, introEnd: 100 })), [])
  assert.deepEqual(regionBands(state({ duration: 1200, endingStart: 5000 })), [])
})

test('a band is clamped to the bar, so a window from a longer sibling cannot overflow', () => {
  const bands = regionBands(state({ duration: 600, introEnd: 900 }))
  assert.equal(bands[0]?.leftPct, 0)
  assert.equal(bands[0]?.widthPct, 100)
})

test('clock', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(95.9), '1:35')
  assert.equal(clock(3725), '1:02:05')
  assert.equal(clock(null), null)
  assert.equal(clock(Number.NaN), null)
  assert.equal(clock(-4), '0:00')
})

test('rangeLabel needs an end, and tolerates a missing start', () => {
  assert.equal(rangeLabel(12, 95), '0:12 – 1:35')
  assert.equal(rangeLabel(null, 95), '1:35')
  assert.equal(rangeLabel(12, null), null)
})

test('sanitizePrompt: a withdrawal is a kind of null, and anything else is refused', () => {
  assert.deepEqual(sanitizePrompt({ kind: null }), { kind: null })
  assert.deepEqual(sanitizePrompt({ kind: 'intro', ms: 5000, label: 'Skip intro' }), {
    kind: 'intro',
    ms: 5000,
    label: 'Skip intro'
  })
  // A payload with no `ms` still arms for the default window rather than 0 ms,
  // which would be a button that vanishes on the same frame it appears.
  assert.deepEqual(sanitizePrompt({ kind: 'ending' }), { kind: 'ending', ms: 5000 })
  assert.equal(sanitizePrompt({ kind: 'whatever' }), null)
  assert.equal(sanitizePrompt(null), null)
  assert.equal(sanitizePrompt('intro'), null)
  assert.equal(sanitizePrompt(undefined), null)
})
