import test from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_ARGS, parseMpvFeatures } from './capability.ts'

/**
 * S33's startup assertion, and the reason it is tested at all: this is a check,
 * and a check that answers "fine" for output it could not read is the failure
 * mode this project keeps finding. `hasUchardet` must be false for every input
 * that is not a positive confirmation.
 */

/** A trimmed copy of the pinned binary's real `-v --version` output. */
const REAL = `mpv v0.41.0-923-g7b8915bc1 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects
 built on Fri Aug  8 00:00:00 2025
libplacebo version: v7.351.0
FFmpeg version: N-121075-g5d38b13af7
FFmpeg library versions:
   libavutil       60.6.100
[cplayer] List of enabled features: cli lua libass libavdevice cplugins iconv uchardet zlib vapoursynth
[cplayer] Exiting... (Quit)
`

test('the real feature line is read, and uchardet is found in it', () => {
  const r = parseMpvFeatures(REAL)
  assert.equal(r.hasUchardet, true)
  assert.equal(r.version, 'v0.41.0-923-g7b8915bc1')
  assert.ok(r.features.includes('libass'))
  assert.ok(r.features.includes('iconv'))
  assert.equal(r.features.includes('nonsense'), false)
})

test('a build WITHOUT uchardet is reported as not having it', () => {
  const without = REAL.replace(' uchardet', '')
  const r = parseMpvFeatures(without)
  assert.equal(r.hasUchardet, false)
  assert.ok(r.features.length > 0, 'the rest of the line must still parse')
})

test('unreadable output reads as "cannot confirm", never as fine', () => {
  for (const bad of ['', 'mpv v0.41.0\n', 'garbage', '[cplayer] List of enabled features:\n']) {
    const r = parseMpvFeatures(bad)
    assert.equal(r.hasUchardet, false, JSON.stringify(bad))
  }
  // A substring must not count: `uchardet-something-else` is not `uchardet`, and
  // more importantly a stray mention anywhere else in the output must not.
  assert.equal(
    parseMpvFeatures('we could not find uchardet anywhere\n').hasUchardet,
    false,
    'prose outside the feature line was accepted as a feature'
  )
  assert.equal(parseMpvFeatures('List of enabled features: uchardetx').hasUchardet, false)
})

test('the version is never undefined, so a log line cannot crash on it', () => {
  assert.equal(parseMpvFeatures('').version, 'unknown')
})

test('the probe args are the ones that actually print the feature list', () => {
  // Measured: `--version` alone prints no feature list at all, and
  // `--msg-level=all=no -v --version` SUPPRESSES it — which is why this cannot
  // go through ctx.engine.spawn(), whose fixed args include exactly that.
  assert.deepEqual([...PROBE_ARGS], ['--no-config', '-v', '--version'])
  assert.ok(!PROBE_ARGS.includes('--msg-level=all=no'))
})
