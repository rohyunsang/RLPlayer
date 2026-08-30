import test from 'node:test'
import assert from 'node:assert/strict'
import type { TrackLike } from '@shared/mpv/tracks'
import { captureSlice, reloadSubtitles, restoreSelection, type ReloadPort } from './reload.ts'

/**
 * M17's RELOAD PATH, against an mpv that renumbers exactly the way the real one
 * was measured to.
 *
 * THE BUG THIS SUITE EXISTS FOR. Packaged build, a real CP949 `kor.smi`
 * (bytes `bec8b3e7c7cf…`, invalid UTF-8) beside `kor.mp4`, one press of the
 * default Alt+C binding:
 *
 *     boot   sid=1       sub-text="안녕하세요 세계"
 *     Alt+C  sid=false   sub-text "property unavailable"
 *
 * permanently, and `sub-codepage=auto` could not bring it back. Root cause:
 * `--sub-auto=fuzzy` loads two external subs, `sub-reload` renumbers them from
 * `1:kor.smi*, 2:kor_srt.srt` to `2:kor_srt.srt, 3:kor.smi*`, mpv re-selects
 * the right FILE by itself, and the module then wrote the stale captured sid
 * back. mpv answered `{"error":"success"}` and resolved it to `false`.
 *
 * The fake mpv below reproduces ALL THREE halves of that — the renumber, mpv's
 * own re-selection, and `set_property sid <gone>` SUCCEEDING and resolving to
 * `false`. Run this suite against the pre-fix code and
 * "Alt+C keeps the Korean subtitle selected" fails with sid=false.
 */

const SMI = 'C:\\media\\kor.smi'
const SRT = 'C:\\media\\kor_srt.srt'

interface Fake {
  tracks: TrackLike[]
  sid: number | false
  /** kor.smi has been deleted from disk between the presses. */
  smiDeleted: boolean
  /** mpv re-selects the same file on its own after the reload (it does). */
  mpvReselects: boolean
  reloads: number
  writes: Array<number | false | 'no'>
  logs: Array<{ level: string; text: string }>
  toasts: Array<{ kind: string; message: string }>
}

function fresh(): Fake {
  return {
    tracks: [
      { id: 1, type: 'video', codec: 'h264' },
      { id: 1, type: 'audio', codec: 'aac' },
      { id: 1, type: 'sub', external: true, selected: true, 'external-filename': SMI },
      { id: 2, type: 'sub', external: true, 'external-filename': SRT }
    ],
    sid: 1,
    smiDeleted: false,
    mpvReselects: true,
    reloads: 0,
    writes: [],
    logs: [],
    toasts: []
  }
}

/** mpv's REAL `sub-reload`: drop every external sub, re-add, renumber, re-pick. */
function subReload(m: Fake): void {
  m.reloads++
  const keep = m.tracks.filter((t) => !(t.type === 'sub' && t.external))
  const wasPlaying = m.tracks.find((t) => t.type === 'sub' && t.id === m.sid)?.['external-filename']
  const files = [SRT, ...(m.smiDeleted ? [] : [SMI])]
  let next = 2
  const added: TrackLike[] = files.map((f) => ({
    id: next++,
    type: 'sub',
    external: true,
    'external-filename': f
  }))
  m.tracks = [...keep, ...added]
  const again = added.find((t) => t['external-filename'] === wasPlaying)
  m.sid = m.mpvReselects && again ? again.id : false
}

/**
 * mpv's REAL `set_property sid`: ALWAYS "success", resolves to `false` when the
 * id names no track. This one line is the whole reason the defect was silent.
 */
function setSid(m: Fake, value: number | false | 'no'): void {
  if (value === 'no' || value === false) {
    m.sid = false
    return
  }
  m.sid = m.tracks.some((t) => t.type === 'sub' && t.id === value) ? value : false
}

function portFor(m: Fake): ReloadPort {
  return {
    get: async <T>(name: string): Promise<T> =>
      (name === 'track-list' ? m.tracks : name === 'sid' ? m.sid : undefined) as T,
    peek: <T>(name: string): T | undefined =>
      (name === 'track-list' ? m.tracks : name === 'sid' ? m.sid : undefined) as T | undefined,
    command: async (args: unknown[]) => {
      if (args[0] === 'sub-reload') subReload(m)
      return undefined
    },
    selectTrack: async (_name, id) => {
      m.writes.push(id)
      setSid(m, id)
      return m.sid
    },
    log: {
      info: (...a: unknown[]) => m.logs.push({ level: 'info', text: a.join(' ') }),
      warn: (...a: unknown[]) => m.logs.push({ level: 'warn', text: a.join(' ') }),
      error: (...a: unknown[]) => m.logs.push({ level: 'error', text: a.join(' ') })
    },
    toast: (kind, message) => m.toasts.push({ kind, message }),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key)
  }
}

const selectedFile = (m: Fake): string | undefined =>
  m.tracks.find((t) => t.type === 'sub' && t.id === m.sid)?.['external-filename']

// ---------------------------------------------------------------------------

test('THE REGRESSION: Alt+C keeps the Korean subtitle selected', async () => {
  const m = fresh()
  const out = await reloadSubtitles(portFor(m))
  assert.notEqual(m.sid, false, 'sid went false — the subtitle is gone, which IS the bug')
  assert.equal(selectedFile(m), SMI, 'the selected track must still be kor.smi')
  assert.equal(m.sid, 3, 'sub-reload renumbers kor.smi from 1 to 3')
  assert.deepEqual(out, { kind: 'already', id: 3 })
})

test('when mpv already re-selected correctly, M17 writes NOTHING', async () => {
  const m = fresh()
  await reloadSubtitles(portFor(m))
  assert.deepEqual(
    m.writes,
    [],
    'the old code wrote the stale sid HERE, over a correct selection'
  )
  assert.ok(
    m.logs.some((l) => /re-selected/.test(l.text) && /kor\.smi/.test(l.text)),
    'the no-op case still says what happened, naming the file'
  )
})

test('when mpv DROPS the selection, M17 re-selects the same FILE at its new id', async () => {
  const m = fresh()
  m.mpvReselects = false
  const out = await reloadSubtitles(portFor(m))
  assert.equal(m.sid, 3)
  assert.deepEqual(m.writes, [3], 'exactly one write, and it is the NEW id')
  assert.deepEqual(out, { kind: 'reselected', id: 3 })
})

test('the stale captured index is never written, even when it still names a track', async () => {
  /**
   * The nastier half of the same defect: if a sub track 1 happened to survive
   * the renumber, writing the captured 1 back would select the WRONG subtitle
   * and nothing would look broken at all.
   */
  const m = fresh()
  m.mpvReselects = false
  const port = portFor(m)
  const realCommand = port.command
  port.command = async (args) => {
    const r = await realCommand(args)
    // A third subtitle appears at id 1 after the reload.
    m.tracks.push({ id: 1, type: 'sub', external: true, 'external-filename': 'C:\\media\\zz.srt' })
    return r
  }
  await reloadSubtitles(port)
  assert.equal(selectedFile(m), SMI, 'identity, not index: zz.srt must not win')
  assert.deepEqual(m.writes, [3])
})

test('a reload that LOSES the file is reported, never silently swallowed', async () => {
  const m = fresh()
  m.smiDeleted = true
  m.mpvReselects = false
  const out = await reloadSubtitles(portFor(m))
  assert.equal(out.kind, 'lost')
  assert.equal(m.toasts.filter((t) => t.kind === 'error').length, 1, 'the user must be told')
  assert.ok(
    m.logs.some((l) => l.level === 'error' && /kor\.smi/.test(l.text)),
    'the log must name the file that went missing'
  )
  // And it must NOT have silently selected kor_srt.srt instead.
  assert.deepEqual(m.writes, [], 'no ordinal fallback: a wrong subtitle is worse than none')
})

test('an embedded selection is a no-op: sub-reload re-reads external tracks only', async () => {
  const m = fresh()
  m.tracks = [
    { id: 1, type: 'video' },
    { id: 1, type: 'sub', title: '한국어', lang: 'kor' }
  ]
  m.sid = 1
  const out = await reloadSubtitles(portFor(m))
  assert.deepEqual(out, { kind: 'embedded' })
  assert.equal(m.reloads, 0)
  assert.deepEqual(m.writes, [])
})

test('a write mpv accepts and then discards is REPORTED, not swallowed', async () => {
  const m = fresh()
  m.mpvReselects = false
  const port = portFor(m)
  // mpv resolves the write to nothing (the track vanished between the reload
  // and the write). The old `.catch(() => undefined)` could not see this at all.
  port.selectTrack = async (_n, id) => {
    m.writes.push(id)
    return false
  }
  const out = await reloadSubtitles(port)
  assert.deepEqual(out, { kind: 'refused', wanted: 3, resolved: false })
  assert.equal(m.toasts.filter((t) => t.kind === 'error').length, 1)
  assert.ok(m.logs.some((l) => l.level === 'error' && /ACCEPTED/.test(l.text)))
})

test('a sub-reload that THROWS surfaces, rather than vanishing into a catch', async () => {
  const m = fresh()
  const port = portFor(m)
  port.command = async () => {
    throw new Error('mpv is gone')
  }
  const out = await reloadSubtitles(port)
  assert.deepEqual(out, { kind: 'reload-failed', message: 'mpv is gone' })
  assert.equal(m.toasts.filter((t) => t.kind === 'error').length, 1)
})

// --- the per-file restore, the same lesson one level up ---------------------

test('the per-file slice captures the track IDENTITY beside the index', () => {
  const m = fresh()
  const slice = captureSlice(m.tracks, m.sid, true)
  assert.equal(slice.sid, 1)
  assert.match(slice.identity!.externalFilename!, /kor\.smi/)
})

test('a remembered sid is restored at the id the track has NOW', async () => {
  const m = fresh()
  const slice = captureSlice(m.tracks, m.sid, true)
  // Next session: a new sibling .srt sorted first has shifted every id.
  m.tracks = [
    { id: 1, type: 'video' },
    { id: 1, type: 'sub', external: true, 'external-filename': 'C:\\media\\aaa.srt' },
    { id: 2, type: 'sub', external: true, 'external-filename': SMI }
  ]
  m.sid = 1
  const out = await restoreSelection(portFor(m), slice)
  assert.deepEqual(out, { kind: 'reselected', id: 2 })
  assert.equal(selectedFile(m), SMI, 'restoring the raw 1 would have selected aaa.srt')
})

test('a bucket written by an older build still restores by index, and says when it fails', async () => {
  const m = fresh()
  m.tracks = [{ id: 1, type: 'video' }]
  m.sid = false
  const out = await restoreSelection(portFor(m), { sid: 7, identity: null })
  assert.deepEqual(out, { kind: 'refused', wanted: 7, resolved: false })
  assert.ok(m.logs.some((l) => l.level === 'warn' && /predates identity capture/.test(l.text)))
})
