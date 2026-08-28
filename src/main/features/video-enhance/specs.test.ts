import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DENOISE_DEFAULTS,
  SHARPEN_DEFAULTS,
  amount,
  denoiseLiveOptions,
  denoiseSpec,
  level,
  sharpenLiveOption,
  sharpenSpec
} from './specs.ts'

/**
 * The §2.1 mappings were measured against the pinned mpv over JSON IPC, and a
 * unit test that only compares this module against a string typed in this file
 * proves the two agree with each other — which is exactly the failure mode the
 * audit rounds kept finding. So the spec strings are asserted against the ROW
 * IN `00-parity-spec.md` that carries the measurement: if either drifts, this
 * fails and names which.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const specLines = fs
  .readFileSync(path.join(repo, 'docs', 'parity', '00-parity-spec.md'), 'utf8')
  .split(/\r?\n/)

/** The one table row whose first cell is exactly this feature id. */
function specRow(id: string): string {
  const rows = specLines.filter((l) => l.split('|')[1]?.trim() === id)
  assert.equal(rows.length, 1, `expected exactly one ${id} row in the spec, found ${rows.length}`)
  return rows[0] as string
}

test('the spec rows this module implements are still in the spec', () => {
  // Guards the guard: if the extraction above silently matched nothing, every
  // assertion below would pass vacuously.
  for (const id of ['V08', 'V09', 'V11', 'V15']) {
    assert.ok(specRow(id).includes('M03'), `${id} is no longer M03's`)
  }
})

test('V09: the CAS default is the spec row, character for character', () => {
  const spec = sharpenSpec({ ...SHARPEN_DEFAULTS, mode: 'cas' })
  assert.equal(spec, 'lavfi=[cas=strength=0.4]')
  assert.ok(
    specRow('V09').includes(`@rl-sharpen:${spec}`),
    `V09's row no longer contains @rl-sharpen:${spec}`
  )
})

test('V08: the classic unsharp default is the spec row, character for character', () => {
  const spec = sharpenSpec({ ...SHARPEN_DEFAULTS, mode: 'unsharp' })
  assert.equal(
    spec,
    'lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1.0:' +
      'chroma_msize_x=5:chroma_msize_y=5:chroma_amount=0.0]'
  )
  assert.ok(
    specRow('V08').includes(`@rl-sharpen:${spec}`),
    `V08's row no longer contains @rl-sharpen:${spec}`
  )
})

test('V11: the hqdn3d default is the spec row, character for character', () => {
  const spec = denoiseSpec(DENOISE_DEFAULTS)
  assert.equal(spec, 'lavfi=[hqdn3d=4:3:6:4.5]')
  assert.ok(
    specRow('V11').includes(`@rl-denoise:${spec}`),
    `V11's row no longer contains @rl-denoise:${spec}`
  )
})

test('V09: the live payload is the measured FOUR-argument form', () => {
  // The three-argument form returns `error running command` on both sides, so
  // the arity is asserted against the exact JSON the spec row quotes.
  const live = sharpenLiveOption({ ...SHARPEN_DEFAULTS, mode: 'cas', strength: 0.55 }, 'strength')
  assert.ok(live)
  const wire = ['vf-command', 'rl-sharpen', live.option, live.value, live.filter]
  assert.equal(wire.length, 5, 'command name plus FOUR arguments')
  assert.equal(live.filter, 'cas', 'the last argument is the lavfi FILTER name, not the label')
  assert.ok(
    specRow('V09').includes(JSON.stringify(wire)),
    `V09's row no longer quotes ${JSON.stringify(wire)}`
  )
})

test('the sharpen knobs of the mode that is NOT selected send nothing', () => {
  const cas = { ...SHARPEN_DEFAULTS, mode: 'cas' as const }
  assert.equal(sharpenLiveOption(cas, 'lumaAmount'), undefined)
  assert.equal(sharpenLiveOption(cas, 'chromaAmount'), undefined)
  const unsharp = { ...SHARPEN_DEFAULTS, mode: 'unsharp' as const }
  assert.equal(sharpenLiveOption(unsharp, 'strength'), undefined)
  assert.equal(sharpenLiveOption(unsharp, 'lumaAmount')?.option, 'luma_amount')
  assert.equal(sharpenLiveOption(unsharp, 'chromaAmount')?.option, 'chroma_amount')
  // The refuser table is core's, not this module's: unsharp still gets a
  // payload, and chain-sync learns the refusal from the path core reports.
  assert.equal(sharpenLiveOption(unsharp, 'lumaAmount')?.filter, 'unsharp')
})

test('V11: chroma_tmp tracks luma_tmp at three quarters', () => {
  assert.equal(denoiseSpec({ luma: 4, chroma: 3, time: 8 }), 'lavfi=[hqdn3d=4:3:8:6]')
  assert.equal(denoiseSpec({ luma: 0, chroma: 0, time: 0 }), 'lavfi=[hqdn3d=0:0:0:0]')
  assert.equal(denoiseSpec({ luma: 2.5, chroma: 1.5, time: 3 }), 'lavfi=[hqdn3d=2.5:1.5:3:2.25]')
})

test('the Time knob is two options, because a single one leaves chroma behind', () => {
  const opts = denoiseLiveOptions({ ...DENOISE_DEFAULTS, time: 8 }, 'time')
  assert.deepEqual(
    opts.map((o) => [o.option, o.value, o.filter]),
    [
      ['luma_tmp', '8', 'hqdn3d'],
      ['chroma_tmp', '6', 'hqdn3d']
    ]
  )
  assert.deepEqual(
    denoiseLiveOptions(DENOISE_DEFAULTS, 'luma').map((o) => o.option),
    ['luma_spatial']
  )
})

test('out-of-range and non-finite values fall back instead of writing junk', () => {
  // A spec string with `NaN` in it is a filter mpv refuses to load, and its
  // answer is a log line rather than an exception.
  assert.equal(sharpenSpec({ ...SHARPEN_DEFAULTS, mode: 'cas', strength: 9 }), 'lavfi=[cas=strength=1.0]')
  assert.equal(
    sharpenSpec({ ...SHARPEN_DEFAULTS, mode: 'cas', strength: Number.NaN }),
    'lavfi=[cas=strength=0.4]'
  )
  assert.equal(denoiseSpec({ luma: 99, chroma: -5, time: 99 }), 'lavfi=[hqdn3d=10:0:15:11.25]')
})

test('the two number formats are the ones the measured literals use', () => {
  // hqdn3d's literal is `4:3:6:4.5` (no trailing .0); cas and unsharp are
  // written with a decimal place.
  assert.equal(level(4), '4')
  assert.equal(level(4.5), '4.5')
  assert.equal(level(2.25), '2.25')
  assert.equal(amount(1), '1.0')
  assert.equal(amount(0), '0.0')
  assert.equal(amount(0.55), '0.55')
  assert.equal(amount(-2), '-2.0')
})
