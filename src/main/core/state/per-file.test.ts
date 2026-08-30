import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEVER_REMEMBERED,
  OPTS_MIGRATIONS,
  PerFileManager,
  resumeKey,
  type OptsBucket,
  type HistoryFile,
  type OptsFile,
  type ResumeFile,
  type StoreLike
} from './per-file.ts'

/**
 * test:per-file (§6.2): "baseline diffing persists only changed keys; finished
 * files are deleted from resume but kept in history."
 */

function memStore<T extends object>(initial: T): StoreLike<T> & { value: T; flushes: number } {
  const s = {
    value: initial,
    // Counted, because "persist now" is a claim about reaching the DISK. A test
    // that only checked the in-memory value would pass for captureNow() too,
    // which is precisely the API gap being closed.
    flushes: 0,
    read: (): T => s.value,
    write: (patch: Partial<T>): void => {
      s.value = { ...s.value, ...patch }
    },
    flush: (): void => {
      s.flushes++
    }
  }
  return s
}

function makeManager(): {
  mgr: PerFileManager
  resume: ReturnType<typeof memStore<ResumeFile>>
  history: ReturnType<typeof memStore<HistoryFile>>
  opts: ReturnType<typeof memStore<OptsFile>>
} {
  const resume = memStore<ResumeFile>({ entries: {} })
  const history = memStore<HistoryFile>({ entries: {} })
  const opts = memStore<OptsFile>({ entries: {} })
  return { mgr: new PerFileManager({ resume, history, opts }), resume, history, opts }
}

const FILE = 'C:/media/show.mkv'

test('a part-watched file is remembered; a finished one is deleted from resume but kept in history', () => {
  const { mgr, resume, history } = makeManager()

  mgr.recordPosition(FILE, 400, 3600, 'show.mkv')
  assert.equal(Object.keys(resume.value.entries).length, 1)
  assert.equal(Object.values(history.value.entries)[0]?.finished, false)

  // Inside the last 90s / 5%: finished.
  mgr.recordPosition(FILE, 3595, 3600, 'show.mkv')
  assert.equal(
    Object.keys(resume.value.entries).length,
    0,
    'a stale resume must never be offered back'
  )
  assert.equal(
    Object.values(history.value.entries)[0]?.finished,
    true,
    'history keeps what resume drops, so the panel can show a checkmark'
  )
})

test('a position under a minute in is not worth remembering', () => {
  const { mgr, resume } = makeManager()
  mgr.recordPosition(FILE, 12, 3600, 'show.mkv')
  assert.equal(Object.keys(resume.value.entries).length, 0)
})

test('lookupMany reports both in-progress and finished files for the playlist badges', () => {
  const { mgr } = makeManager()
  mgr.recordPosition(FILE, 400, 3600, 'show.mkv')
  const found = mgr.lookupMany([FILE, 'C:/media/never-opened.mkv'])
  assert.equal(found[FILE]?.finished, false)
  assert.equal(found['C:/media/never-opened.mkv'], undefined)
})

test('P51: only keys that DIFFER from the file-load baseline are persisted', async () => {
  const { mgr, opts } = makeManager()
  const live: Record<string, unknown> = { subDelay: 0, aid: 1 }

  mgr.registerSlice('subs-sync', {
    key: 'subs-sync',
    capture: () => ({ subDelay: live.subDelay as number }),
    apply: (v) => {
      if (typeof v.subDelay === 'number') live.subDelay = v.subDelay
    },
    rememberDefaults: { subDelay: true }
  })
  mgr.registerSlice('audio-tracks', {
    key: 'audio-tracks',
    capture: () => ({ aid: live.aid as number }),
    apply: (v) => {
      if (typeof v.aid === 'number') live.aid = v.aid
    },
    rememberDefaults: { aid: true }
  })

  await mgr.onFileLoaded(FILE)
  live.subDelay = -0.4 // the user changed this one
  mgr.captureSlices()

  const bucket = Object.values(opts.value.entries)[0]?.slices ?? {}
  assert.deepEqual(bucket['subs-sync'], { subDelay: -0.4 })
  assert.equal(bucket['audio-tracks'], undefined, 'aid never moved, so it is not written')
})

test('the baseline is taken BEFORE the restore, so a restored value is written back', async () => {
  const { mgr, opts } = makeManager()
  const live: Record<string, unknown> = { subDelay: 0 }
  mgr.registerSlice('subs-sync', {
    key: 'subs-sync',
    capture: () => ({ subDelay: live.subDelay as number }),
    apply: (v) => {
      if (typeof v.subDelay === 'number') live.subDelay = v.subDelay
    },
    rememberDefaults: { subDelay: true }
  })

  // Session 1: the user sets a delay.
  await mgr.onFileLoaded(FILE)
  live.subDelay = -0.4
  mgr.captureSlices()

  // Session 2: fresh mpv, the delay is restored, and must survive again.
  live.subDelay = 0
  await mgr.onFileLoaded(FILE)
  assert.equal(live.subDelay, -0.4, 'apply() ran')
  mgr.captureSlices()
  assert.deepEqual(Object.values(opts.value.entries)[0]?.slices['subs-sync'], { subDelay: -0.4 })
})

test('a slice the user opted out of is neither restored nor stored', async () => {
  const { mgr, opts } = makeManager()
  const live: Record<string, unknown> = { speed: 1 }
  mgr.registerSlice('audio-volume', {
    key: 'audio-volume',
    capture: () => ({ speed: live.speed as number }),
    apply: (v) => {
      if (typeof v.speed === 'number') live.speed = v.speed
    },
    // P50: speed is default-OFF.
    rememberDefaults: { speed: false }
  })
  await mgr.onFileLoaded(FILE)
  live.speed = 1.5
  mgr.captureSlices()
  assert.deepEqual(opts.value.entries, {})
})

test('one slice throwing does not abort the others', async () => {
  const { mgr, opts } = makeManager()
  mgr.registerSlice('broken', {
    key: 'broken',
    capture: () => {
      throw new Error('boom')
    },
    apply: () => undefined,
    rememberDefaults: {}
  })
  let applied = false
  mgr.registerSlice('good', {
    key: 'good',
    capture: () => ({ x: applied ? 2 : 1 }),
    apply: () => {
      applied = true
    },
    rememberDefaults: { x: true }
  })
  await mgr.onFileLoaded(FILE)
  applied = true
  mgr.captureSlices()
  assert.deepEqual(Object.values(opts.value.entries)[0]?.slices['good'], { x: 2 })
})

test('PH-2: vf and af are never remembered, whatever a slice reports', async () => {
  assert.ok(NEVER_REMEMBERED.has('vf'))
  assert.ok(NEVER_REMEMBERED.has('af'))

  const { mgr, opts } = makeManager()
  mgr.registerSlice('rogue', {
    key: 'rogue',
    capture: () => ({ vf: '@rl-sharpen:lavfi=[cas]', af: '@rleq:lavfi=[x]', keep: 1 }),
    apply: () => undefined,
    rememberDefaults: { vf: true, af: true, keep: true }
  })
  await mgr.onFileLoaded(FILE)
  mgr.captureSlices()
  const bucket = Object.values(opts.value.entries)[0]?.slices['rogue']
  assert.equal(bucket, undefined, 'nothing differed from the baseline, so nothing was written')
})

test('the same file gets the same identity; a different path does not', () => {
  const { mgr } = makeManager()
  mgr.recordPosition(FILE, 400, 3600, 'show.mkv')
  mgr.recordPosition('C:/media/other.mkv', 400, 3600, 'other.mkv')
  const found = mgr.lookupMany([FILE, 'C:/media/other.mkv'])
  assert.ok(found[FILE])
  assert.ok(found['C:/media/other.mkv'])
  // Windows paths are case-insensitive, and the key must agree.
  assert.ok(mgr.lookupMany(['c:/MEDIA/Show.mkv'])['c:/MEDIA/Show.mkv'])
})

/**
 * ---------------------------------------------------------------------------
 * The three §9 gaps the pilots reported. Each of these tests fails on the
 * previous implementation, which is the point.
 * ---------------------------------------------------------------------------
 */

function sliceWriting(mgr: PerFileManager, key: string, live: { v: number }): void {
  mgr.registerSlice(key, {
    key,
    capture: () => ({ v: live.v }),
    apply: (s) => {
      if (typeof s.v === 'number') live.v = s.v
    },
    rememberDefaults: { v: true }
  })
}

test('slicesFor / sliceFor read a file that is NOT the one playing', async () => {
  const { mgr } = makeManager()
  const live = { v: 0 }
  sliceWriting(mgr, 'nav-bookmarks', live)

  await mgr.onFileLoaded(FILE)
  live.v = 7
  mgr.captureSlices()

  // Switch away. The old service could answer nothing about FILE from here:
  // there was no read path for any file but the current one.
  live.v = 0
  await mgr.onFileLoaded('C:/media/other.mkv')

  assert.deepEqual(mgr.sliceFor(FILE, 'nav-bookmarks'), { v: 7 })
  assert.deepEqual(mgr.slicesFor(FILE), { 'nav-bookmarks': { v: 7 } })
  // "nothing stored" and "stored empty" stay distinguishable.
  assert.equal(mgr.slicesFor('C:/media/never-opened.mkv'), null)
  assert.equal(mgr.sliceFor('C:/media/never-opened.mkv', 'nav-bookmarks'), null)
})

test('storedFiles enumerates every file with slices, newest first', async () => {
  const { mgr } = makeManager()
  const live = { v: 0 }
  sliceWriting(mgr, 'nav-bookmarks', live)

  for (const [i, f] of ['C:/a.mkv', 'C:/b.mkv', 'C:/c.mkv'].entries()) {
    await mgr.onFileLoaded(f)
    live.v = i + 1
    mgr.captureSlices()
  }

  const listed = mgr.storedFiles()
  assert.equal(listed.length, 3)
  // The PATH is on the bucket, which is the whole point: resumeKey() is a
  // one-way hash, so before this a caller could only ask about a path it had.
  assert.deepEqual(new Set(listed.map((e) => e.path)), new Set(['C:/a.mkv', 'C:/b.mkv', 'C:/c.mkv']))
  assert.deepEqual(listed[0]?.sliceKeys, ['nav-bookmarks'])
  const times = listed.map((e) => e.updatedAt)
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first')
})

test('the slice store is CAPPED and evicts oldest-first, like resume and history', async () => {
  const { mgr, opts } = makeManager()
  const live = { v: 0 }
  sliceWriting(mgr, 'nav-bookmarks', live)

  // 1005 distinct files. Uncapped, this store kept every one of them for ever
  // while resume was capped at 500 and history at 2000.
  for (let i = 0; i < 1005; i++) {
    await mgr.onFileLoaded(`C:/media/ep${i}.mkv`)
    live.v = i + 1
    mgr.captureSlices()
  }

  const kept = Object.keys(opts.value.entries).length
  assert.equal(kept, 1000, `expected the 1000-entry cap, kept ${kept}`)
  // Oldest-first: the five earliest files are the ones gone.
  const paths = new Set(mgr.storedFiles().map((e) => e.path))
  for (let i = 0; i < 5; i++) {
    assert.ok(!paths.has(`C:/media/ep${i}.mkv`), `ep${i} should have been evicted`)
  }
  assert.ok(paths.has('C:/media/ep1004.mkv'), 'the newest must survive')
})

test('persistNow captures AND fsyncs; captureNow only captures', async () => {
  const { mgr, opts } = makeManager()
  const live = { v: 0 }
  sliceWriting(mgr, 'nav-bookmarks', live)
  await mgr.onFileLoaded(FILE)
  live.v = 3

  mgr.captureSlices()
  assert.equal(opts.flushes, 0, 'captureNow must not be claimed to reach the disk')

  mgr.persistNow()
  assert.equal(opts.flushes, 1, 'persistNow must flush the store')
  assert.deepEqual(mgr.sliceFor(FILE, 'nav-bookmarks'), { v: 3 })
})

test('entries stamped within ONE millisecond still evict oldest-first', async () => {
  /**
   * The regression test for the tie that made eviction back-to-front. With
   * `updatedAt: Date.now()` and no monotonic guard, 1005 captures inside a few
   * milliseconds produced runs of identical stamps; `bound()`'s stable sort then
   * resolved each run to insertion order and kept the OLDEST. Frozen clock here,
   * so every stamp would tie without the guard.
   */
  const { mgr, opts } = makeManager()
  const live = { v: 0 }
  sliceWriting(mgr, 'nav-bookmarks', live)

  const realNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    for (let i = 0; i < 1003; i++) {
      await mgr.onFileLoaded(`C:/frozen/ep${i}.mkv`)
      live.v = i + 1
      mgr.captureSlices()
    }
  } finally {
    Date.now = realNow
  }

  assert.equal(Object.keys(opts.value.entries).length, 1000)
  const paths = new Set(mgr.storedFiles().map((e) => e.path))
  assert.ok(!paths.has('C:/frozen/ep0.mkv'))
  assert.ok(!paths.has('C:/frozen/ep2.mkv'))
  assert.ok(paths.has('C:/frozen/ep1002.mkv'))
})

test('the 1 -> 2 migration carries the slice data across and does not double-wrap', () => {
  const [step] = OPTS_MIGRATIONS
  assert.ok(step && step.from === 1 && step.to === 2)

  const out = step.up({
    schema: 1,
    entries: {
      aaa: { 'subs-sync': { subDelay: -0.4 }, 'nav-bookmarks': { marks: [1, 2] } },
      bbb: { 'audio-eq': { gains: [1, 2, 3] } },
      // A bucket a newer build already wrote, seen by an older one that then
      // upgraded again. Wrapping it a second time would bury the slices a level
      // deeper and silently lose every one of them.
      ccc: { path: 'C:/x.mkv', updatedAt: 7, slices: { 'subs-sync': { subDelay: 1 } } },
      // Junk. Must be dropped, not turned into a bucket with junk inside.
      ddd: 'not an object',
      eee: null
    }
  }) as { entries: Record<string, OptsBucket> }

  assert.deepEqual(Object.keys(out.entries).sort(), ['aaa', 'bbb', 'ccc'])
  assert.deepEqual(out.entries.aaa, {
    path: '',
    updatedAt: 0,
    slices: { 'subs-sync': { subDelay: -0.4 }, 'nav-bookmarks': { marks: [1, 2] } }
  })
  assert.deepEqual(out.entries.ccc, {
    path: 'C:/x.mkv',
    updatedAt: 7,
    slices: { 'subs-sync': { subDelay: 1 } }
  })
})

test('a migrated bucket is readable through the service, and evictable', async () => {
  // The migration is only correct if the manager can then USE what it produced:
  // a shape test alone would pass for a bucket the reader cannot open.
  const migrated = OPTS_MIGRATIONS[0]?.up({
    schema: 1,
    entries: { [resumeKey(FILE)]: { 'subs-sync': { subDelay: -0.4 } } }
  }) as OptsFile

  const resume = memStore<ResumeFile>({ entries: {} })
  const history = memStore<HistoryFile>({ entries: {} })
  const opts = memStore<OptsFile>(migrated)
  const mgr = new PerFileManager({ resume, history, opts })

  assert.deepEqual(mgr.sliceFor(FILE, 'subs-sync'), { subDelay: -0.4 })

  // …and it is APPLIED on load, which is the point of keeping it.
  const live: Record<string, unknown> = { subDelay: 0 }
  mgr.registerSlice('subs-sync', {
    key: 'subs-sync',
    capture: () => ({ subDelay: live.subDelay as number }),
    apply: (v) => {
      if (typeof v.subDelay === 'number') live.subDelay = v.subDelay
    },
    rememberDefaults: { subDelay: true }
  })
  await mgr.onFileLoaded(FILE)
  assert.equal(live.subDelay, -0.4, 'the migrated value was restored')

  // updatedAt 0 means a migrated bucket is the FIRST thing evicted, which is the
  // right answer: it is the one we know least about.
  assert.equal(mgr.storedFiles()[0]?.updatedAt, 0)
})

/**
 * ---------------------------------------------------------------------------
 * A DISABLED MODULE MUST NOT ERASE ITS OWN PER-FILE DATA.
 *
 * Found by migrating a real profile: after one play of the file, a slice key
 * that no registered module claimed was gone from the bucket.
 *
 * `captureSlices()` rebuilt the bucket from the REGISTERED slices only, so any
 * stored slice whose owner was not registered on this boot was discarded — and
 * if no registered slice produced a diff, `delete all[key]` threw the whole
 * bucket away, other modules' data included.
 *
 * That collides head-on with a documented guarantee: "a runtime failure inside
 * your setup() disables your module only: it logs loudly, shows one toast, and
 * the app starts. One broken feature must never black-screen the player." A
 * module disabled that way registers no slice — so every file the user played
 * while it was broken silently DELETED that module's saved state for that file,
 * and one bad release would take the user's per-file settings with it.
 * ---------------------------------------------------------------------------
 */
test('a slice whose module did not load this boot is PRESERVED, not erased', async () => {
  const resume = memStore<ResumeFile>({ entries: {} })
  const history = memStore<HistoryFile>({ entries: {} })
  const opts = memStore<OptsFile>({ entries: {} })

  // Boot 1: both modules healthy. Both store something.
  {
    const mgr = new PerFileManager({ resume, history, opts })
    const live = { a: 0, b: 0 }
    mgr.registerSlice('mod-a', {
      key: 'mod-a',
      capture: () => ({ v: live.a }),
      apply: (s) => {
        if (typeof s.v === 'number') live.a = s.v
      },
      rememberDefaults: { v: true }
    })
    mgr.registerSlice('mod-b', {
      key: 'mod-b',
      capture: () => ({ v: live.b }),
      apply: (s) => {
        if (typeof s.v === 'number') live.b = s.v
      },
      rememberDefaults: { v: true }
    })
    await mgr.onFileLoaded(FILE)
    live.a = 11
    live.b = 22
    mgr.captureSlices()
  }

  // Boot 2: mod-a's setup() threw, so it is disabled and registers no slice.
  // The app runs — that is the documented contract — and the user plays the
  // same file again.
  {
    const mgr = new PerFileManager({ resume, history, opts })
    const live = { b: 0 }
    mgr.registerSlice('mod-b', {
      key: 'mod-b',
      capture: () => ({ v: live.b }),
      apply: (s) => {
        if (typeof s.v === 'number') live.b = s.v
      },
      rememberDefaults: { v: true }
    })
    await mgr.onFileLoaded(FILE)
    assert.equal(live.b, 22, 'mod-b was restored')
    mgr.captureSlices()

    assert.deepEqual(
      mgr.sliceFor(FILE, 'mod-a'),
      { v: 11 },
      "mod-a was disabled this boot, not uninstalled: its stored slice must survive"
    )
    assert.deepEqual(mgr.sliceFor(FILE, 'mod-b'), { v: 22 })
  }

  // Boot 3: mod-a is fixed. Its value must come back.
  {
    const mgr = new PerFileManager({ resume, history, opts })
    const live = { a: 0 }
    mgr.registerSlice('mod-a', {
      key: 'mod-a',
      capture: () => ({ v: live.a }),
      apply: (s) => {
        if (typeof s.v === 'number') live.a = s.v
      },
      rememberDefaults: { v: true }
    })
    await mgr.onFileLoaded(FILE)
    assert.equal(live.a, 11, 'mod-a recovers the value it had before it broke')
  }
})

test('a bucket is not deleted just because no REGISTERED slice has a diff', async () => {
  const resume = memStore<ResumeFile>({ entries: {} })
  const history = memStore<HistoryFile>({ entries: {} })
  const opts = memStore<OptsFile>({
    entries: {
      [resumeKey(FILE)]: {
        path: FILE,
        updatedAt: 5,
        slices: { 'mod-a': { v: 11 } }
      }
    }
  })
  // Only mod-b is registered, and it has nothing to say. The old code took the
  // `delete all[key]` branch and dropped mod-a with the bucket.
  const mgr = new PerFileManager({ resume, history, opts })
  mgr.registerSlice('mod-b', {
    key: 'mod-b',
    capture: () => ({ v: 0 }),
    apply: () => undefined,
    rememberDefaults: { v: true }
  })
  await mgr.onFileLoaded(FILE)
  mgr.captureSlices()
  assert.deepEqual(mgr.sliceFor(FILE, 'mod-a'), { v: 11 })
})
