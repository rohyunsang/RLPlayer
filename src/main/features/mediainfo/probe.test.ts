import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MediaProbe,
  cacheKey,
  tooltipFor,
  type FileStat,
  type ProbeDeps,
  type ProbeEngine
} from './probe.ts'
import type { ProbeSummary } from '@shared/features/mediainfo/wire'

/**
 * L22's headless probe, driven with a fake engine.
 *
 * The fake is a real state machine, not a spy: it records the exact command
 * arrays it received and answers `getProperty` from a per-file table, so every
 * test below asserts a RESULT (the summary the caller gets, the argv mpv would
 * have seen) rather than "loadfile was called". Four things the spec measured
 * are asserted here as behaviour:
 *
 *   1. requests are SERIALISED -- "Serialise requests one file at a time";
 *   2. `demux-*` only -- `video-params` needs an initialised decoder and this
 *      path must never ask for it;
 *   3. `loadfile` carries the explicit insertion index;
 *   4. a timeout still issues `stop`, or the instance stays wedged on the bad
 *      file and every later probe answers with its data.
 */

interface Handler {
  (event: string, cb: (msg: Record<string, unknown>) => void): () => void
}

class FakeEngine implements ProbeEngine {
  running = true
  readonly commands: unknown[][] = []
  readonly asked: string[] = []
  /** path -> property bag; a missing path answers `end-file` with reason error. */
  table = new Map<string, Record<string, unknown>>()
  /** Paths that never answer anything at all: the wedged-share case. */
  silent = new Set<string>()
  closed = 0
  /** Delivered synchronously from inside `loadfile` when true (a warm demuxer). */
  syncLoad = false

  #listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>()

  onEvent: Handler = (event, cb) => {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  }

  #emit(event: string, msg: Record<string, unknown> = {}): void {
    for (const cb of [...(this.#listeners.get(event) ?? [])]) cb({ event, ...msg })
  }

  #current: Record<string, unknown> | null = null

  async command<T = unknown>(args: unknown[]): Promise<T> {
    this.commands.push(args)
    const [verb, file] = args as [string, string]
    if (verb === 'loadfile') {
      const known = this.table.get(file)
      if (this.silent.has(file)) return undefined as T
      const fire = (): void => {
        if (known) {
          this.#current = known
          this.#emit('file-loaded')
        } else {
          this.#current = null
          this.#emit('end-file', { reason: 'error' })
        }
      }
      if (this.syncLoad) fire()
      else setTimeout(fire, 0)
    }
    if (verb === 'stop') this.#current = null
    return undefined as T
  }

  async getProperty<T = unknown>(name: string): Promise<T> {
    this.asked.push(name)
    if (this.#current === null) throw new Error('property unavailable')
    if (!(name in this.#current)) throw new Error('property unavailable')
    return this.#current[name] as T
  }

  async close(): Promise<void> {
    this.closed++
    this.running = false
  }
}

const STAT: FileStat = { size: 1234, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000 }

function harness(over: Partial<ProbeDeps> = {}): {
  probe: MediaProbe
  engine: FakeEngine
  spawns: number
  deps: ProbeDeps
  warnings: string[]
  persisted: Array<Record<string, ProbeSummary>>
} {
  const engine = new FakeEngine()
  const warnings: string[] = []
  const persisted: Array<Record<string, ProbeSummary>> = []
  const box = { spawns: 0 }
  const deps: ProbeDeps = {
    spawn: async () => {
      box.spawns++
      return engine
    },
    stat: () => STAT,
    timeoutMs: () => 100,
    idleMs: () => 0,
    enabled: () => true,
    log: { warn: (...a: unknown[]) => warnings.push(a.map(String).join(' ')) },
    persist: (e) => persisted.push(e),
    ...over
  }
  const probe = new MediaProbe(deps)
  return {
    probe,
    engine,
    get spawns(): number {
      return box.spawns
    },
    deps,
    warnings,
    persisted
  }
}

const MKV = {
  duration: 1440.5,
  'file-format': 'matroska,webm',
  'file-size': 2_000_000_000,
  metadata: { title: 'Episode 2' },
  'track-list': [
    { id: 1, type: 'video', 'demux-w': 1920, 'demux-h': 1080, 'demux-fps': 23.976 },
    { id: 1, type: 'audio' },
    { id: 2, type: 'audio' },
    { id: 1, type: 'sub' }
  ]
}

// ---------------------------------------------------------------------------

test('L21: the cache key is path + size + mtime, not the path', () => {
  // "persist results keyed by `path + size + mtimeMs`". A re-encode that keeps
  // the filename is a different file, and a path-keyed cache would show the old
  // duration for ever.
  const a = cacheKey('D:\\a.mkv', STAT)
  const b = cacheKey('D:\\a.mkv', { ...STAT, size: 9999 })
  const c = cacheKey('D:\\a.mkv', { ...STAT, mtimeMs: STAT.mtimeMs + 1000 })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.equal(a, cacheKey('D:\\a.mkv', { ...STAT }))
  // A missing stat still produces a key, and one that cannot collide with a
  // real one.
  assert.equal(cacheKey('D:\\a.mkv', null), 'D:\\a.mkv|?|?')
})

test('a successful probe answers the demuxer facts and caches them', async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', MKV)

  const s = await h.probe.probe('D:\\a.mkv')
  assert.equal(s.ok, true)
  assert.equal(s.durationSec, 1440.5)
  assert.equal(s.container, 'matroska,webm')
  assert.equal(s.title, 'Episode 2')
  assert.equal(s.videoCount, 1)
  assert.equal(s.audioCount, 2)
  assert.equal(s.subCount, 1)
  // The size comes from `fs.statSync`, which L21 calls free, not from mpv.
  assert.equal(s.sizeBytes, STAT.size)
  assert.equal(s.tooltip, '24:00 · matroska,webm · 1.21 KiB · V1/A2/S1')

  // A second request is answered from the cache: no second loadfile.
  const loadfiles = h.engine.commands.filter((c) => c[0] === 'loadfile').length
  const again = await h.probe.probe('D:\\a.mkv')
  assert.deepEqual(again, s)
  assert.equal(h.engine.commands.filter((c) => c[0] === 'loadfile').length, loadfiles)
  assert.equal(h.probe.cacheSize, 1)
  assert.equal(h.persisted.length, 1)
})

test("L22 trap 1: loadfile carries the explicit insertion index", async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', MKV)
  await h.probe.probe('D:\\a.mkv')
  const load = h.engine.commands.find((c) => c[0] === 'loadfile')
  assert.deepEqual(load, ['loadfile', 'D:\\a.mkv', 'replace', -1])
  // …and `stop` follows, so the instance is not left holding the file open.
  assert.ok(h.engine.commands.some((c) => c[0] === 'stop'))
})

test('L22: the probe path asks for demux facts and NEVER for video-params', async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', MKV)
  await h.probe.probe('D:\\a.mkv')
  // "video-params/audio-params are NOT available (they need an initialised
  // decoder) — use demux-* in the probe path." Asking would answer undefined
  // for every file, and a column of dashes is indistinguishable from a broken
  // probe.
  assert.deepEqual(h.engine.asked, [
    'duration',
    'track-list',
    'metadata',
    'file-format',
    'file-size'
  ])
  for (const banned of ['video-params', 'audio-params', 'video-out-params', 'estimated-vf-fps']) {
    assert.equal(h.engine.asked.includes(banned), false, `asked for ${banned}`)
  }
})

test('the engine spawns LAZILY and exactly once for many files', async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', MKV)
  h.engine.table.set('D:\\b.mkv', MKV)
  // L21's real requirement: opening a 500-row playlist must not probe 500 files.
  assert.equal(h.spawns, 0)
  h.probe.peek('D:\\a.mkv')
  assert.equal(h.spawns, 0, 'peek() must never spawn')

  await h.probe.probe('D:\\a.mkv')
  await h.probe.probe('D:\\b.mkv')
  assert.equal(h.spawns, 1)
})

test('requests are SERIALISED: two in flight do not interleave loadfiles', async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', { ...MKV, duration: 10 })
  h.engine.table.set('D:\\b.mkv', { ...MKV, duration: 20 })
  h.engine.table.set('D:\\c.mkv', { ...MKV, duration: 30 })

  const [a, b, c] = await Promise.all([
    h.probe.probe('D:\\a.mkv'),
    h.probe.probe('D:\\b.mkv'),
    h.probe.probe('D:\\c.mkv')
  ])
  // Each file got its OWN duration. Two loadfiles in flight on one shared
  // demuxer is how b's answer becomes a's.
  assert.equal(a?.durationSec, 10)
  assert.equal(b?.durationSec, 20)
  assert.equal(c?.durationSec, 30)

  // And the commands really did alternate load/stop rather than load/load.
  const verbs = h.engine.commands.map((x) => x[0])
  assert.deepEqual(verbs, ['loadfile', 'stop', 'loadfile', 'stop', 'loadfile', 'stop'])
})

test('an unreadable file answers from end-file rather than waiting out the timeout', async () => {
  const h = harness({ timeoutMs: () => 5000 })
  const started = Date.now()
  const s = await h.probe.probe('D:\\broken.mkv')
  // mpv answers an unreadable file with `end-file`, not with silence. Waiting
  // the full timeout would make a folder of broken files take 5 s each.
  assert.equal(s.ok, false)
  assert.equal(s.reason, 'error')
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
  // Size and date are still reported: they came from stat, not from mpv.
  assert.equal(s.sizeBytes, STAT.size)
  assert.ok(s.tooltip.includes('(error)'))
})

test('a silent file times out, and `stop` is issued ANYWAY', async () => {
  const h = harness({ timeoutMs: () => 60 })
  h.engine.silent.add('\\\\dead-share\\v.mkv')
  const s = await h.probe.probe('\\\\dead-share\\v.mkv')
  assert.equal(s.ok, false)
  assert.equal(s.reason, 'timeout')
  // Without this the instance stays wedged on that file and every later probe
  // answers with its data.
  assert.ok(h.engine.commands.some((c) => c[0] === 'stop'))

  // The next file still works: the queue survived the failure.
  h.engine.table.set('D:\\ok.mkv', MKV)
  const ok = await h.probe.probe('D:\\ok.mkv')
  assert.equal(ok.ok, true)
})

test('a failed probe is NOT cached, so a reconnected share is retried', async () => {
  const h = harness({ timeoutMs: () => 40 })
  h.engine.silent.add('D:\\x.mkv')
  const first = await h.probe.probe('D:\\x.mkv')
  assert.equal(first.reason, 'timeout')
  assert.equal(h.probe.cacheSize, 0)

  h.engine.silent.delete('D:\\x.mkv')
  h.engine.table.set('D:\\x.mkv', MKV)
  const second = await h.probe.probe('D:\\x.mkv')
  assert.equal(second.ok, true)
})

test('a file-loaded delivered SYNCHRONOUSLY from inside loadfile does not throw', async () => {
  // A warm demuxer -- and any fake -- can settle the promise from inside
  // `onEvent`. The subscriptions are held in `let`s that `cleanup()` reads
  // precisely so this is not a TDZ ReferenceError; it is the same "declare
  // first, subscribe last" shape as the renderer's state replay.
  const h = harness()
  h.engine.syncLoad = true
  h.engine.table.set('D:\\warm.mkv', MKV)
  const s = await h.probe.probe('D:\\warm.mkv')
  assert.equal(s.ok, true)
  assert.deepEqual(h.warnings, [])
})

test('disabled: every request answers immediately and nothing spawns', async () => {
  const h = harness({ enabled: () => false })
  const s = await h.probe.probe('D:\\a.mkv')
  assert.equal(s.ok, false)
  assert.equal(s.reason, 'disabled')
  assert.equal(h.spawns, 0)
  assert.deepEqual(h.engine.commands, [])
})

test('a missing file is answered from stat, with no engine involved', async () => {
  const h = harness({ stat: () => null })
  const s = await h.probe.probe('D:\\gone.mkv')
  assert.equal(s.reason, 'missing')
  assert.equal(h.spawns, 0)
  assert.equal(s.sizeBytes, null)
})

test('a spawn failure is reported per request and does not poison later ones', async () => {
  let fail = true
  const engine = new FakeEngine()
  engine.table.set('D:\\a.mkv', MKV)
  const warnings: string[] = []
  const probe = new MediaProbe({
    spawn: async () => {
      if (fail) throw new Error('mpv.exe not found')
      return engine
    },
    stat: () => STAT,
    timeoutMs: () => 100,
    idleMs: () => 0,
    enabled: () => true,
    log: { warn: (...a) => warnings.push(a.map(String).join(' ')) }
  })
  const bad = await probe.probe('D:\\a.mkv')
  assert.equal(bad.reason, 'engine')
  assert.ok(warnings.some((w) => w.includes('mpv.exe not found')))

  fail = false
  const good = await probe.probe('D:\\a.mkv')
  assert.equal(good.ok, true)
})

test('restored cache entries are served without spawning', async () => {
  const key = cacheKey('D:\\a.mkv', STAT)
  const stored: ProbeSummary = {
    path: 'D:\\a.mkv',
    ok: true,
    durationSec: 99,
    sizeBytes: STAT.size,
    modifiedMs: STAT.mtimeMs,
    container: 'matroska',
    title: null,
    videoCount: 1,
    audioCount: 1,
    subCount: 0,
    tooltip: '1:39 · matroska',
    rows: []
  }
  const h = harness({ restore: () => ({ [key]: stored }) })
  assert.equal(h.probe.cacheSize, 1)
  assert.deepEqual(h.probe.peek('D:\\a.mkv'), stored)
  const s = await h.probe.probe('D:\\a.mkv')
  assert.equal(s.durationSec, 99)
  assert.equal(h.spawns, 0)
})

test('a restored cache whose file has changed on disk is a MISS', async () => {
  const stale = cacheKey('D:\\a.mkv', { ...STAT, mtimeMs: 1 })
  const h = harness({
    restore: () => ({
      [stale]: {
        path: 'D:\\a.mkv',
        ok: true,
        durationSec: 1,
        sizeBytes: 1,
        modifiedMs: 1,
        container: null,
        title: null,
        videoCount: 0,
        audioCount: 0,
        subCount: 0,
        tooltip: 'stale',
        rows: []
      }
    })
  })
  h.engine.table.set('D:\\a.mkv', MKV)
  assert.equal(h.probe.peek('D:\\a.mkv'), null)
  const s = await h.probe.probe('D:\\a.mkv')
  assert.equal(s.durationSec, 1440.5)
})

test('dispose closes the engine and later requests answer without one', async () => {
  const h = harness()
  h.engine.table.set('D:\\a.mkv', MKV)
  await h.probe.probe('D:\\a.mkv')
  await h.probe.dispose()
  assert.equal(h.engine.closed, 1)
  const s = await h.probe.probe('D:\\b.mkv')
  assert.equal(s.reason, 'disposed')
  // Idempotent: the quit path reaps whatever is left and may call this twice.
  await h.probe.dispose()
})

test('L40: the tooltip is one line and degrades a field at a time', () => {
  const base = {
    path: 'x',
    ok: true,
    durationSec: 61,
    sizeBytes: 1024 * 1024,
    modifiedMs: null,
    container: 'mp4',
    title: null,
    videoCount: 1,
    audioCount: 1,
    subCount: 0,
    rows: []
  }
  assert.equal(tooltipFor(base), '1:01 · mp4 · 1 MiB · V1/A1')
  assert.equal(
    tooltipFor({ ...base, durationSec: null, container: null, sizeBytes: null }),
    'V1/A1'
  )
  assert.equal(
    tooltipFor({ ...base, ok: false, reason: 'timeout' }),
    '1:01 · mp4 · 1 MiB · V1/A1 · (timeout)'
  )
})

test('L22: the engine args are the row minus what core always applies', () => {
  const args = MediaProbe.engineArgs()
  // Core applies `--no-config --idle=yes --terminal=no --msg-level=all=no
  // --load-scripts=no --ytdl=no` and a RANDOM `--input-ipc-server` per
  // instance. Contributing any of those again would be duplicating core's work
  // at best; naming a pipe would be the local command-execution surface L22
  // calls out ("mpv's IPC is explicitly insecure and exposes the `run`
  // command").
  for (const forbidden of [
    '--input-ipc-server',
    '--no-config',
    '--idle',
    '--terminal',
    '--msg-level',
    '--load-scripts',
    '--ytdl'
  ]) {
    assert.equal(
      args.some((a) => a.startsWith(forbidden)),
      false,
      `${forbidden} is core's and must not be contributed here`
    )
  }
  assert.deepEqual(args, ['--vo=null', '--ao=null', '--no-video', '--no-audio', '--keep-open=no'])
})
