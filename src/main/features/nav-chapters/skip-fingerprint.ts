/**
 * Tier 3 of N51: the audio-fingerprint proposal, and nothing but arithmetic.
 *
 * §2.5's row and D-11 both put a fence around this tier, and the fence is the
 * important part of the file: it is **opt-in, never automatic, and always
 * proposes rather than applies**. Nothing here writes a `SkipWindow`; the only
 * types it can return are proposals, and the only way a proposal becomes a
 * window is `applyProposal()` in skip-model.ts, called from a toast action the
 * user pressed. "A wrong automatic skip is a worse bug than no skip at all"
 * (D-11) is therefore a property of the type graph and not of a comment.
 *
 * The method is the one the row specifies: decode two siblings at 8 kHz mono,
 * reduce each 128 ms frame to a 16-bit spectral-peak hash, and cross-correlate.
 * An OP or ED is the longest common audio run across two episodes.
 *
 * WHAT IS AND IS NOT VERIFIED. Every function below is exercised in
 * `skip-fingerprint.test.ts` against synthetic PCM built in the test, including
 * the WAV parser (against bytes the test assembles by hand) and the run finder
 * (against a shared segment planted at a known offset with noise on top). What
 * a unit test cannot cover is mpv actually producing the WAV — see
 * `skip-detect.ts`, which says so in its own header rather than here.
 */

export interface WavPcm {
  sampleRate: number
  channels: number
  /** Interleaved 16-bit samples, as written. */
  samples: Int16Array
}

const ascii = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0)

/**
 * A 16-bit PCM RIFF/WAVE file, or null.
 *
 * Chunks are WALKED, not assumed: mpv's `ao=pcm` writes `fmt ` then `data`, but a
 * `LIST`/`INFO` chunk between them is legal WAVE and the fixed-offset reader
 * every example on the internet uses returns garbage for it. A truncated file is
 * also normal here — the process may be killed mid-write on a timeout — so a
 * `data` size larger than what is present is clamped rather than rejected.
 */
export function parseWav(bytes: Uint8Array): WavPcm | null {
  if (bytes.length < 44) return null
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 0
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (bits !== 16 || channels < 1 || sampleRate <= 0) return null
      // WAVE_FORMAT_PCM, or WAVE_FORMAT_EXTENSIBLE carrying PCM.
      if (format !== 1 && format !== 0xfffe) return null
      const available = Math.max(0, bytes.length - body)
      const usable = Math.min(size, available) & ~1
      const samples = new Int16Array(usable / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(body + i * 2, true)
      return { sampleRate, channels, samples }
    }
    // Chunks are word-aligned; an odd size carries a pad byte.
    offset = body + size + (size % 2)
  }
  return null
}

/** Interleaved to mono, by averaging. mpv is asked for mono, so this is a guard. */
export function toMono(pcm: WavPcm): Float32Array {
  const n = Math.floor(pcm.samples.length / pcm.channels)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < pcm.channels; c++) sum += pcm.samples[i * pcm.channels + c] ?? 0
    out[i] = sum / pcm.channels / 32768
  }
  return out
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

/**
 * In-place iterative radix-2 FFT. `re.length` must be a power of two.
 *
 * Written out rather than reached for because the only alternative was a naive
 * DFT over the 400-odd bins the band edges below actually need, which measured
 * at ~600M multiplies for 90 s of audio — enough to stall the main process for
 * seconds during a feature whose whole promise is that it is opt-in and quiet.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k] as number
        const ai = im[i + k] as number
        const br = re[i + k + len / 2] as number
        const bi = im[i + k + len / 2] as number
        const tr = br * cr - bi * ci
        const ti = br * ci + bi * cr
        re[i + k] = ar + tr
        im[i + k] = ai + ti
        re[i + k + len / 2] = ar - tr
        im[i + k + len / 2] = ai - ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export const FRAME_SIZE = 1024
export const HOP_SIZE = 512
/** 17 edges → 16 bands → 16 comparison bits per frame. */
export const BAND_EDGES_HZ: readonly number[] = [
  200, 260, 330, 410, 500, 610, 730, 870, 1030, 1210, 1410, 1640, 1900, 2200, 2540, 2930, 3400
]

export interface Fingerprint {
  /** One 16-bit hash per frame. */
  hashes: Uint16Array
  /** 1 where the frame was below the noise floor and must not count as a match. */
  silent: Uint8Array
  hopSec: number
  /** Where in the ORIGINAL file frame 0 begins. */
  startSec: number
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/**
 * The spectral-peak fingerprint of a mono signal.
 *
 * Bit i is "band i has more energy than band i+1" — a sign-of-difference hash,
 * which is what makes it survive the thing it has to survive: the same OP
 * re-encoded at a different bitrate, or with a 3 dB louder dub over it. An
 * absolute-energy hash matches nothing across two rips of one series.
 *
 * A frame quieter than `silenceFloor` is flagged rather than hashed. Silence
 * hashes to a constant, so without the flag every quiet gap in one episode
 * "matches" every quiet gap in the other and the longest common run becomes the
 * longest common silence — measured on synthetic input in the test as a 40 s
 * false run between two unrelated signals.
 */
export function fingerprint(
  mono: Float32Array,
  sampleRate: number,
  startSec = 0,
  silenceFloor = 1e-5
): Fingerprint {
  const frames = mono.length >= FRAME_SIZE ? 1 + Math.floor((mono.length - FRAME_SIZE) / HOP_SIZE) : 0
  const hashes = new Uint16Array(Math.max(0, frames))
  const silent = new Uint8Array(Math.max(0, frames))
  const window = hann(FRAME_SIZE)
  const re = new Float64Array(FRAME_SIZE)
  const im = new Float64Array(FRAME_SIZE)
  const bands = new Float64Array(BAND_EDGES_HZ.length - 1)
  const binHz = sampleRate / FRAME_SIZE
  for (let f = 0; f < frames; f++) {
    const base = f * HOP_SIZE
    let energy = 0
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = mono[base + i] ?? 0
      energy += s * s
      re[i] = s * (window[i] as number)
      im[i] = 0
    }
    if (energy / FRAME_SIZE < silenceFloor) {
      silent[f] = 1
      continue
    }
    fft(re, im)
    bands.fill(0)
    for (let b = 0; b < bands.length; b++) {
      const lo = Math.max(1, Math.round((BAND_EDGES_HZ[b] as number) / binHz))
      const hi = Math.min(FRAME_SIZE / 2 - 1, Math.round((BAND_EDGES_HZ[b + 1] as number) / binHz))
      let sum = 0
      for (let k = lo; k <= hi; k++) {
        const r = re[k] as number
        const i2 = im[k] as number
        sum += r * r + i2 * i2
      }
      bands[b] = sum
    }
    let h = 0
    for (let b = 0; b + 1 < bands.length; b++) {
      if ((bands[b] as number) > (bands[b + 1] as number)) h |= 1 << b
    }
    hashes[f] = h
  }
  return { hashes, silent, hopSec: HOP_SIZE / sampleRate, startSec }
}

function popcount(v: number): number {
  let x = v - ((v >> 1) & 0x5555)
  x = (x & 0x3333) + ((x >> 2) & 0x3333)
  x = (x + (x >> 4)) & 0x0f0f
  return (x + (x >> 8)) & 0x1f
}

export interface CommonRun {
  /** Frame index in `a` where the shared run starts. */
  aStart: number
  bStart: number
  frames: number
  /** Mean Hamming distance over the run; lower is a better match. */
  meanDistance: number
}

export interface RunOptions {
  /** Frames of misalignment to search either way. */
  maxOffsetFrames: number
  /** A frame pair matches at or below this Hamming distance (0..16). */
  maxDistance: number
  /** Consecutive mismatching frames tolerated inside one run. */
  gapFrames: number
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  maxOffsetFrames: 240,
  maxDistance: 3,
  gapFrames: 3
}

/**
 * The longest run of frames the two fingerprints share, over every alignment.
 *
 * Silent frames on either side break a run rather than extend it (see
 * `fingerprint`). `gapFrames` exists because a single frame of a different dub
 * line over the same OP should not cut one 90 s run into two 45 s ones.
 */
export function longestCommonRun(
  a: Fingerprint,
  b: Fingerprint,
  opts: RunOptions = DEFAULT_RUN_OPTIONS
): CommonRun | null {
  let best: CommonRun | null = null
  const na = a.hashes.length
  const nb = b.hashes.length
  if (na === 0 || nb === 0) return null
  for (let offset = -opts.maxOffsetFrames; offset <= opts.maxOffsetFrames; offset++) {
    let runStart = -1
    let runFrames = 0
    let runSum = 0
    let gap = 0
    const from = Math.max(0, -offset)
    const to = Math.min(na, nb - offset)
    for (let i = from; i < to; i++) {
      const j = i + offset
      const ok =
        a.silent[i] === 0 &&
        b.silent[j] === 0 &&
        popcount(((a.hashes[i] as number) ^ (b.hashes[j] as number)) & 0xffff) <= opts.maxDistance
      if (ok) {
        if (runStart < 0) {
          runStart = i
          runFrames = 0
          runSum = 0
        }
        runFrames += gap + 1
        runSum += popcount(((a.hashes[i] as number) ^ (b.hashes[j] as number)) & 0xffff)
        gap = 0
      } else if (runStart >= 0 && gap < opts.gapFrames) {
        gap++
      } else {
        if (runStart >= 0 && (best === null || runFrames > best.frames)) {
          best = {
            aStart: runStart,
            bStart: runStart + offset,
            frames: runFrames,
            meanDistance: runSum / runFrames
          }
        }
        runStart = -1
        runFrames = 0
        gap = 0
      }
    }
    if (runStart >= 0 && (best === null || runFrames > best.frames)) {
      best = {
        aStart: runStart,
        bStart: runStart + offset,
        frames: runFrames,
        meanDistance: runSum / runFrames
      }
    }
  }
  return best
}

export interface FingerprintProposal {
  kind: 'intro' | 'ending'
  /** Absolute seconds in the reference file. */
  start: number
  end: number
  /** `duration - start`, for an ending. */
  lead?: number
  confidenceFrames: number
}

/**
 * A candidate window from two fingerprints, or null.
 *
 * `minRunSec` is the guard that matters: a 4-second common run is two episodes
 * sharing a channel sting, not an OP, and proposing it would train the user to
 * dismiss the proposal — which is how an opt-in feature becomes noise.
 */
export function proposeFromRun(
  kind: 'intro' | 'ending',
  a: Fingerprint,
  run: CommonRun | null,
  refDuration: number,
  minRunSec = 15
): FingerprintProposal | null {
  if (!run) return null
  const seconds = run.frames * a.hopSec
  if (seconds < minRunSec) return null
  const start = a.startSec + run.aStart * a.hopSec
  const end = start + seconds
  if (kind === 'intro') {
    if (start > 600) return null
    return { kind, start, end, confidenceFrames: run.frames }
  }
  if (!(refDuration > 0) || end <= start) return null
  return { kind, start, end, lead: Math.max(0, refDuration - start), confidenceFrames: run.frames }
}
