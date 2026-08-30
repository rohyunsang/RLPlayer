import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bgraToRgba,
  bucketStep,
  bucketTime,
  conflictsWithEngineArgs,
  DEFAULT_THUMB_WIDTH,
  frameBytes,
  frameKey,
  FrameScheduler,
  LruMap,
  posterArgs,
  thumbnailerArgs,
  thumbSize
} from './thumb-core.ts'

/**
 * M27's pure half. Every number asserted below was read off the pinned mpv
 * (v0.41.0-923-g7b8915bc1) over JSON IPC against `samples/bbb_long.mp4`, not
 * reasoned about: 288x162, 186 624 bytes per frame, alpha 255.
 */

// --- geometry --------------------------------------------------------------

test('the default width reproduces the measured 288x162 frame', () => {
  const g = thumbSize(1920, 1080, DEFAULT_THUMB_WIDTH)
  assert.deepEqual(g, { width: 288, height: 162 })
  assert.equal(frameBytes(g), 186624)
})

test('both dimensions are even, whatever the source aspect', () => {
  for (const [dw, dh] of [
    [1920, 1080],
    [1440, 1080],
    [720, 576],
    [1000, 999],
    [2048, 858]
  ] as const) {
    const g = thumbSize(dw, dh, 288)
    assert.equal(g.width % 2, 0, `${dw}x${dh} width`)
    assert.equal(g.height % 2, 0, `${dw}x${dh} height`)
    assert.ok(g.height >= 2)
  }
})

test('a source with no reported size falls back to 16:9 rather than to zero', () => {
  // §3.3.1: `undefined` is a real value from the bus and is never coerced.
  assert.deepEqual(thumbSize(undefined, undefined, 288), { width: 288, height: 162 })
  assert.deepEqual(thumbSize(0, 0, 288), { width: 288, height: 162 })
})

test('the requested width is clamped, not trusted', () => {
  assert.equal(thumbSize(1920, 1080, 4).width, 160)
  assert.equal(thumbSize(1920, 1080, 4000).width, 480)
})

// --- pixels ----------------------------------------------------------------

test('BGRA becomes RGBA on a copy, alpha untouched', () => {
  const bgra = new Uint8Array([1, 2, 3, 255, 10, 20, 30, 128])
  const rgba = bgraToRgba(bgra)
  assert.deepEqual([...rgba], [3, 2, 1, 255, 30, 20, 10, 128])
  assert.deepEqual([...bgra], [1, 2, 3, 255, 10, 20, 30, 128], 'the source is not mutated')
})

// --- bucketing: the reason a hover does not re-decode -----------------------

test('two hover positions a few pixels apart collapse to one cache entry', () => {
  const duration = 7200 // two hours
  const step = bucketStep(duration)
  // A 1920 px bar over two hours is 3.75 s/px; a 4 px wobble must not decode.
  const a = bucketTime(3600, duration)
  const b = bucketTime(3600 + step / 3, duration)
  assert.equal(a, b)
  assert.notEqual(bucketTime(3600, duration), bucketTime(3600 + step * 1.5, duration))
})

test('buckets are never finer than half a second, however short the file', () => {
  assert.equal(bucketStep(1), 0.5)
  assert.equal(bucketStep(0), 1)
  assert.equal(bucketStep(Number.NaN), 1)
  assert.equal(bucketStep(Number.POSITIVE_INFINITY), 1)
})

test('a hover past either end is clamped into the file', () => {
  assert.equal(bucketTime(-40, 600), 0)
  assert.ok(bucketTime(9999, 600) <= 600 + bucketStep(600))
})

test('the frame key changes when the file or the geometry changes', () => {
  const g = thumbSize(1920, 1080, 288)
  const other = thumbSize(1920, 1080, 320)
  assert.notEqual(frameKey('a.mkv', g, 10), frameKey('b.mkv', g, 10))
  assert.notEqual(frameKey('a.mkv', g, 10), frameKey('a.mkv', other, 10))
  assert.equal(frameKey('a.mkv', g, 10), frameKey('a.mkv', g, 10))
})

// --- LRU -------------------------------------------------------------------

test('the frame cache evicts the least recently USED, not the oldest inserted', () => {
  const lru = new LruMap<number>(3)
  lru.set('a', 1)
  lru.set('b', 2)
  lru.set('c', 3)
  assert.equal(lru.get('a'), 1) // 'a' is now the most recent
  lru.set('d', 4)
  assert.equal(lru.size, 3)
  assert.equal(lru.get('b'), undefined, "'b' was the least recently used")
  assert.equal(lru.get('a'), 1)
})

// --- the spawn line --------------------------------------------------------

test('the thumbnailer never restates an option ctx.engine.spawn() already applies', () => {
  // Not tidiness: a reader of the array has to be able to tell which flags are
  // this module's decision. Core applies --no-config, --idle, --terminal,
  // --msg-level, --load-scripts, --ytdl and --input-ipc-server.
  const args = thumbnailerArgs({
    file: 'C:\\v\\a.mkv',
    geometry: { width: 288, height: 162 },
    outputFile: 'C:\\tmp\\out'
  })
  assert.deepEqual(conflictsWithEngineArgs(args), [])
  assert.deepEqual(conflictsWithEngineArgs(posterArgs({ file: 'a', outputFile: 'b', width: 320 })), [])
})

test('the deprecated spellings that mpv accepts and IGNORES are not used', () => {
  const args = thumbnailerArgs({
    file: 'a.mkv',
    geometry: { width: 288, height: 162 },
    outputFile: 'out'
  }).join(' ')
  // Both wrong spellings are accepted by mpv, do nothing, and look correct in
  // review. That is exactly why they are asserted rather than commented.
  assert.ok(args.includes('--load-console=no'))
  assert.ok(!args.includes('--load-osd-console'))
  assert.ok(args.includes('--hwdec-software-fallback=1'))
  assert.ok(!args.includes('--vd-lavc-software-fallback'))
})

test('the filter chain is the measured one and carries the geometry', () => {
  const args = thumbnailerArgs({
    file: 'a.mkv',
    geometry: { width: 320, height: 180 },
    outputFile: 'out'
  })
  assert.ok(
    args.includes('--vf=scale=w=320:h=180,pad=w=320:h=180:x=-1:y=-1,format=bgra'),
    args.join(' ')
  )
  assert.ok(args.includes('--ovc=rawvideo'))
  assert.ok(args.includes('--of=image2'))
  assert.ok(args.includes('--ofopts=update=1'))
  assert.ok(args.includes('--o=out'))
})

test('the input file is last and behind --, so a leading dash is not an option', () => {
  const args = thumbnailerArgs({
    file: '-weird name.mkv',
    geometry: { width: 288, height: 162 },
    outputFile: 'out'
  })
  assert.equal(args[args.length - 1], '-weird name.mkv')
  assert.equal(args[args.length - 2], '--')
})

test('vid and edition are omitted unless they are real numbers', () => {
  const base = { file: 'a.mkv', geometry: { width: 288, height: 162 }, outputFile: 'out' }
  const none = thumbnailerArgs(base).join(' ')
  assert.ok(!none.includes('--vid='))
  assert.ok(!none.includes('--edition='))
  // `vid` is `false` on an audio-only file and mpv does not accept --vid=false.
  const off = thumbnailerArgs({ ...base, vid: undefined, edition: undefined }).join(' ')
  assert.ok(!off.includes('--vid='))
  const on = thumbnailerArgs({ ...base, vid: 2, edition: 1, videoRotate: 90 }).join(' ')
  assert.ok(on.includes('--vid=2'))
  assert.ok(on.includes('--edition=1'))
  assert.ok(on.includes('--video-rotate=90'))
})

test('the poster line defaults to a percentage start, not to frame zero', () => {
  const auto = posterArgs({ file: 'a.mkv', outputFile: 'o.png', width: 320 })
  assert.ok(auto.includes('--start=10%'), auto.join(' '))
  assert.ok(auto.includes('--frames=1'))
  assert.ok(auto.includes('--ovc=png'))
  const at = posterArgs({ file: 'a.mkv', outputFile: 'o.png', width: 320, timeSec: 42 })
  assert.ok(at.includes('--start=42'))
})

// --- the scheduler ---------------------------------------------------------

test('only one decode runs at a time and only the newest waiting request survives', async () => {
  const started: number[] = []
  // A box rather than a bare `let`: TypeScript narrows a local assigned only
  // inside a callback to `never` at the call site, and `release!()` would hide
  // the very thing the narrowing is about.
  const gate: { release: (() => void) | null } = { release: null }
  const s = new FrameScheduler(async (r) => {
    started.push(r.time)
    await new Promise<void>((res) => {
      gate.release = res
    })
  })

  s.request({ time: 1, exact: false })
  await tick()
  assert.deepEqual(started, [1], 'the first request runs immediately')

  // Four more arrive while the first is still decoding: a hover crossing the
  // bar. Only the last of them may ever run.
  s.request({ time: 2, exact: false })
  s.request({ time: 3, exact: false })
  s.request({ time: 4, exact: false })
  s.request({ time: 5, exact: false })
  assert.deepEqual(s.queued, { time: 5, exact: false })

  gate.release?.()
  await tick()
  assert.deepEqual(started, [1, 5])
  gate.release?.()
  await tick()
  assert.equal(s.busy, false)
})

test('a failed decode does not wedge the loop', async () => {
  const seen: number[] = []
  const errors: number[] = []
  const s = new FrameScheduler(
    async (r) => {
      seen.push(r.time)
      if (r.time === 1) throw new Error('boom')
    },
    (_e, r) => errors.push(r.time)
  )
  s.request({ time: 1, exact: false })
  await tick()
  s.request({ time: 2, exact: false })
  await tick()
  assert.deepEqual(seen, [1, 2])
  assert.deepEqual(errors, [1])
})

test('reset() drops what is waiting, so a file switch does not decode the old file', async () => {
  const seen: number[] = []
  const gate: { release: (() => void) | null } = { release: null }
  const s = new FrameScheduler(async (r) => {
    seen.push(r.time)
    await new Promise<void>((res) => {
      gate.release = res
    })
  })
  s.request({ time: 1, exact: false })
  await tick()
  s.request({ time: 2, exact: false })
  s.reset()
  gate.release?.()
  await tick()
  assert.deepEqual(seen, [1])
})

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5))
}
