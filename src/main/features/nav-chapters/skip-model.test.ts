import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TUNING,
  MAX_FOLDERS,
  MAX_OBSERVATIONS,
  applyProposal,
  classifyJump,
  clearPoint,
  enteredWindow,
  evictOldest,
  folderKey,
  formatClock,
  jumpKind,
  learnEnding,
  learnIntro,
  median,
  observationFile,
  planAutoSkip,
  planManualSkip,
  recordObservation,
  resolveWindows,
  sanitizeStore,
  sanitizeWindow,
  setPoint,
  windowAt,
  type SkipObservation,
  type SkipStoreData,
  type SkipWindow
} from './skip-model.ts'

/**
 * N51's decision layer, asserted on RESULTS.
 *
 * Every case below is a value the row calls non-negotiable or a case a plausible
 * implementation gets wrong, and three of them are defects that were in the
 * draft of this module and are fixed here:
 *
 *   - `planManualSkip` was unreachable, and the inline replacement in
 *     skip-intro.ts ended the episode when the ending key was pressed at 00:30;
 *   - its intro fallback clamped to `duration` rather than to the EOF margin, so
 *     the intro key closed a film when pressed near the end;
 *   - `learnIntro` took the MEDIAN of the observed press positions as the window
 *     start, which pushed the offer later than the point the user twice asked
 *     for.
 *
 * Nothing here asserts "a function was called". Every assertion is a number, a
 * refusal reason or the absence of a window.
 */

const FALLBACK = { introSeconds: 90, endingSeconds: 150 }
const EOF = 0.35

const obs = (file: string, from: number, to: number, duration = 1200): SkipObservation => ({
  file,
  from,
  to,
  duration,
  at: 1000
})

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('folderKey folds Windows case and separators, and an empty prefix means the folder', () => {
  const a = folderKey('D:\\Anime\\Show\\Show S01E01.mkv', 'Show')
  const b = folderKey('d:/anime/show/Show S01E02.mkv', 'show')
  assert.equal(a, b)
  assert.equal(folderKey('D:\\Anime\\Show\\x.mkv', ''), 'd:/anime/show|')
  // A different series in the SAME folder is a different key, which is the whole
  // reason the prefix is part of it.
  assert.notEqual(
    folderKey('D:\\Mixed\\Alpha S01E01.mkv', 'Alpha'),
    folderKey('D:\\Mixed\\Beta S01E01.mkv', 'Beta')
  )
})

test('observationFile stores a basename, never a path', () => {
  assert.equal(observationFile('D:\\Anime\\Show\\ep 3.mkv'), 'ep 3.mkv')
})

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

test('sanitizeWindow drops a window that would seek somewhere absurd', () => {
  assert.equal(sanitizeWindow(null), undefined)
  assert.equal(sanitizeWindow({ introStart: 100, introEnd: 40, source: 'manual' }), undefined)
  assert.equal(sanitizeWindow({ introEnd: -5, source: 'manual' }), undefined)
  // Half a record is normal: "set intro start here" is one of three keypresses.
  const introOnly = sanitizeWindow({ introEnd: 95, source: 'manual', updatedAt: 7 })
  assert.deepEqual(introOnly, { source: 'manual', updatedAt: 7, introEnd: 95 })
})

test('sanitizeWindow derives endingLead from a record written without one', () => {
  const w = sanitizeWindow({ endingStart: 1100, refDuration: 1220, source: 'manual' })
  assert.equal(w?.endingLead, 120)
  // and refuses a lead of zero, which would resolve to "seek to the last frame"
  assert.equal(sanitizeWindow({ endingStart: 1200, refDuration: 1200, source: 'manual' }), undefined)
})

test('sanitizeStore carries an unknown top-level key and rejects a non-object', () => {
  const out = sanitizeStore({
    version: 99,
    somethingFuture: { a: 1 },
    folders: {
      'd:/x|Show': { window: { introEnd: 90, source: 'learned', updatedAt: 5 } },
      'd:/y|Bad': { window: { introEnd: 0 } },
      'd:/z|Str': 'nope'
    }
  })
  assert.equal(out.version, 1)
  assert.deepEqual(out['somethingFuture'], { a: 1 })
  assert.deepEqual(Object.keys(out.folders), ['d:/x|Show'])
  assert.deepEqual(sanitizeStore([1, 2, 3]).folders, {})
  assert.deepEqual(sanitizeStore('garbage').folders, {})
})

test('sanitizeStore caps the observation list per folder', () => {
  const many = Array.from({ length: MAX_OBSERVATIONS + 9 }, (_, i) =>
    obs(`ep${i}.mkv`, 10 + i, 100 + i)
  )
  const out = sanitizeStore({ folders: { k: { intro: many } } })
  assert.equal(out.folders['k']?.intro?.length, MAX_OBSERVATIONS)
})

test('evictOldest keeps the newest folders by any timestamp in the record', () => {
  const folders: SkipStoreData['folders'] = {}
  for (let i = 0; i < MAX_FOLDERS + 3; i++) {
    folders[`k${i}`] = { window: { source: 'manual', updatedAt: i, introEnd: 90 } }
  }
  const out = evictOldest({ version: 1, folders }, MAX_FOLDERS)
  assert.equal(Object.keys(out.folders).length, MAX_FOLDERS)
  assert.equal(out.folders['k0'], undefined)
  assert.ok(out.folders[`k${MAX_FOLDERS + 2}`])
  // An observation timestamp counts as recency too, not only the window's.
  const mixed = evictOldest(
    {
      version: 1,
      folders: {
        old: { window: { source: 'manual', updatedAt: 1, introEnd: 90 } },
        obsOnly: { intro: [obs('a.mkv', 5, 95)] }
      }
    },
    1
  )
  assert.deepEqual(Object.keys(mixed.folders), ['obsOnly'])
})

// ---------------------------------------------------------------------------
// Resolving a folder record onto the file that is playing
// ---------------------------------------------------------------------------

test('the ending is a LEAD, so a shorter sibling gets the ending at the right place', () => {
  // Set on a 1220 s episode at 1100 s: 120 s before the end.
  const w = setPoint(undefined, 'endingStart', 1100, 1220, 1)
  assert.equal(w.endingLead, 120)
  // A sibling that is 40 s shorter must not get 1100.
  const r = resolveWindows(w, 1180)
  assert.equal(r.ending?.start, 1060)
  assert.equal(r.ending?.end, 1180)
  // ...and the absolute anchor is what the person with one runtime asks for.
  assert.equal(resolveWindows(w, 1180, 'absolute').ending?.start, 1100)
})

test('a live stream has no ending window at all, but keeps its intro', () => {
  const w: SkipWindow = { introEnd: 95, endingLead: 120, source: 'manual', updatedAt: 0 }
  const r = resolveWindows(w, 0)
  assert.deepEqual(r.intro, { start: 0, end: 95 })
  assert.equal(r.ending, undefined)
})

test('an ending that would land inside the intro or at second one is dropped', () => {
  const w: SkipWindow = { introEnd: 95, endingLead: 1195, source: 'manual', updatedAt: 0 }
  // duration 1200 => ending would start at 5, i.e. before the intro ends.
  assert.equal(resolveWindows(w, 1200).ending, undefined)
  // A lead longer than the file is a record about some other file.
  assert.equal(
    resolveWindows({ endingLead: 4000, source: 'manual', updatedAt: 0 }, 1200).ending,
    undefined
  )
})

test('enteredWindow fires on ENTRY, and treats the first tick of a file as one', () => {
  const w = resolveWindows({ introEnd: 100, source: 'manual', updatedAt: 0 }, 1200)
  assert.equal(enteredWindow(null, 30, w), 'intro')
  assert.equal(enteredWindow(29, 30, w), null, 'already inside is not an entry')
  assert.equal(enteredWindow(101, 30, w), 'intro', 'a seek back in re-enters')
  assert.equal(enteredWindow(99, 120, w), null)
  assert.equal(windowAt(100, w), null, 'the window is [start, end)')
  assert.equal(windowAt(99.9, w), 'intro')
})

// ---------------------------------------------------------------------------
// planManualSkip -- the three cases the obvious version gets wrong
// ---------------------------------------------------------------------------

test('skip-ending at 00:30 with no stored window REFUSES instead of ending the file', () => {
  const p = planManualSkip('ending', 30, 1200, {}, FALLBACK, EOF)
  assert.equal(p.ok, false)
  assert.equal(p.ok === false && p.reason, 'no-window')
  // and it says where the key would start working, so the OSD can be useful
  assert.equal(p.ok === false && p.at, 1050)
})

test('skip-ending inside the last 150 s with no window jumps to the EOF margin', () => {
  const p = planManualSkip('ending', 1100, 1200, {}, FALLBACK, EOF)
  assert.equal(p.ok, true)
  assert.equal(p.ok && p.via, 'fallback')
  assert.equal(p.ok && p.target, 1199.65)
})

test('skip-ending before a stored ending window refuses and names the window start', () => {
  const w = resolveWindows({ endingLead: 120, source: 'manual', updatedAt: 0 }, 1200)
  const p = planManualSkip('ending', 300, 1200, w, FALLBACK, EOF)
  assert.equal(p.ok === false && p.reason, 'before-window')
  assert.equal(p.ok === false && p.at, 1080)
  const inside = planManualSkip('ending', 1100, 1200, w, FALLBACK, EOF)
  assert.equal(inside.ok && inside.target, 1199.65)
  assert.equal(inside.ok && inside.via, 'window')
})

test('skip-ending on a stream with no duration refuses with no-duration', () => {
  const p = planManualSkip('ending', 30, 0, {}, FALLBACK, EOF)
  assert.equal(p.ok === false && p.reason, 'no-duration')
})

test('skip-intro past the intro window does not seek BACKWARDS', () => {
  const w = resolveWindows({ introStart: 10, introEnd: 100, source: 'manual', updatedAt: 0 }, 1200)
  const p = planManualSkip('intro', 900, 1200, w, FALLBACK, EOF)
  assert.equal(p.ok && p.via, 'fallback')
  assert.equal(p.ok && p.target, 990)
  assert.ok(p.ok && p.target > 900)
})

test('skip-intro near the end of a file clamps to the EOF margin, not to duration', () => {
  // THE REGRESSION. The draft clamped to `duration`, and a seek to exactly
  // `duration` ends the file -- so the intro key closed a film pressed 30 s from
  // the end. 1200 - 0.35, never 1200.
  const p = planManualSkip('intro', 1170, 1200, {}, FALLBACK, EOF)
  assert.equal(p.ok && p.target, 1199.65)
  assert.ok(p.ok && p.target < 1200, 'a target of exactly `duration` ends the episode')
})

test('skip-intro with no duration still works, because an intro needs none', () => {
  const p = planManualSkip('intro', 5, 0, {}, FALLBACK, EOF)
  assert.equal(p.ok && p.target, 95)
})

// ---------------------------------------------------------------------------
// planAutoSkip -- deliberately narrower than the manual plan
// ---------------------------------------------------------------------------

test('planAutoSkip has NO fallback: nothing unrecorded ever moves playback', () => {
  assert.equal(planAutoSkip('intro', 1200, {}, EOF).ok, false)
  assert.equal(planAutoSkip('ending', 1200, {}, EOF).ok, false)
  const w = resolveWindows({ introEnd: 100, endingLead: 120, source: 'manual', updatedAt: 0 }, 1200)
  const intro = planAutoSkip('intro', 1200, w, EOF)
  assert.equal(intro.ok && intro.target, 100)
  assert.equal(intro.ok && intro.via, 'window')
  const ending = planAutoSkip('ending', 1200, w, EOF)
  assert.equal(ending.ok && ending.target, 1199.65)
})

// ---------------------------------------------------------------------------
// Tier 2 -- learning
// ---------------------------------------------------------------------------

test('jumpKind separates playback from a seek', () => {
  assert.equal(jumpKind(10, 11, DEFAULT_TUNING), null)
  assert.equal(jumpKind(10, 40, DEFAULT_TUNING), 'forward')
  assert.equal(jumpKind(40, 10, DEFAULT_TUNING), 'backward')
})

test('classifyJump puts a late-file jump on the ending, not the intro', () => {
  // A 20-minute episode: the intro zone (600 s) and the ending zone (900 s)
  // overlap, and the ending test has to win in the overlap.
  assert.equal(classifyJump(700, 1150, 1200, DEFAULT_TUNING), 'ending')
  assert.equal(classifyJump(5, 95, 1200, DEFAULT_TUNING), 'intro')
  assert.equal(classifyJump(700, 750, 3600, DEFAULT_TUNING), null, 'mid-film is neither')
  assert.equal(classifyJump(95, 5, 1200, DEFAULT_TUNING), null, 'backwards is not evidence')
})

test('two DISTINCT episodes are evidence; one episode fumbled four times is not', () => {
  const sameFile = [
    obs('ep1.mkv', 5, 95),
    obs('ep1.mkv', 6, 96),
    obs('ep1.mkv', 4, 94),
    obs('ep1.mkv', 5, 95)
  ]
  assert.equal(learnIntro(sameFile, DEFAULT_TUNING), null)
  const twoFiles = [obs('ep1.mkv', 5, 95), obs('ep2.mkv', 8, 96)]
  const p = learnIntro(twoFiles, DEFAULT_TUNING)
  assert.equal(p?.kind, 'intro')
  assert.deepEqual(p?.files.sort(), ['ep1.mkv', 'ep2.mkv'])
})

test('the intro window arms at the EARLIEST press, not the median of them', () => {
  // THE REGRESSION. With the median, two presses at 0:05 and 0:40 gave a start
  // of 0:22, so on episode 3 the offer arrived 17 s after the point the user had
  // twice asked for. The end is a consensus; the start is a minimum.
  const p = learnIntro([obs('ep1.mkv', 5, 95), obs('ep2.mkv', 40, 96)], DEFAULT_TUNING)
  assert.equal(p?.introStart, 5)
  assert.equal(p?.introEnd, 95.5)
})

test('a target outside the tolerance is a different window and proposes nothing', () => {
  const spread = [obs('ep1.mkv', 5, 95), obs('ep2.mkv', 5, 300)]
  assert.equal(learnIntro(spread, DEFAULT_TUNING), null)
})

test('learnEnding clusters on the LEAD, so different runtimes still agree', () => {
  const list = [
    obs('ep1.mkv', 1080, 1200, 1200), // lead 120
    obs('ep2.mkv', 1060, 1180, 1180) // lead 120, different runtime
  ]
  const p = learnEnding(list, DEFAULT_TUNING)
  assert.equal(p?.endingLead, 120)
  // The same two absolute times with the same runtime would cluster too, but the
  // point is that these do NOT agree on `from` at all.
  assert.notEqual(list[0]?.from, list[1]?.from)
})

test('learnEnding ignores observations with no duration, which cannot yield a lead', () => {
  const list = [obs('ep1.mkv', 1080, 1200, 0), obs('ep2.mkv', 1060, 1180, 0)]
  assert.equal(learnEnding(list, DEFAULT_TUNING), null)
})

test('recordObservation keeps one entry per episode, newest first', () => {
  let list = recordObservation(undefined, obs('ep1.mkv', 5, 95))
  list = recordObservation(list, obs('ep2.mkv', 6, 96))
  list = recordObservation(list, obs('EP1.MKV', 7, 97))
  assert.equal(list.length, 2)
  assert.equal(list[0]?.file, 'EP1.MKV')
  assert.equal(list[0]?.to, 97)
})

test('median is the midpoint of an even list, not a member of it', () => {
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), 0)
})

// ---------------------------------------------------------------------------
// Proposals and set points -- "proposes, never applies"
// ---------------------------------------------------------------------------

test('a proposal is not a window until applyProposal is called', () => {
  const p = learnIntro([obs('ep1.mkv', 5, 95), obs('ep2.mkv', 6, 96)], DEFAULT_TUNING)
  assert.ok(p)
  // The proposal type carries no `source` and no `updatedAt`, so it cannot be
  // stored as a window by accident: the store's shape rejects it structurally.
  assert.equal((p as unknown as Record<string, unknown>)['source'], undefined)
  const w = applyProposal(undefined, p, 'learned', 42)
  assert.equal(w.source, 'learned')
  assert.equal(w.updatedAt, 42)
  assert.equal(w.introEnd, 95.5)
})

test('applying an ending proposal drops the stale absolute record it replaces', () => {
  const existing = setPoint(undefined, 'endingStart', 1100, 1220, 1)
  assert.equal(existing.endingStart, 1100)
  const w = applyProposal(
    existing,
    { kind: 'ending', endingLead: 90, files: ['a', 'b'] },
    'fingerprint',
    5
  )
  assert.equal(w.endingLead, 90)
  assert.equal(w.endingStart, undefined, 'a stale absolute point would win under `absolute`')
  assert.equal(w.refDuration, undefined)
})

test('setPoint keeps the intro pair ordered rather than storing a window that vanishes', () => {
  const withEnd = setPoint(undefined, 'introEnd', 95, 1200, 1)
  const past = setPoint(withEnd, 'introStart', 200, 1200, 2)
  assert.equal(past.introEnd, undefined, 'a start past the end drops the end')
  const start = setPoint(undefined, 'introStart', 200, 1200, 1)
  const before = setPoint(start, 'introEnd', 100, 1200, 2)
  assert.equal(before.introStart, 0, 'an end before the start resets the start')
  assert.equal(before.introEnd, 100)
  // Either way the result is a window resolveWindows will actually apply.
  assert.ok(resolveWindows(before, 1200).intro)
})

test('clearPoint removes only its own half, and the whole record when empty', () => {
  let w: SkipWindow | undefined = setPoint(undefined, 'introEnd', 95, 1200, 1)
  w = setPoint(w, 'endingStart', 1080, 1200, 1)
  w = clearPoint(w, 'intro', 2)
  assert.equal(w?.introEnd, undefined)
  assert.equal(w?.endingLead, 120)
  w = clearPoint(w, 'ending', 3)
  assert.equal(w, undefined)
  assert.equal(clearPoint(undefined, 'intro', 4), undefined)
})

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(95.9), '1:35')
  assert.equal(formatClock(3725), '1:02:05')
  assert.equal(formatClock(-5), '0:00')
})
