import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOLEVEL_SMOOTHING,
  CHROMA_SHIFT_DEFAULTS,
  CHROMA_SHIFT_LIMIT,
  COLOUR_KNOBS,
  LEVELS_DEFAULTS,
  NEUTRAL,
  autoLevelSpec,
  changedKnobs,
  chromaShiftLiveOptions,
  chromaShiftSpec,
  clampColour,
  fmt,
  isNeutral,
  levelsLiveOptions,
  levelsSpec,
  osdFraction,
  signed,
  toOutputLevels,
  toTuple
} from './colour.ts'

/**
 * M01's pure half. Nothing here describes what the module is supposed to do in
 * prose — the two spec assertions below compare the produced strings against
 * the LITERALS in `docs/parity/00-parity-spec.md` §2, so a drifted spec fails
 * here rather than at the first frame of a 4K file.
 */

// --- the five properties ---------------------------------------------------

test("clampColour holds mpv's range and never emits a float or NaN", () => {
  assert.equal(clampColour(0), 0)
  assert.equal(clampColour(100), 100)
  assert.equal(clampColour(101), 100)
  assert.equal(clampColour(-101), -100)
  assert.equal(clampColour(12.6), 13)
  // NaN reaching mpv as a property value is silently taken as 0 by the JSON
  // layer, which is a value the user did not ask for; make it explicit here.
  assert.equal(clampColour(Number.NaN), 0)
  assert.equal(clampColour(undefined), 0)
  assert.equal(clampColour('7'), 7)
})

test("toTuple fills missing knobs from mpv's defaults, not with undefined", () => {
  assert.deepEqual(toTuple(undefined), { ...NEUTRAL })
  assert.deepEqual(toTuple({ brightness: 20 }), { ...NEUTRAL, brightness: 20 })
  // A stored slice from an older build, or a hand-edited json file.
  assert.deepEqual(toTuple({ brightness: 999, gamma: null, bogus: 5 }), {
    ...NEUTRAL,
    brightness: 100
  })
})

test('changedKnobs is the write set for one apply', () => {
  const a = toTuple({ brightness: 10, hue: -5 })
  assert.deepEqual(changedKnobs(a, a), [])
  assert.deepEqual(changedKnobs(a, { ...a, hue: 0 }), ['hue'])
  assert.deepEqual(changedKnobs(a, NEUTRAL), ['brightness', 'hue'])
  // Declaration order, so the OSD and the settings rows agree.
  assert.deepEqual(changedKnobs(NEUTRAL, toTuple({ gamma: 1, contrast: 1 })), [
    'contrast',
    'gamma'
  ])
})

test("isNeutral is what V03's toggle branches on", () => {
  assert.equal(isNeutral(NEUTRAL), true)
  assert.equal(isNeutral(toTuple({ hue: -1 })), false)
})

test('the OSD readout is signed and the bar centres on zero', () => {
  assert.equal(signed(12), '+12')
  assert.equal(signed(-3), '-3')
  assert.equal(signed(0), '0')
  assert.equal(osdFraction(0), 0.5)
  assert.equal(osdFraction(-100), 0)
  assert.equal(osdFraction(100), 1)
})

test("toOutputLevels only ever yields one of mpv's three values", () => {
  assert.equal(toOutputLevels('limited'), 'limited')
  assert.equal(toOutputLevels('full'), 'full')
  assert.equal(toOutputLevels('auto'), 'auto')
  // mpv answers `undefined` for a property it considers unavailable (§3.3.1),
  // and 'video-output-levels' is one some VOs do not implement.
  assert.equal(toOutputLevels(undefined), 'auto')
  assert.equal(toOutputLevels('LIMITED'), 'auto')
})

// --- float formatting ------------------------------------------------------

test('fmt never emits exponent notation or a trailing dot', () => {
  assert.equal(fmt(0.0625), '0.0625')
  assert.equal(fmt(0.9176), '0.9176')
  assert.equal(fmt(0), '0')
  assert.equal(fmt(0.5), '0.5')
  assert.equal(fmt(1), '1')
  // 0.1 + 0.2 is the case a naive String() ships to lavfi as
  // '0.30000000000000004'.
  assert.equal(fmt(0.1 + 0.2), '0.3')
  assert.equal(fmt(0.00001), '0')
  assert.equal(fmt(Number.NaN), '0')
})

// --- the three specs, against the literals in §2 --------------------------

test('V05 levelsSpec reproduces the spec literal at its defaults', () => {
  assert.equal(
    levelsSpec(LEVELS_DEFAULTS),
    'lavfi=[colorlevels=rimin=0.0625:gimin=0.0625:bimin=0.0625' +
      ':rimax=0.9176:gimax=0.9176:bimax=0.9176]'
  )
  // The label is NOT in the spec: §5 takes the spec WITHOUT it and the chain
  // adds `@rl-levels:` itself. A spec carrying its own label produces
  // `@rl-levels:@rl-levels:...` on the wire.
  assert.ok(!levelsSpec(LEVELS_DEFAULTS).includes('@'))
  assert.ok(!levelsSpec(LEVELS_DEFAULTS).includes('rl-levels'))
})

test('V06 autoLevelSpec reproduces the spec literal, smoothing included', () => {
  assert.equal(AUTOLEVEL_SMOOTHING, 50)
  assert.equal(
    autoLevelSpec(),
    'lavfi=[normalize=blackpt=black:whitept=white:smoothing=50]'
  )
})

test('V07 chromaShiftSpec reproduces the spec literal at zero', () => {
  assert.equal(
    chromaShiftSpec(CHROMA_SHIFT_DEFAULTS),
    'lavfi=[chromashift=cbh=0:cbv=0:crh=0:crv=0]'
  )
  assert.equal(
    chromaShiftSpec({ horizontal: 3, vertical: -2 }),
    'lavfi=[chromashift=cbh=3:cbv=-2:crh=3:crv=-2]'
  )
  // Pixels, so integers, and bounded: chromashift takes -255..255 but a shift
  // past a few pixels is a broken file, not a correction.
  assert.equal(
    chromaShiftSpec({ horizontal: 999, vertical: -999 }),
    `lavfi=[chromashift=cbh=${CHROMA_SHIFT_LIMIT}:cbv=${-CHROMA_SHIFT_LIMIT}` +
      `:crh=${CHROMA_SHIFT_LIMIT}:crv=${-CHROMA_SHIFT_LIMIT}]`
  )
})

// --- the live options ------------------------------------------------------

/**
 * WHAT THIS CHECKS, AND WHAT IT CANNOT.
 *
 * `ctx.vf.command(label, option, value, filter, spec)` runs the spec through
 * `specReflects()` in `core/mpv/chain.ts` and throws a ContributionError unless
 * the spec expresses the change. `specReflects` is exported, pure and
 * side-effect-free — and a feature module may not import it: `/core/mpv` is in
 * `CORE_PATHS`, so `check:forbidden` fails the build on the import, in a test
 * file as much as in `index.ts`. Reported as a finding.
 *
 * So what follows is a DELIBERATE RE-IMPLEMENTATION of the chain's tier-1 rule
 * — "the spec names the option and sets it to this value" — and it is stated
 * plainly because a check whose limits are undocumented gets trusted past them:
 * it proves the pairing this module emits satisfies tier 1 as documented in
 * §3.3.6, and it does NOT prove the chain agrees. Only a build does that.
 */
function namesOption(spec: string, filter: string, option: string, value: string): boolean {
  const at = spec.indexOf(`${filter}=`)
  if (at < 0) return false
  // Split on ':' rather than substring-matching, so `gimax=0.9` does not match
  // `gimax=0.9176`. That prefix case is the whole reason this is not an
  // `includes()`.
  const args = spec.slice(at + filter.length + 1).replace(/\]$/, '')
  return args.split(':').includes(`${option}=${value}`)
}

test('every V05 live option pairs with a spec that names it (tier 1)', () => {
  const state = { black: 0.07, white: 0.93 }
  const spec = levelsSpec(state)
  for (const knob of ['black', 'white'] as const) {
    const options = levelsLiveOptions(state, knob)
    assert.equal(options.length, 3, 'colorlevels needs all three channels moved together')
    for (const o of options) {
      assert.ok(namesOption(spec, o.filter, o.option, o.value), `${o.option}=${o.value} vs ${spec}`)
    }
  }
})

test('every V07 live option pairs with a spec that names it (tier 1)', () => {
  const state = { horizontal: 4, vertical: -3 }
  const spec = chromaShiftSpec(state)
  for (const knob of ['horizontal', 'vertical'] as const) {
    const options = chromaShiftLiveOptions(state, knob)
    assert.equal(options.length, 2, 'cb and cr move together')
    for (const o of options) {
      assert.ok(namesOption(spec, o.filter, o.option, o.value), `${o.option}=${o.value} vs ${spec}`)
    }
  }
})

/**
 * The negative half, which is what proves the assertions above do any work: a
 * spec computed from state the module has NOT yet updated is the exact shape
 * §3.3.6 says cost M03 a 201-line compensating file, and it must not pass.
 */
test('a spec that lags the command does not pass, so the pairing check is real', () => {
  const stale = levelsSpec(LEVELS_DEFAULTS)
  for (const o of levelsLiveOptions({ ...LEVELS_DEFAULTS, black: 0.12 }, 'black')) {
    assert.equal(
      namesOption(stale, o.filter, o.option, o.value),
      false,
      'the chain would have silently desynchronised'
    )
  }
  // …and a value that is a PREFIX of the one in the spec must not pass either.
  // `0.9` against `gimax=0.9176` is the shape a plain `includes()` gets wrong,
  // and the chain's own tier 3 documents itself as having exactly that weakness.
  assert.equal(namesOption(stale, 'colorlevels', 'gimax', '0.9'), false)
})

test('the knob list is the five sliders and nothing else', () => {
  // `video-output-levels` is owned by this module too, and it is an enum, not a
  // -100..100 slider. Deriving the slider list from `ownsProperties` would put
  // it in the OSD and in changedKnobs().
  assert.deepEqual([...COLOUR_KNOBS], ['brightness', 'contrast', 'saturation', 'hue', 'gamma'])
})
