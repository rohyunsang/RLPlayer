/**
 * M23 capture-encode — the encode runner, against a fake engine.
 *
 * THE TEST THAT MATTERS MOST IS `the runner finalises before it believes the
 * file`, and it is written to FAIL on the implementation this file replaced.
 * Two measurements shaped it, both taken against the pinned mpv
 * (v0.41.0-923-g7b8915bc1) over JSON IPC, spawned exactly as
 * `ctx.engine.spawn()` spawns:
 *
 *   1. A container is NOT valid when `end-file` arrives. At EOF the WebP was 0
 *      bytes, the MP3 0, the M4A 44 and the GIF 786,432; after `quit` they were
 *      42,742 / 72,768 / 69,603 / 856,011. The trailer — the MP4 `moov` atom,
 *      the Matroska cues — is written as the process shuts down.
 *   2. The previous runner fired `close()` and did NOT await it
 *      (`void engine?.close()` inside a `finally`), then immediately checked
 *      `fs.statSync(out).size > 0`. Against measurement 1 that check reports
 *      success on a file whose trailer is missing, and for the WebP/MP3 cases it
 *      reports "the encoder produced no output" for a job that worked.
 *
 * The fake below reproduces measurement 1 literally: 48 bytes on `end-file`,
 * 15,269 on `close`. A runner that does not await `close()` sees 48 and fails
 * the assertion; this one sees 15,269.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Logger, SecondaryEngine, SecondaryEngineOptions } from '@shared/feature-api'
import type { RunSignal } from './job-queue.ts'
import { probeEncoder, runEncode } from './runner.ts'

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** A `RunSignal` a test can trip by hand. */
function signal(): RunSignal & { cancel(): void } {
  let cancelled = false
  const cbs: Array<() => void> = []
  return {
    get cancelled(): boolean {
      return cancelled
    },
    onCancel(cb): void {
      if (cancelled) cb()
      else cbs.push(cb)
    },
    cancel(): void {
      cancelled = true
      for (const cb of cbs.splice(0)) cb()
    }
  }
}

interface FakeOpts {
  /** What `end-file` reports. `null` means it never arrives. */
  end?: { reason: string; file_error?: string } | null
  /** `time-pos` values pushed before the end. */
  ticks?: number[]
  /** Bytes on disk at `end-file`, then after `close()`. */
  sizes?: [number, number]
  /** Die without an end-file, the way a crash or the idle reaper would. */
  vanish?: boolean
  spawnError?: string
}

interface Fake {
  engine: { spawn(o: SecondaryEngineOptions): Promise<SecondaryEngine>; binaryPath(): string }
  calls: unknown[][]
  spawned: SecondaryEngineOptions[]
  order: string[]
  outputFile: string
  dir: string
}

function fake(opts: FakeOpts = {}): Fake {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-enc-test-'))
  const outputFile = path.join(dir, 'out.mp4')
  const sizes = opts.sizes ?? [0, 1024]
  const calls: unknown[][] = []
  const spawned: SecondaryEngineOptions[] = []
  const order: string[] = []
  const handlers = new Map<string, Array<(m: Record<string, unknown>) => void>>()

  const emit = (event: string, msg: Record<string, unknown>): void => {
    for (const h of handlers.get(event) ?? []) h(msg)
  }
  const write = (bytes: number): void => {
    if (bytes <= 0) return
    fs.writeFileSync(outputFile, Buffer.alloc(bytes))
  }

  let running = true

  const engine: SecondaryEngine = {
    get pid(): number | null {
      return running ? 4242 : null
    },
    get running(): boolean {
      return running
    },
    async command<T>(args: unknown[]): Promise<T> {
      calls.push(args)
      if (args[0] === 'loadfile') {
        // Encoding starts on the reply, exactly as measured.
        setTimeout(() => {
          for (const t of opts.ticks ?? []) {
            emit('property-change', { name: 'time-pos', data: t })
          }
          if (opts.vanish === true) {
            running = false
            return
          }
          if (opts.end === null) return
          write(sizes[0])
          order.push('end-file')
          emit('end-file', (opts.end ?? { reason: 'eof' }) as Record<string, unknown>)
        }, 5)
      }
      return undefined as T
    },
    async getProperty<T>(): Promise<T> {
      return undefined as T
    },
    onEvent(event, cb): () => void {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
      return () => {
        const cur = handlers.get(event) ?? []
        handlers.set(
          event,
          cur.filter((x) => x !== cb)
        )
      }
    },
    async close(): Promise<void> {
      if (!running) return
      running = false
      order.push('close')
      // `quit` is what finalises the container. This is measurement 1.
      write(sizes[1])
    }
  }

  return {
    engine: {
      binaryPath: () => 'mpv.exe',
      async spawn(o): Promise<SecondaryEngine> {
        spawned.push(o)
        if (opts.spawnError !== undefined) throw new Error(opts.spawnError)
        return engine
      }
    },
    calls,
    spawned,
    order,
    outputFile,
    dir
  }
}

const BASE_ARGS = ['--keep-open=no', '--of=mp4', '--ovc=libx264', '--o=out.mp4']

// ---------------------------------------------------------------------------

test('the source is loaded over IPC, after the progress observer is registered', async () => {
  const f = fake({ ticks: [12, 16, 20.5], sizes: [48, 15269] })
  const seen: number[] = []
  const r = await runEncode(
    { engine: f.engine, log: silent },
    {
      purpose: 'encode-clip',
      args: BASE_ARGS,
      source: 'C:/media/Ep 1.mkv',
      outputFile: f.outputFile,
      startSec: 12,
      endSec: 20.5,
      signal: signal(),
      onProgress: (x) => seen.push(x),
      pollMs: 2
    }
  )

  assert.deepEqual(f.calls[0], ['observe_property', 1, 'time-pos'])
  // Three arguments, no `-1`: there is no options map, so §7.7 trap 1 does not
  // apply. Measured returning {"error":"success"}.
  assert.deepEqual(f.calls[1], ['loadfile', 'C:/media/Ep 1.mkv', 'replace'])
  assert.equal(f.calls.length, 2)

  // The fraction is derived from the RANGE, not from the file: --start=12 means
  // time-pos starts at 12 and 12 is 0%.
  assert.deepEqual(seen, [0, 16 / 20.5 === 0 ? 0 : (16 - 12) / 8.5, 1])
  assert.equal(r.output, f.outputFile)
  assert.equal(r.bytes, 15269)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('the runner finalises before it believes the file', async () => {
  // WRITTEN TO FAIL ON THE PREVIOUS IMPLEMENTATION. The fake puts 48 bytes on
  // disk at end-file and 15,269 after close, which is the measured shape of an
  // MP4 whose moov atom has not been written. A runner that checks the file
  // without awaiting close() sees 48 and rejects.
  const f = fake({ sizes: [48, 15269] })
  const verified: string[] = []
  const r = await runEncode(
    { engine: f.engine, log: silent },
    {
      purpose: 'encode-clip',
      args: BASE_ARGS,
      source: 'x.mkv',
      outputFile: f.outputFile,
      startSec: 0,
      endSec: 10,
      signal: signal(),
      onProgress: () => {},
      pollMs: 2,
      verify: () => {
        verified.push('verify')
        f.order.push('verify')
        return fs.statSync(f.outputFile).size > 4096
      }
    }
  )
  assert.deepEqual(f.order, ['end-file', 'close', 'verify'])
  assert.deepEqual(verified, ['verify'])
  assert.equal(r.bytes, 15269)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('an end-file error surfaces mpv\'s own reason and discards the partial file', async () => {
  // The measured string for all three unavailable hardware encoders on this
  // machine. "encode failed" with no cause is what this module must never say.
  const f = fake({
    end: { reason: 'error', file_error: 'video output initialization failed' },
    sizes: [512, 512]
  })
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 10,
        signal: signal(),
        onProgress: () => {},
        pollMs: 2
      }
    ),
    /video output initialization failed/
  )
  // A 512-byte MP4 with no trailer opens in nothing. Leaving it behind next to
  // the user's video is worse than leaving nothing.
  assert.equal(fs.existsSync(f.outputFile), false)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('an unexpected end reason is reported rather than treated as success', async () => {
  const f = fake({ end: { reason: 'unknown-reason' }, sizes: [100, 100] })
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 1,
        signal: signal(),
        onProgress: () => {},
        pollMs: 2
      }
    ),
    /unknown-reason/
  )
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('cancel closes the engine and removes the half-written output', async () => {
  // §6.3's M23 row: "cancel a 5-minute export and confirm the child process is
  // gone from Task Manager". `close()` is that, and it is the only thing that
  // is: the module never holds the child.
  const f = fake({ end: null, sizes: [4096, 4096] })
  const sig = signal()
  fs.writeFileSync(f.outputFile, Buffer.alloc(4096))
  const p = runEncode(
    { engine: f.engine, log: silent },
    {
      purpose: 'encode-clip',
      args: BASE_ARGS,
      source: 'x.mkv',
      outputFile: f.outputFile,
      startSec: 0,
      endSec: 300,
      signal: sig,
      onProgress: () => {},
      pollMs: 2
    }
  )
  await new Promise((r) => setTimeout(r, 20))
  sig.cancel()
  await assert.rejects(p, /cancelled/)
  assert.ok(f.order.includes('close'), 'the engine was not closed on cancel')
  assert.equal(fs.existsSync(f.outputFile), false)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('cancel before the spawn never starts a process', async () => {
  const f = fake()
  const sig = signal()
  sig.cancel()
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 10,
        signal: sig,
        onProgress: () => {},
        pollMs: 2
      }
    ),
    /cancelled/
  )
  assert.equal(f.spawned.length, 0)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('a spawn failure is a failure, not a rescued success', async () => {
  // The previous runner treated "spawn threw but the output exists" as success,
  // because with --idle=no a short job really could finish before the IPC
  // handshake. With core's --idle=yes intact the child cannot exit before the
  // handshake, so that rescue is gone — and it had to go: it also accepted an
  // unfinalised container from a spawn that failed for any other reason.
  const f = fake({ spawnError: 'could not connect to mpv IPC' })
  fs.writeFileSync(f.outputFile, Buffer.alloc(15269))
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 10,
        signal: signal(),
        onProgress: () => {},
        pollMs: 2
      }
    ),
    /could not connect to mpv IPC/
  )
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('a process that vanishes without an end-file is judged on the file', async () => {
  const f = fake({ vanish: true })
  fs.writeFileSync(f.outputFile, Buffer.alloc(0))
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 10,
        signal: signal(),
        onProgress: () => {},
        pollMs: 2
      }
    ),
    /produced no output/
  )
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('a wedged encoder is stopped at its time budget', async () => {
  const f = fake({ end: null })
  await assert.rejects(
    runEncode(
      { engine: f.engine, log: silent },
      {
        purpose: 'encode-clip',
        args: BASE_ARGS,
        source: 'x.mkv',
        outputFile: f.outputFile,
        startSec: 0,
        endSec: 10,
        signal: signal(),
        onProgress: () => {},
        pollMs: 2,
        timeoutMs: 30
      }
    ),
    /time budget/
  )
  assert.ok(f.order.includes('close'), 'a timed-out job must not leave the child running')
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('the args reach spawn unchanged, and never override --idle', async () => {
  const f = fake({ sizes: [48, 900] })
  await runEncode(
    { engine: f.engine, log: silent },
    {
      purpose: 'encode-gif',
      args: BASE_ARGS,
      source: 'x.mkv',
      outputFile: f.outputFile,
      startSec: 0,
      endSec: 10,
      signal: signal(),
      onProgress: () => {},
      pollMs: 2
    }
  )
  assert.equal(f.spawned[0]?.purpose, 'encode-gif')
  assert.deepEqual(f.spawned[0]?.args, BASE_ARGS)
  assert.equal(
    (f.spawned[0]?.args ?? []).some((a) => a.startsWith('--idle')),
    false
  )
  // No idleTimeoutMs: core's idle reaper killing an encode mid-job would be a
  // truncated file. An encode is bounded by its own timeout instead.
  assert.equal(f.spawned[0]?.idleTimeoutMs, undefined)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// C19's probe
// ---------------------------------------------------------------------------

test('the probe accepts an encoder that reaches eof with bytes on disk', async () => {
  const f = fake({ sizes: [0, 16371] })
  const ok = await probeEncoder(
    { engine: f.engine, log: silent },
    { purpose: 'encode-probe', args: BASE_ARGS, source: 'av://lavfi:testsrc=duration=0.2', outputFile: f.outputFile, pollMs: 2 }
  )
  assert.equal(ok, true)
  // 16,371 bytes is what h264_mf actually produced on this machine.
  assert.equal(fs.existsSync(f.outputFile), false, 'the probe artefact must be deleted')
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('the probe rejects an encoder that will not initialise', async () => {
  const f = fake({
    end: { reason: 'error', file_error: 'video output initialization failed' },
    sizes: [0, 0]
  })
  const ok = await probeEncoder(
    { engine: f.engine, log: silent },
    { purpose: 'encode-probe', args: BASE_ARGS, source: 'av://lavfi:testsrc=duration=0.2', outputFile: f.outputFile, pollMs: 2 }
  )
  assert.equal(ok, false)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('the probe rejects an encoder that reaches eof having written nothing', async () => {
  // eof with an empty output is a real outcome: a muxer that refuses the
  // codec ends the file cleanly and writes no frames.
  const f = fake({ sizes: [0, 0] })
  const ok = await probeEncoder(
    { engine: f.engine, log: silent },
    { purpose: 'encode-probe', args: BASE_ARGS, source: 'av://lavfi:testsrc=duration=0.2', outputFile: f.outputFile, pollMs: 2 }
  )
  assert.equal(ok, false)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('a probe that cannot spawn is not usable', async () => {
  const f = fake({ spawnError: 'no mpv' })
  const ok = await probeEncoder(
    { engine: f.engine, log: silent },
    { purpose: 'encode-probe', args: BASE_ARGS, source: 'av://x', outputFile: f.outputFile, pollMs: 2 }
  )
  assert.equal(ok, false)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('the runner refuses to re-state an option core owns', async () => {
  // Measured consequence of the one that matters: with --idle=no a 2 s job
  // exited at 161 ms and the spawn threw at 15,016 ms, reporting failure for a
  // job that had written a valid file. mpv takes the last occurrence and reports
  // success, so nothing downstream would have caught it.
  for (const bad of ['--idle=no', '--no-config', '--ytdl=yes', '--load-scripts=yes']) {
    const f = fake()
    await assert.rejects(
      runEncode(
        { engine: f.engine, log: silent },
        {
          purpose: 'encode-clip',
          args: [...BASE_ARGS, bad],
          source: 'x.mkv',
          outputFile: f.outputFile,
          startSec: 0,
          endSec: 10,
          signal: signal(),
          onProgress: () => {},
          pollMs: 2
        }
      ),
      /must not be re-stated/,
      `accepted '${bad}'`
    )
    assert.equal(f.spawned.length, 0, `'${bad}' reached spawn`)
    fs.rmSync(f.dir, { recursive: true, force: true })
  }

  // ...and the two an encode legitimately re-states are allowed, or every job
  // would lose its error messages.
  const f = fake({ sizes: [48, 900] })
  await runEncode(
    { engine: f.engine, log: silent },
    {
      purpose: 'encode-clip',
      args: ['--terminal=yes', '--msg-level=all=error', ...BASE_ARGS],
      source: 'x.mkv',
      outputFile: f.outputFile,
      startSec: 0,
      endSec: 10,
      signal: signal(),
      onProgress: () => {},
      pollMs: 2
    }
  )
  assert.equal(f.spawned.length, 1)
  fs.rmSync(f.dir, { recursive: true, force: true })
})
