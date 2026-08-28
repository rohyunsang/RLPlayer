import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Thumbnailer } from './thumbnailer.ts'
import { frameBytes, type ThumbGeometry } from './thumb-core.ts'
import type { EngineService, Logger, SecondaryEngine } from '@shared/feature-api'

/**
 * THE TEST THIS FILE EXISTS FOR is `a frame written before the seek is never
 * returned`.
 *
 * §2.6's N36 row gives the read side as `rm(dst); rename(out, dst); accept only
 * if size === W*H*4`. Measured against the pinned mpv, that returns the PREVIOUS
 * frame on every call: asking for the same timestamp twice in a row produced two
 * different images (t=40 -> black, then t=40 -> the real frame), because the
 * first read picked up the `--start=` frame that was already sitting at the
 * output path. The size check cannot see it — a stale frame is also exactly
 * W*H*4 bytes, which is why the check reads as sufficient.
 *
 * The fake engine below reproduces exactly that shape: a frame is already at the
 * output path before anything is asked for, and the answer to a seek appears
 * only after a delay. A reader in the spec's order returns the stale bytes and
 * fails here.
 */

const GEOMETRY: ThumbGeometry = { width: 8, height: 4 }
const BYTES = frameBytes(GEOMETRY)

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function frameOf(marker: number): Buffer {
  return Buffer.alloc(BYTES, marker)
}

interface FakeState {
  spawns: number
  closes: number
  args: string[]
  seeks: Array<{ time: number; flags: string }>
}

/**
 * An mpv that behaves the way the measured one does: it holds a frame at the
 * output path from `--start=`, and it answers a seek by rewriting that same path
 * `writeDelayMs` later (`--ofopts=update=1`).
 */
function fakeEngine(
  outputFile: string,
  opts: { writeDelayMs?: number; answer?: (t: number) => number | null } = {}
): { engine: EngineService; state: FakeState } {
  const state: FakeState = { spawns: 0, closes: 0, args: [], seeks: [] }
  const engine: EngineService = {
    binaryPath: () => 'mpv.exe',
    async spawn(o): Promise<SecondaryEngine> {
      state.spawns++
      state.args = [...(o.args ?? [])]
      // The `--start=` frame, sitting at the output path before any seek. This
      // single line is what the spec's read order trips over.
      fs.writeFileSync(outputFile, frameOf(0))
      let closed = false
      return {
        get pid(): number | null {
          return closed ? null : 4242
        },
        get running(): boolean {
          return !closed
        },
        async command<T>(args: unknown[]): Promise<T> {
          const [prefix, verb, time, flags] = args as [string, string, number, string]
          assert.equal(prefix, 'async', 'the spec mapping is the async prefix form')
          assert.equal(verb, 'seek')
          state.seeks.push({ time, flags })
          const marker = opts.answer ? opts.answer(time) : Math.max(1, Math.round(time))
          if (marker !== null) {
            setTimeout(() => {
              if (!closed) fs.writeFileSync(outputFile, frameOf(marker))
            }, opts.writeDelayMs ?? 15)
          }
          // Measured: the reply arrives in 0-1 ms for BOTH the async and the
          // plain form, so it is never a completion signal.
          return undefined as T
        },
        async getProperty<T>(): Promise<T> {
          return undefined as T
        },
        onEvent(): () => void {
          return () => {}
        },
        async close(): Promise<void> {
          closed = true
          state.closes++
        }
      }
    }
  }
  return { engine, state }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rl-thumb-test-'))
}

function make(
  dir: string,
  opts: Parameters<typeof fakeEngine>[1] = {},
  extra: { frameTimeoutMs?: number } = {}
): { t: Thumbnailer; state: FakeState; outputFile: string } {
  const outputFile = path.join(dir, 'hover.bgra.out')
  const { engine, state } = fakeEngine(outputFile, opts)
  const t = new Thumbnailer({
    engine,
    log: silent,
    file: path.join(dir, 'movie.mkv'),
    geometry: GEOMETRY,
    outputFile,
    pollIntervalMs: 2,
    frameTimeoutMs: extra.frameTimeoutMs ?? 800
  })
  return { t, state, outputFile }
}

test('a frame written BEFORE the seek is never returned', async () => {
  const dir = tempDir()
  const { t } = make(dir, { writeDelayMs: 40 })
  try {
    const first = await t.grab(40, false)
    assert.ok(first, 'a frame was produced')
    assert.notEqual(first?.[0], 0, 'the --start= frame must not be served as the answer to a seek')
    assert.equal(first?.[0], 40)
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the same timestamp twice gives the same pixels', async () => {
  // The measured proof, as a fixture. In the spec's read order these two calls
  // returned different images, which is the whole bug: the preview lags one
  // hover position behind and nothing about it looks wrong in a log.
  const dir = tempDir()
  const { t } = make(dir, { writeDelayMs: 25 })
  try {
    const a = await t.grab(40, false)
    const b = await t.grab(40, false)
    assert.ok(a && b)
    assert.deepEqual([...(a as Uint8Array)], [...(b as Uint8Array)])
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('alternating timestamps never cross over', async () => {
  const dir = tempDir()
  const { t } = make(dir, { writeDelayMs: 10 })
  try {
    for (const time of [40, 150, 40, 150, 40]) {
      const f = await t.grab(time, false)
      assert.equal(f?.[0], time === 40 ? 40 : 150, `t=${time}`)
    }
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the process is not spawned until the first hover', async () => {
  const dir = tempDir()
  const { t, state } = make(dir)
  try {
    assert.equal(t.spawned, false)
    assert.equal(state.spawns, 0)
    await t.grab(10, false)
    assert.equal(state.spawns, 1)
    await t.grab(20, false)
    assert.equal(state.spawns, 1, 'one process serves every hover on this file')
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the exact upgrade asks mpv for absolute+exact, the moving hover does not', async () => {
  const dir = tempDir()
  const { t, state } = make(dir, { writeDelayMs: 5 })
  try {
    await t.grab(10, false)
    await t.grab(10, true)
    assert.deepEqual(
      state.seeks.map((s) => s.flags),
      ['absolute+keyframes', 'absolute+exact']
    )
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a seek that produces no frame times out with null rather than hanging', async () => {
  const dir = tempDir()
  const { t } = make(dir, { answer: () => null }, { frameTimeoutMs: 60 })
  try {
    assert.equal(await t.grab(10, false), null)
    // …and the instance still works afterwards.
    fs.writeFileSync(path.join(dir, 'hover.bgra.out'), Buffer.alloc(BYTES, 7))
    assert.equal(await t.grab(10, false), null, 'a pre-existing file is still not the answer')
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a short file at the output path is waited out, not returned', async () => {
  const dir = tempDir()
  const outputFile = path.join(dir, 'hover.bgra.out')
  const { engine, state } = fakeEngine(outputFile, { writeDelayMs: 0 })
  void state
  const t = new Thumbnailer({
    engine,
    log: silent,
    file: 'movie.mkv',
    geometry: GEOMETRY,
    outputFile,
    pollIntervalMs: 2,
    frameTimeoutMs: 400
  })
  try {
    // Simulate mpv part-way through writing: the poll must not accept it.
    const partial = setTimeout(() => fs.writeFileSync(outputFile, Buffer.alloc(BYTES - 4, 9)), 1)
    partial.unref?.()
    const f = await t.grab(33, false)
    assert.equal(f?.length, BYTES)
    assert.equal(f?.[0], 33)
  } finally {
    await t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('close() is idempotent, closes the engine and removes both scratch files', async () => {
  const dir = tempDir()
  const { t, state, outputFile } = make(dir, { writeDelayMs: 5 })
  try {
    await t.grab(10, false)
    await t.close()
    await t.close()
    assert.equal(state.closes, 1)
    assert.equal(fs.existsSync(outputFile), false)
    assert.equal(fs.existsSync(`${outputFile}.frame`), false)
    await assert.rejects(() => t.grab(10, false), /closed/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('closing while the spawn is in flight does not leave a live process', async () => {
  // An orphan here is the failure "no orphan mpv on quit" is about, and it is
  // reachable in one keystroke: open a file, hover, close the window.
  const dir = tempDir()
  const outputFile = path.join(dir, 'hover.bgra.out')
  const { engine, state } = fakeEngine(outputFile, { writeDelayMs: 5 })
  const slow: EngineService = {
    binaryPath: () => 'mpv.exe',
    async spawn(o) {
      await new Promise((r) => setTimeout(r, 30))
      return engine.spawn(o)
    }
  }
  const t = new Thumbnailer({
    engine: slow,
    log: silent,
    file: 'movie.mkv',
    geometry: GEOMETRY,
    outputFile,
    pollIntervalMs: 2,
    frameTimeoutMs: 200
  })
  try {
    const grabbing = t.grab(10, false).catch(() => null)
    await t.close()
    await grabbing
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(state.spawns, 1)
    assert.equal(state.closes, 1, 'the engine that arrived after close() was closed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
