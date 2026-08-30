import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BAND_EDGES_HZ,
  DEFAULT_RUN_OPTIONS,
  FRAME_SIZE,
  HOP_SIZE,
  fft,
  fingerprint,
  longestCommonRun,
  parseWav,
  proposeFromRun,
  toMono
} from './skip-fingerprint.ts'

/**
 * Tier 3's arithmetic, against PCM this file builds.
 *
 * The reason every case here plants a KNOWN answer and asserts the recovered
 * number, rather than asserting "a run was found", is that a correlator will
 * always find *something*: the failure mode of this tier is a confident 40-second
 * match between two unrelated files, which is indistinguishable from success
 * unless the test knows where the real answer is.
 */

const SR = 8000

// --- WAV assembly, by hand -------------------------------------------------

interface WavOpts {
  sampleRate?: number
  channels?: number
  bits?: number
  format?: number
  /** Bytes to write into the data chunk's size field, if not the real size. */
  declaredDataSize?: number
  /** Insert a LIST chunk between `fmt ` and `data`. */
  withListChunk?: boolean
  /** Truncate the file after assembling it. */
  truncateTo?: number
}

function buildWav(samples: Int16Array, opts: WavOpts = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? SR
  const channels = opts.channels ?? 1
  const bits = opts.bits ?? 16
  const format = opts.format ?? 1
  const list = opts.withListChunk ? 12 : 0
  const dataBytes = samples.length * 2
  const total = 12 + 8 + 16 + list + 8 + dataBytes
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, total - 8, true)
  tag(8, 'WAVE')
  let o = 12
  tag(o, 'fmt ')
  view.setUint32(o + 4, 16, true)
  view.setUint16(o + 8, format, true)
  view.setUint16(o + 10, channels, true)
  view.setUint32(o + 12, sampleRate, true)
  view.setUint32(o + 16, (sampleRate * channels * bits) / 8, true)
  view.setUint16(o + 20, (channels * bits) / 8, true)
  view.setUint16(o + 22, bits, true)
  o += 24
  if (opts.withListChunk) {
    tag(o, 'LIST')
    view.setUint32(o + 4, 4, true)
    tag(o + 8, 'INFO')
    o += 12
  }
  tag(o, 'data')
  view.setUint32(o + 4, opts.declaredDataSize ?? dataBytes, true)
  o += 8
  for (let i = 0; i < samples.length; i++) view.setInt16(o + i * 2, samples[i] as number, true)
  return opts.truncateTo === undefined ? bytes : bytes.slice(0, opts.truncateTo)
}

// --- signal generators -----------------------------------------------------

/** A deterministic PRNG, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * A "song": 64 partials spread across the whole 200-3400 Hz band the fingerprint
 * looks at, each with its own slow amplitude modulation.
 *
 * BROADBAND ON PURPOSE, and this is a note about testing rather than about
 * music. The first version of this generator used six sine partials, and the
 * planted-run test failed: with six partials, about ten of the sixteen bands
 * hold no signal at all, so their "band i louder than band i+1" bits are decided
 * by whatever noise the test itself added, and 20 s of identical audio scored a
 * mean Hamming distance of 2.2. Measured on the real code, unchanged:
 *
 *   6 partials  + 0.01 noise -> best run 5.1 s, at the WRONG offset (24 s)
 *   64 partials + 0.01 noise -> best run 20.0 s at 3.97 s / 8.96 s, distance 0.4
 *
 * So the failure was in the fixture, not the fingerprint, and a test written the
 * other way round -- loosening `maxDistance` until the six-partial case passed --
 * would have shipped a correlator that matches unrelated files. Real audio fills
 * every band; a fixture that does not is measuring itself.
 */
function musicish(seconds: number, seed: number, amp = 0.4): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const r = rng(seed)
  const partials = Array.from({ length: 64 }, (_, k) => ({
    f: 190 + (3300 * (k + r() * 0.9)) / 64,
    p: r() * 6.283,
    m: 0.15 + r() * 1.5, // modulation rate, in Hz
    mp: r() * 6.283,
    g: 0.4 + r()
  }))
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let v = 0
    for (const q of partials) {
      v +=
        q.g *
        Math.sin(2 * Math.PI * q.f * t + q.p) *
        (0.55 + 0.45 * Math.sin(2 * Math.PI * q.m * t + q.mp))
    }
    out[i] = (v / 32) * amp
  }
  return out
}

function noise(seconds: number, seed: number, amp: number): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const r = rng(seed)
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * amp
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** `a` plus `b`, elementwise, for the length of `a`. */
function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) + (b[i % b.length] as number)
  return out
}

// ---------------------------------------------------------------------------
// parseWav
// ---------------------------------------------------------------------------

test('parseWav reads what mpv ao=pcm writes', () => {
  const pcm = parseWav(buildWav(new Int16Array([1, -1, 300, -300])))
  assert.equal(pcm?.sampleRate, SR)
  assert.equal(pcm?.channels, 1)
  assert.deepEqual([...(pcm?.samples ?? [])], [1, -1, 300, -300])
})

test('parseWav WALKS the chunks, so a LIST between fmt and data does not shift it', () => {
  // A fixed-offset reader (byte 44) returns the LIST bytes as audio here.
  const samples = new Int16Array([1000, -1000, 2000, -2000])
  const pcm = parseWav(buildWav(samples, { withListChunk: true }))
  assert.deepEqual([...(pcm?.samples ?? [])], [1000, -1000, 2000, -2000])
})

test('parseWav clamps a data size larger than the bytes present', () => {
  // The real case: the decode process was killed on the timeout mid-write, so
  // the header promises more than the file holds. A prefix is a usable
  // fingerprint, so this must not be an error.
  const samples = new Int16Array([5, 6, 7, 8, 9, 10])
  const bytes = buildWav(samples, { declaredDataSize: 4096, truncateTo: 12 + 24 + 8 + 6 })
  const pcm = parseWav(bytes)
  assert.equal(pcm?.samples.length, 3)
  assert.deepEqual([...(pcm?.samples ?? [])], [5, 6, 7])
})

test('parseWav refuses what it cannot interpret rather than guessing', () => {
  assert.equal(parseWav(new Uint8Array(10)), null)
  assert.equal(parseWav(new Uint8Array(200)), null, 'zeros are not RIFF')
  assert.equal(parseWav(buildWav(new Int16Array([1, 2]), { bits: 24 })), null)
  assert.equal(parseWav(buildWav(new Int16Array([1, 2]), { format: 3 })), null, 'float PCM')
  // WAVE_FORMAT_EXTENSIBLE carrying 16-bit PCM is accepted.
  assert.ok(parseWav(buildWav(new Int16Array([1, 2]), { format: 0xfffe })))
})

test('toMono averages the channels it is given', () => {
  const pcm = parseWav(buildWav(new Int16Array([32767, -32767, 0, 0]), { channels: 2 }))
  assert.ok(pcm)
  const mono = toMono(pcm)
  assert.equal(mono.length, 2)
  assert.ok(Math.abs(mono[0] as number) < 1e-4, 'L+R cancel')
  assert.equal(mono[1], 0)
})

// ---------------------------------------------------------------------------
// fft
// ---------------------------------------------------------------------------

test('fft puts a bin-centred sine in exactly that bin', () => {
  const n = 1024
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const bin = 40
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n)
  fft(re, im)
  const mag = (k: number): number => Math.hypot(re[k] as number, im[k] as number)
  assert.ok(mag(bin) > n / 4, `expected energy at bin ${bin}, got ${mag(bin)}`)
  assert.ok(mag(bin + 3) < 1e-6, 'and nothing three bins away')
  assert.ok(mag(1) < 1e-6)
})

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

test('fingerprint frames the signal and reports where frame 0 sits in the file', () => {
  const mono = musicish(2, 1)
  const fp = fingerprint(mono, SR, 30)
  assert.equal(fp.hopSec, HOP_SIZE / SR)
  assert.equal(fp.startSec, 30)
  assert.equal(fp.hashes.length, 1 + Math.floor((mono.length - FRAME_SIZE) / HOP_SIZE))
  assert.equal(BAND_EDGES_HZ.length, 17, '17 edges is 16 bands is 15 comparison bits')
})

test('a signal shorter than one frame yields no frames rather than throwing', () => {
  const fp = fingerprint(new Float32Array(100), SR)
  assert.equal(fp.hashes.length, 0)
  assert.equal(longestCommonRun(fp, fingerprint(musicish(1, 2), SR)), null)
})

test('SILENCE IS FLAGGED, not hashed -- otherwise the longest common run is silence', () => {
  const quiet = fingerprint(new Float32Array(SR * 2), SR)
  assert.ok(quiet.silent.length > 0)
  assert.ok([...quiet.silent].every((v) => v === 1))
  // Two unrelated signals that each contain a long silence must NOT correlate
  // through it. This is the measured false 40 s run the header names.
  const a = fingerprint(concat(musicish(3, 11), new Float32Array(SR * 6), musicish(3, 12)), SR)
  const b = fingerprint(concat(musicish(3, 21), new Float32Array(SR * 6), musicish(3, 22)), SR)
  const run = longestCommonRun(a, b, DEFAULT_RUN_OPTIONS)
  const seconds = (run?.frames ?? 0) * a.hopSec
  assert.ok(seconds < 2, `unrelated audio correlated for ${seconds.toFixed(1)}s through silence`)
})

test('the hash survives a level change, which an absolute-energy hash would not', () => {
  const loud = musicish(4, 7, 0.8)
  const soft = new Float32Array(loud.length)
  for (let i = 0; i < loud.length; i++) soft[i] = (loud[i] as number) * 0.35
  const a = fingerprint(loud, SR)
  const b = fingerprint(soft, SR)
  let same = 0
  for (let i = 0; i < a.hashes.length; i++) if (a.hashes[i] === b.hashes[i]) same++
  assert.ok(
    same / a.hashes.length > 0.95,
    `only ${((same / a.hashes.length) * 100).toFixed(0)}% of frames matched after a 3 dB change`
  )
})

// ---------------------------------------------------------------------------
// longestCommonRun -- the planted answer
// ---------------------------------------------------------------------------

test('the shared run is found at the right OFFSET in both files', () => {
  // Episode 1: 4 s cold open, then a 20 s OP.
  // Episode 2: 9 s cold open, then the SAME 20 s OP, plus a different dub bed.
  const op = musicish(20, 99)
  const a = concat(musicish(4, 1), op, musicish(6, 2))
  const b = concat(musicish(9, 3), mix(op, noise(20, 4, 0.01)), musicish(6, 5))
  const fa = fingerprint(a, SR)
  const fb = fingerprint(b, SR)
  const run = longestCommonRun(fa, fb, DEFAULT_RUN_OPTIONS)
  assert.ok(run, 'the planted 20 s run was not found at all')
  const startA = run.aStart * fa.hopSec
  const startB = run.bStart * fb.hopSec
  const seconds = run.frames * fa.hopSec
  assert.ok(Math.abs(startA - 4) < 1.0, `run starts at ${startA.toFixed(2)}s in A, expected ~4`)
  assert.ok(Math.abs(startB - 9) < 1.0, `run starts at ${startB.toFixed(2)}s in B, expected ~9`)
  assert.ok(seconds > 18, `run is ${seconds.toFixed(1)}s, expected ~20`)
  assert.ok(run.meanDistance <= DEFAULT_RUN_OPTIONS.maxDistance)
})

test('two unrelated episodes yield no run worth proposing', () => {
  const a = fingerprint(musicish(30, 41), SR)
  const b = fingerprint(musicish(30, 42), SR)
  const run = longestCommonRun(a, b, DEFAULT_RUN_OPTIONS)
  assert.equal(proposeFromRun('intro', a, run, 1200), null)
})

test('a misalignment beyond maxOffsetFrames is out of reach, and says so by finding nothing', () => {
  const op = musicish(20, 99)
  const a = concat(musicish(1, 1), op)
  // 30 s of lead-in is 469 frames at 8 kHz/512, well past the 240-frame search.
  const b = concat(musicish(31, 3), op)
  const run = longestCommonRun(fingerprint(a, SR), fingerprint(b, SR), DEFAULT_RUN_OPTIONS)
  const seconds = (run?.frames ?? 0) * (HOP_SIZE / SR)
  assert.ok(seconds < 15, `found ${seconds.toFixed(1)}s outside the declared search window`)
})

// ---------------------------------------------------------------------------
// proposeFromRun -- the fence
// ---------------------------------------------------------------------------

test('a short shared run is a channel sting, not an OP, and is refused', () => {
  const fp = fingerprint(musicish(30, 61), SR)
  const short = { aStart: 10, bStart: 12, frames: Math.round(6 / fp.hopSec), meanDistance: 1 }
  assert.equal(proposeFromRun('intro', fp, short, 1200), null)
  const long = { aStart: 10, bStart: 12, frames: Math.round(25 / fp.hopSec), meanDistance: 1 }
  assert.ok(proposeFromRun('intro', fp, long, 1200))
})

test('an intro proposal is refused if the run does not start near the start', () => {
  const fp = fingerprint(musicish(30, 62), SR, 700)
  const run = { aStart: 0, bStart: 0, frames: Math.round(25 / fp.hopSec), meanDistance: 1 }
  assert.equal(proposeFromRun('intro', fp, run, 1200), null, 'a run at 11:40 is not an intro')
})

test('an ending proposal carries a LEAD, computed from the reference duration', () => {
  // The decoded region began 120 s before the end of a 1200 s file.
  const fp = fingerprint(musicish(120, 63), SR, 1080)
  const run = { aStart: 60, bStart: 62, frames: Math.round(40 / fp.hopSec), meanDistance: 1 }
  const p = proposeFromRun('ending', fp, run, 1200)
  assert.equal(p?.kind, 'ending')
  const start = 1080 + 60 * fp.hopSec
  assert.ok(Math.abs((p?.start ?? 0) - start) < 1e-6)
  assert.ok(Math.abs((p?.lead ?? 0) - (1200 - start)) < 1e-6)
})

test('an ending proposal needs a duration, and refuses without one', () => {
  const fp = fingerprint(musicish(120, 64), SR, 0)
  const run = { aStart: 10, bStart: 10, frames: Math.round(40 / fp.hopSec), meanDistance: 1 }
  assert.equal(proposeFromRun('ending', fp, run, 0), null)
})

test('proposeFromRun cannot produce a SkipWindow: the fence is the type, not a rule', () => {
  const fp = fingerprint(musicish(30, 65), SR)
  const run = { aStart: 0, bStart: 0, frames: Math.round(25 / fp.hopSec), meanDistance: 1 }
  const p = proposeFromRun('intro', fp, run, 1200)
  assert.ok(p)
  const asRecord = p as unknown as Record<string, unknown>
  assert.equal(asRecord['source'], undefined)
  assert.equal(asRecord['updatedAt'], undefined)
  assert.equal(asRecord['introEnd'], undefined)
})
