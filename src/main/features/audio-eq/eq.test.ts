import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BAND_COUNT,
  BAND_FREQ,
  BAND_WIDTH,
  CHANNEL_COUNT,
  autoPreamp,
  changeArg,
  changeArgsForBand,
  clampGain,
  effectivePreamp,
  entryIndex,
  equaliserSpec,
  flatGains,
  formatNumber,
  isFlat,
  normaliseGains,
  parseGains,
  preampSpec,
  preampValue,
  serialiseGains
} from './eq.ts'
import {
  BUILT_IN_PRESETS,
  findPreset,
  findPresetByGains,
  mergePresets,
  nextPreset,
  parsePresetFile,
  serialisePresetFile
} from './presets.ts'

/**
 * M12's pure half. These tests assert the EXACT strings that go on the wire,
 * because that is the only part of A01/A03 that was verified against the pinned
 * binary — a test that asserts "ten bands were produced" would still pass with
 * a spec mpv rejects, and a spec mpv rejects fails silently: the af chain logs
 * and moves on rather than throwing.
 */

// --- the graph -------------------------------------------------------------

test('the band table is the one A01 measured, and it is not derived', () => {
  assert.deepEqual([...BAND_FREQ], [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
  assert.deepEqual([...BAND_WIDTH], [22, 44, 88, 175, 350, 700, 1400, 2800, 5600, 11000])
  assert.equal(BAND_COUNT, 10)
  assert.equal(CHANNEL_COUNT, 8)
})

test('the spec is a labelless lavfi anequalizer with one entry per channel-band', () => {
  const spec = equaliserSpec(flatGains())
  assert.ok(spec.startsWith('lavfi=[anequalizer='), spec.slice(0, 40))
  assert.ok(spec.endsWith(']'))
  // The chain adds `@rleq:`; a module that adds its own label ends up with
  // `@rleq:@rleq:` and no filter at all.
  assert.ok(!spec.includes('@'))
  const entries = spec.slice('lavfi=[anequalizer='.length, -1).split('|')
  assert.equal(entries.length, BAND_COUNT * CHANNEL_COUNT)
  assert.equal(entries[0], 'c0 f=31 w=22 g=0 t=0')
  assert.equal(entries[9], 'c0 f=16000 w=11000 g=0 t=0')
  assert.equal(entries[10], 'c1 f=31 w=22 g=0 t=0')
  assert.equal(entries[79], 'c7 f=16000 w=11000 g=0 t=0')
})

test('THE SPEC CONTAINS NO COMMA — the af chain joins slots with one', () => {
  // If this ever fails, every other module's filter goes with it: the chain
  // emits `@rlch:...,@rleq:...,@rlboost:...` and a comma inside a slot splits
  // the graph in a place mpv cannot diagnose.
  const spec = equaliserSpec([12, -12, 3.5, 0, 0, 0, 0, 0, 0, -0.5])
  assert.equal(spec.includes(','), false)
  assert.equal(preampSpec(-6).includes(','), false)
})

test('gains land in the right entry on every channel', () => {
  const gains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 9]
  const entries = equaliserSpec(gains).slice('lavfi=[anequalizer='.length, -1).split('|')
  for (let c = 0; c < CHANNEL_COUNT; c++) {
    assert.equal(entries[entryIndex(c, 9)], `c${c} f=16000 w=11000 g=9 t=0`)
    assert.equal(entries[entryIndex(c, 0)], `c${c} f=31 w=22 g=0 t=0`)
  }
})

test('t=0 (Butterworth) is on every entry', () => {
  const entries = equaliserSpec(flatGains())
    .slice('lavfi=[anequalizer='.length, -1)
    .split('|')
  assert.equal(entries.length, 80)
  assert.equal(entries.every((e) => e.endsWith(' t=0')), true)
})

// --- the live update -------------------------------------------------------

test('the change argument is idx|f=..|w=..|g=.. and carries f and w every time', () => {
  // Omitting f/w does not "leave them alone": the command replaces the entry.
  assert.equal(changeArg(0, 0, 6), '0|f=31|w=22|g=6')
  assert.equal(changeArg(1, 5, -3.5), '15|f=1000|w=700|g=-3.5')
  assert.equal(changeArg(7, 9, 0), '79|f=16000|w=11000|g=0')
})

test('one band is eight change arguments, one per declared channel', () => {
  const args = changeArgsForBand(2, 4)
  assert.equal(args.length, CHANNEL_COUNT)
  assert.deepEqual(args.slice(0, 2), ['2|f=125|w=88|g=4', '12|f=125|w=88|g=4'])
  // 0-79 is the accepted index range A01 measured; 200 was rejected.
  for (const a of args) {
    const idx = Number(a.split('|')[0])
    assert.ok(idx >= 0 && idx <= 79, a)
  }
})

// --- gain arithmetic -------------------------------------------------------

test('gains clamp to PotPlayer’s +/-12 dB and survive nonsense', () => {
  assert.equal(clampGain(99), 12)
  assert.equal(clampGain(-99), -12)
  assert.equal(clampGain(3.46), 3.5)
  assert.equal(clampGain(Number.NaN), 0)
  assert.equal(clampGain(undefined), 0)
  assert.equal(clampGain('4'), 4)
  // -0 formats as '-0' and would reach mpv that way.
  assert.equal(Object.is(clampGain(-0.01), 0), true)
  assert.equal(formatNumber(-0), '0')
})

test('normaliseGains always returns ten values', () => {
  assert.equal(normaliseGains([1, 2, 3]).length, 10)
  assert.deepEqual(normaliseGains([1, 2, 3]).slice(3), [0, 0, 0, 0, 0, 0, 0])
  assert.equal(normaliseGains(new Array(31).fill(1)).length, 10)
  assert.deepEqual(normaliseGains('rubbish'), flatGains())
  assert.equal(isFlat(flatGains()), true)
  assert.equal(isFlat([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]), false)
})

test('the setting round-trips as a string, which is what makes P51 work', () => {
  const gains = [3, -2.5, 0, 0, 0, 0, 0, 0, 0, 12]
  const text = serialiseGains(gains)
  assert.equal(text, '3,-2.5,0,0,0,0,0,0,0,12')
  assert.deepEqual(parseGains(text), gains)
  // The registry compares with Object.is. A string default equals a string
  // value; an array default never equals anything, so an array-valued setting
  // could never be pruned back to its default.
  assert.equal(Object.is(serialiseGains(flatGains()), '0,0,0,0,0,0,0,0,0,0'), true)
  assert.deepEqual(parseGains(undefined), flatGains())
  assert.deepEqual(parseGains('1,2'), [1, 2, 0, 0, 0, 0, 0, 0, 0, 0])
})

// --- the preamp (A03) ------------------------------------------------------

test('the automatic preamp undoes the largest boost and ignores cuts', () => {
  assert.equal(autoPreamp([6, 0, 0, 0, 0, 0, 0, 0, 0, 0]), -6)
  assert.equal(autoPreamp([6, 0, 0, 0, 0, 0, 0, 0, 0, 9]), -9)
  // A curve that only attenuates needs no headroom.
  assert.equal(autoPreamp([-6, -3, 0, 0, 0, 0, 0, 0, 0, 0]), 0)
  assert.equal(autoPreamp(flatGains()), 0)
})

test('effectivePreamp switches between the automatic and the manual value', () => {
  const gains = [8, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  assert.equal(effectivePreamp(gains, true, -2), -8)
  assert.equal(effectivePreamp(gains, false, -2), -2)
  assert.equal(effectivePreamp(gains, false, -99), -12)
})

test('the preamp spec and its live value are the A03 forms', () => {
  assert.equal(preampSpec(-6), 'lavfi=[volume=volume=-6dB:precision=float]')
  assert.equal(preampValue(-6), '-6dB')
  assert.equal(preampValue(0), '0dB')
  assert.equal(preampValue(-4.5), '-4.5dB')
  // precision=float is not decoration: it is what stops the preamp
  // requantising the sample format on the way through.
  assert.ok(preampSpec(0).includes('precision=float'))
})

// --- presets (A02) ---------------------------------------------------------

test('every built-in preset is ten in-range bands', () => {
  assert.ok(BUILT_IN_PRESETS.length >= 3)
  for (const p of BUILT_IN_PRESETS) {
    assert.equal(p.gains.length, BAND_COUNT, p.id)
    assert.equal(p.builtIn, true, p.id)
    for (const g of p.gains) assert.ok(Math.abs(g) <= 12, `${p.id}: ${g}`)
  }
  assert.equal(isFlat(findPreset(BUILT_IN_PRESETS, 'flat')?.gains ?? [1]), true)
  assert.equal(isFlat(findPreset(BUILT_IN_PRESETS, 'voice')?.gains ?? []), false)
})

test('a broken preset file costs one row, not the file', () => {
  const text = JSON.stringify([
    { name: 'good', gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: '', gains: [1] },
    { name: 'no gains' },
    { gains: [1, 2] },
    'not an object',
    { name: 'good', gains: [0] },
    { name: 'short', gains: [3, 3] },
    { name: 'loud', gains: [99, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
  ])
  const parsed = parsePresetFile(text)
  assert.deepEqual(parsed.map((p) => p.id), ['good', 'short', 'loud'])
  assert.deepEqual(parsed[1]?.gains, [3, 3, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(parsed[2]?.gains[0], 12)
  assert.deepEqual(parsePresetFile('{ not json'), [])
  assert.deepEqual(parsePresetFile('{"name":"x"}'), [])
})

test('a user preset overriding a built-in keeps its place and stays the user’s', () => {
  const user = parsePresetFile(
    JSON.stringify([
      { name: 'voice', gains: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      { name: 'mine', gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    ])
  )
  const merged = mergePresets(BUILT_IN_PRESETS, user)
  const voice = findPreset(merged, 'voice')
  assert.equal(voice?.gains[0], 1)
  // It stays builtIn:false, so the next save writes it back to the file
  // instead of silently dropping it.
  assert.equal(voice?.builtIn, false)
  assert.equal(merged.indexOf(voice!), BUILT_IN_PRESETS.findIndex((p) => p.id === 'voice'))
  assert.equal(findPreset(merged, 'mine')?.builtIn, false)
  assert.equal(merged.length, BUILT_IN_PRESETS.length + 1)

  const written = JSON.parse(serialisePresetFile(merged)) as Array<{ name: string }>
  assert.deepEqual(written.map((p) => p.name), ['voice', 'mine'])
})

test('the current preset is derived from the gains, never stored', () => {
  const bass = findPreset(BUILT_IN_PRESETS, 'bass')
  assert.equal(findPresetByGains(BUILT_IN_PRESETS, bass?.gains ?? [])?.id, 'bass')
  assert.equal(findPresetByGains(BUILT_IN_PRESETS, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), null)
  assert.equal(findPresetByGains(BUILT_IN_PRESETS, flatGains())?.id, 'flat')
})

test('nextPreset cycles and starts a hand-shaped curve at the first entry', () => {
  const flat = findPresetByGains(BUILT_IN_PRESETS, flatGains())
  assert.equal(nextPreset(BUILT_IN_PRESETS, flat?.gains ?? [])?.id, BUILT_IN_PRESETS[1]?.id)
  const last = BUILT_IN_PRESETS[BUILT_IN_PRESETS.length - 1]
  assert.equal(nextPreset(BUILT_IN_PRESETS, last?.gains ?? [])?.id, BUILT_IN_PRESETS[0]?.id)
  assert.equal(nextPreset(BUILT_IN_PRESETS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])?.id, BUILT_IN_PRESETS[0]?.id)
  assert.equal(nextPreset([], flatGains()), null)
})
