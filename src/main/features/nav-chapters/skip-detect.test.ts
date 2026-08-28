import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ENDING_DECODE_SEC,
  ENGINE_APPLIED_OPTIONS,
  INTRO_DECODE_SEC,
  decodeArgs,
  decodeRegion,
  detectWindows,
  type DetectDeps
} from './skip-detect.ts'
import type { SecondaryEngine, SecondaryEngineOptions } from '@shared/feature-api'

/**
 * Tier 3's ORCHESTRATION, against a fake engine that writes the WAV the real mpv
 * would write.
 *
 * What this can prove: the spawn line, that the decode is unpaused, that the wait
 * ends on the file rather than on a reply, that a cancel yields nothing, that the
 * temp WAV is deleted, that the engine is closed on every path including a throw,
 * and that the correlated result carries the right absolute times.
 *
 * What it cannot prove, and nothing in this repo can without a desktop session:
 * that the pinned mpv writes that WAV for those arguments. `decodeArgs` is
 * exported precisely so the list is printable and reviewable, and the feature is
 * behind an opt-in setting and an explicit command until someone has run it.
 */

const SR = 8000
const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rlplayer-skip-detect-'))

// --- the same broadband generator the fingerprint test uses ----------------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function musicish(seconds: number, seed: number): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const r = rng(seed)
  const partials = Array.from({ length: 64 }, (_, k) => ({
    f: 190 + (3300 * (k + r() * 0.9)) / 64,
    p: r() * 6.283,
    m: 0.15 + r() * 1.5,
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
    out[i] = (v / 32) * 0.4
  }
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

function wavBytes(mono: Float32Array): Uint8Array {
  const dataBytes = mono.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SR, true)
  view.setUint32(28, SR * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < mono.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, (mono[i] as number) * 32767)), true)
  }
  return bytes
}

// --- the fake engine ------------------------------------------------------

interface FakeSpawn {
  opts: SecondaryEngineOptions
  commands: unknown[][]
  closed: boolean
}

interface FakeOptions {
  /** What PCM to write for each spawn, in order. `null` writes nothing. */
  audio: Array<Float32Array | null>
  duration?: number
  /** Throw from spawn() on the nth call (0-based). */
  throwOn?: number
  /** Report `duration` only after this many getProperty calls. */
  durationAfter?: number
}

function fakeEngineFactory(o: FakeOptions): {
  spawn: DetectDeps['spawn']
  spawns: FakeSpawn[]
} {
  const spawns: FakeSpawn[] = []
  let call = 0
  const spawn = async (opts: SecondaryEngineOptions): Promise<SecondaryEngine> => {
    const n = call++
    if (o.throwOn === n) throw new Error('mpv would not start')
    const rec: FakeSpawn = { opts, commands: [], closed: false }
    spawns.push(rec)
    const outArg = (opts.args ?? []).find((a) => a.startsWith('--ao-pcm-file='))
    const out = outArg === undefined ? null : outArg.slice('--ao-pcm-file='.length)
    let endCb: ((msg: Record<string, unknown>) => void) | null = null
    let asks = 0
    let unpaused = false
    const engine: SecondaryEngine = {
      pid: 4242 + n,
      running: true,
      async command<T>(args: unknown[]): Promise<T> {
        rec.commands.push(args)
        // The REAL mpv writes nothing until it is unpaused, and the wait loop
        // must not be satisfied before that happens.
        if (Array.isArray(args) && args[0] === 'set' && args[1] === 'pause' && args[2] === 'no') {
          unpaused = true
          const pcm = o.audio[n]
          if (out !== null && pcm) fs.writeFileSync(out, wavBytes(pcm))
          endCb?.({ event: 'end-file', reason: 'eof' })
        }
        return undefined as T
      },
      async getProperty<T>(name: string): Promise<T> {
        asks++
        if (name !== 'duration') return undefined as T
        if (o.durationAfter !== undefined && asks <= o.durationAfter) {
          throw new Error('property unavailable')
        }
        return (o.duration ?? 1200) as unknown as T
      },
      onEvent(event: string, cb: (msg: Record<string, unknown>) => void) {
        if (event === 'end-file') endCb = cb
        return (): void => {
          endCb = null
        }
      },
      async close(): Promise<void> {
        rec.closed = true
        assert.ok(unpaused || o.audio[n] === null, 'closed a decode that was never unpaused')
      }
    }
    return engine
  }
  return { spawn, spawns }
}

const deps = (
  spawn: DetectDeps['spawn'],
  jobDir: string,
  over: Partial<DetectDeps> = {}
): DetectDeps => ({
  spawn,
  jobDir,
  log: { info: () => {}, warn: () => {} },
  timeoutMs: 2000,
  pollMs: 1,
  ...over
})

const dir = (name: string): string => {
  const p = path.join(jobRoot, name)
  fs.mkdirSync(p, { recursive: true })
  return p
}

// ---------------------------------------------------------------------------
// decodeArgs -- the part that needs the binary, made reviewable
// ---------------------------------------------------------------------------

test('decodeArgs: the intro region starts at 0 and is length-bounded', () => {
  const args = decodeArgs({
    file: 'D:\\Anime\\Show\\ep1.mkv',
    region: 'intro',
    outputFile: 'C:\\job\\a.wav',
    seconds: INTRO_DECODE_SEC
  })
  assert.ok(args.includes('--start=0'))
  assert.ok(args.includes(`--length=${INTRO_DECODE_SEC}`))
  assert.ok(args.includes('--ao=pcm'))
  assert.ok(args.includes('--ao-pcm-file=C:\\job\\a.wav'))
  assert.ok(args.includes('--audio-samplerate=8000'), 'the fingerprint assumes 8 kHz')
  assert.ok(args.includes('--audio-channels=mono'))
  assert.ok(args.includes('--no-video'))
  assert.ok(args.includes('--pause=yes'), 'duration is read before the decode runs')
})

test('decodeArgs: the ending region uses --start=-N, so no probe spawn is needed', () => {
  const args = decodeArgs({
    file: 'x.mkv',
    region: 'ending',
    outputFile: 'o.wav',
    seconds: ENDING_DECODE_SEC
  })
  assert.ok(args.includes(`--start=-${ENDING_DECODE_SEC}`))
  assert.ok(args.includes(`--length=${ENDING_DECODE_SEC}`))
})

test('decodeArgs ends with `--` then the file, so a name starting with - is a file', () => {
  const args = decodeArgs({
    file: '-weird name.mkv',
    region: 'intro',
    outputFile: 'o.wav',
    seconds: 90
  })
  assert.equal(args[args.length - 2], '--')
  assert.equal(args[args.length - 1], '-weird name.mkv')
})

test('decodeArgs re-states nothing ctx.engine.spawn() already applies', () => {
  // A duplicate is not an mpv error; it is a silent last-one-wins between an
  // option you can see and one you cannot.
  const names = decodeArgs({ file: 'x.mkv', region: 'intro', outputFile: 'o.wav', seconds: 90 })
    .filter((a) => a.startsWith('--') && a !== '--')
    .map((a) => a.split('=')[0] as string)
  const clash = names.filter((n) => ENGINE_APPLIED_OPTIONS.includes(n))
  assert.deepEqual(clash, [])
  assert.equal(new Set(names).size, names.length, 'and no option appears twice')
})

// ---------------------------------------------------------------------------
// decodeRegion
// ---------------------------------------------------------------------------

test('decodeRegion unpauses, waits for the FILE, and reports the region offset', async () => {
  const jobDir = dir('one')
  const { spawn, spawns } = fakeEngineFactory({ audio: [musicish(3, 1)], duration: 1200 })
  const r = await decodeRegion(deps(spawn, jobDir), 'D:\\S\\ep1.mkv', 'ending', 0)
  assert.ok(r, 'no region came back')
  assert.equal(r.sampleRate, SR)
  assert.equal(r.duration, 1200)
  // The ending region begins `duration - ENDING_DECODE_SEC` into the file, and
  // that number is what every absolute time downstream is measured from.
  assert.equal(r.startSec, 1200 - ENDING_DECODE_SEC)
  assert.equal(r.mono.length, 3 * SR)
  assert.deepEqual(spawns[0]?.commands, [['set', 'pause', 'no']])
  assert.equal(spawns[0]?.closed, true)
  assert.equal(spawns[0]?.opts.purpose, 'skip-detect')
  // The scratch WAV does not survive the call.
  assert.deepEqual(fs.readdirSync(jobDir), [])
})

test('decodeRegion clamps startSec to 0 when the file is shorter than the region', async () => {
  const { spawn } = fakeEngineFactory({ audio: [musicish(2, 1)], duration: 30 })
  const r = await decodeRegion(deps(spawn, dir('short')), 'ep.mkv', 'ending', 0)
  assert.equal(r?.startSec, 0)
})

test('decodeRegion tolerates a duration that is not there yet', async () => {
  const { spawn } = fakeEngineFactory({ audio: [musicish(2, 1)], duration: 900, durationAfter: 3 })
  const r = await decodeRegion(deps(spawn, dir('late')), 'ep.mkv', 'intro', 0)
  assert.equal(r?.duration, 900)
  assert.equal(r?.startSec, 0)
})

test('decodeRegion returns null and still closes the engine when no PCM appears', async () => {
  const jobDir = dir('empty')
  const { spawn, spawns } = fakeEngineFactory({ audio: [null] })
  const r = await decodeRegion(
    deps(spawn, jobDir, { timeoutMs: 30, pollMs: 1 }),
    'ep.mkv',
    'intro',
    0
  )
  assert.equal(r, null)
  assert.equal(spawns[0]?.closed, true)
})

test('decodeRegion returns null when spawn throws, and does not leave a file behind', async () => {
  const jobDir = dir('throws')
  const { spawn, spawns } = fakeEngineFactory({ audio: [musicish(1, 1)], throwOn: 0 })
  const r = await decodeRegion(deps(spawn, jobDir), 'ep.mkv', 'intro', 0)
  assert.equal(r, null)
  assert.equal(spawns.length, 0)
  assert.deepEqual(fs.readdirSync(jobDir), [])
})

test('a cancelled decode yields NOTHING, not a fingerprint of a partial file', async () => {
  const jobDir = dir('cancel')
  const { spawn } = fakeEngineFactory({ audio: [musicish(3, 1)] })
  const r = await decodeRegion(
    deps(spawn, jobDir, { cancelled: () => true }),
    'ep.mkv',
    'intro',
    0
  )
  assert.equal(r, null)
})

// ---------------------------------------------------------------------------
// detectWindows
// ---------------------------------------------------------------------------

test('detectWindows recovers the planted OP as an absolute intro window', async () => {
  // The reference episode has a 5 s cold open then a 20 s OP; the sibling has a
  // 12 s cold open then the same OP. The proposal must be about the REFERENCE.
  const op = musicish(20, 99)
  const a = concat(musicish(5, 1), op, musicish(5, 2))
  const b = concat(musicish(12, 3), op, musicish(5, 4))
  const { spawn, spawns } = fakeEngineFactory({ audio: [a, b], duration: 1200 })
  const result = await detectWindows(deps(spawn, dir('intro-pair')), 'ep1.mkv', 'ep2.mkv', ['intro'])
  assert.equal(spawns.length, 2, 'two siblings, two spawns')
  assert.deepEqual(result.compared, ['ep1.mkv', 'ep2.mkv'])
  assert.equal(result.ending, null)
  const intro = result.intro
  assert.ok(intro, 'the planted 30 s OP was not proposed')
  assert.ok(Math.abs(intro.start - 5) < 1.0, `start ${intro.start.toFixed(2)}, expected ~5`)
  assert.ok(Math.abs(intro.end - 25) < 1.5, `end ${intro.end.toFixed(2)}, expected ~25`)
  assert.equal(intro.lead, undefined, 'an intro carries no lead')
})

test('detectWindows turns an ending run into a LEAD measured from the reference duration', async () => {
  // Both files carry the same 20 s ED, and the decoded region begins at
  // duration - 120 = 1080 s (the region OFFSET comes from `duration`, not from
  // how many seconds of PCM the fake wrote).
  const ed = musicish(20, 77)
  const a = concat(musicish(10, 5), ed, musicish(10, 6))
  const b = concat(musicish(15, 7), ed, musicish(10, 8))
  const { spawn } = fakeEngineFactory({ audio: [a, b], duration: 1200 })
  const result = await detectWindows(deps(spawn, dir('end-pair')), 'ep1.mkv', 'ep2.mkv', ['ending'])
  assert.equal(result.intro, null)
  const ending = result.ending
  assert.ok(ending, 'the planted 40 s ED was not proposed')
  // 1080 + 10 = 1090 absolute, so a lead of ~110 s.
  assert.ok(Math.abs(ending.start - 1090) < 1.5, `start ${ending.start.toFixed(1)}`)
  assert.ok(Math.abs((ending.lead ?? 0) - 110) < 1.5, `lead ${String(ending.lead)}`)
})

test('detectWindows proposes NOTHING for two unrelated episodes', async () => {
  const { spawn } = fakeEngineFactory({
    audio: [musicish(25, 301), musicish(25, 302)],
    duration: 1200
  })
  const result = await detectWindows(deps(spawn, dir('unrelated')), 'a.mkv', 'b.mkv')
  assert.equal(result.intro, null)
  assert.equal(result.ending, null)
})

test('detectWindows stops after the reference fails to decode, without spawning the sibling', async () => {
  const { spawn, spawns } = fakeEngineFactory({ audio: [null, musicish(20, 9)] })
  const result = await detectWindows(
    deps(spawn, dir('halfdead'), { timeoutMs: 30, pollMs: 1 }),
    'a.mkv',
    'b.mkv',
    ['intro']
  )
  assert.equal(result.intro, null)
  assert.equal(spawns.length, 1, 'a second decode of a comparison that cannot happen is waste')
})

test('detectWindows returns nothing at all when cancelled before it starts', async () => {
  const { spawn, spawns } = fakeEngineFactory({ audio: [musicish(5, 1), musicish(5, 2)] })
  const result = await detectWindows(
    deps(spawn, dir('precancel'), { cancelled: () => true }),
    'a.mkv',
    'b.mkv'
  )
  assert.equal(result.intro, null)
  assert.equal(result.ending, null)
  assert.equal(spawns.length, 0)
})

test('detectWindows never returns a stored window, only a proposal', async () => {
  const op = musicish(20, 99)
  const { spawn } = fakeEngineFactory({
    audio: [concat(musicish(5, 1), op), concat(musicish(8, 3), op)],
    duration: 1200
  })
  const result = await detectWindows(deps(spawn, dir('shape')), 'a.mkv', 'b.mkv', ['intro'])
  const asRecord = result.intro as unknown as Record<string, unknown>
  assert.ok(asRecord)
  // D-11's fence, as a property of the value: nothing here can be written to
  // skip.json without going through applyProposal(), which needs a `source`.
  assert.equal(asRecord['source'], undefined)
  assert.equal(asRecord['introEnd'], undefined)
  assert.equal(asRecord['updatedAt'], undefined)
})
