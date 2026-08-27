import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEVER_REMEMBERED,
  PerFileManager,
  type HistoryFile,
  type OptsFile,
  type ResumeFile,
  type StoreLike
} from './per-file.ts'

/**
 * test:per-file (§6.2): "baseline diffing persists only changed keys; finished
 * files are deleted from resume but kept in history."
 */

function memStore<T extends object>(initial: T): StoreLike<T> & { value: T } {
  const s = {
    value: initial,
    read: (): T => s.value,
    write: (patch: Partial<T>): void => {
      s.value = { ...s.value, ...patch }
    },
    flush: (): void => undefined
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

  const bucket = Object.values(opts.value.entries)[0] ?? {}
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
  assert.deepEqual(Object.values(opts.value.entries)[0]?.['subs-sync'], { subDelay: -0.4 })
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
  assert.deepEqual(Object.values(opts.value.entries)[0]?.['good'], { x: 2 })
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
  const bucket = Object.values(opts.value.entries)[0]?.['rogue']
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
