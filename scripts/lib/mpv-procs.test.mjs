import test from 'node:test'
import assert from 'node:assert/strict'
import { mpvDescendantsOf, orphansAfterQuit, survivors } from './mpv-procs.mjs'

/**
 * The orphan check, against the two failures that were actually measured.
 *
 * Both harnesses counted mpv.exe machine-wide with `tasklist` and no
 * attribution, so both were wrong in both directions. These fixtures are the
 * two observed shapes, as process tables.
 */

const P = (pid, ppid, name, created = `t${pid}`) => ({ pid, ppid, name, created })

/** One app (pid 100) with one mpv (200), plus an unrelated tree. */
const RUNNING = [
  P(4, 0, 'System'),
  P(100, 4, 'RLPlayer.exe'),
  P(200, 100, 'mpv.exe'),
  P(101, 4, 'RLPlayer.exe'), // a DIFFERENT checkout, running in another window
  P(201, 101, 'mpv.exe'),
  P(202, 101, 'mpv.exe'),
  P(203, 101, 'mpv.exe'),
  P(204, 101, 'mpv.exe')
]

test('only the app under test owns its mpv; four strangers are invisible', () => {
  // THE FALSE RED, measured: `npm run check:network -- --launches=6 --seconds=10`
  // reported "FAILED: 4 orphaned mpv.exe" on an unchanged tree. All four
  // belonged to a different checkout; zero belonged to the app. It failed 3 of
  // 4 runs on identical bits and check-network.mjs:305 made it a hard red.
  assert.deepEqual(
    mpvDescendantsOf(RUNNING, 100).map((p) => p.pid),
    [200]
  )
  // …and the machine-wide count that used to be the answer.
  assert.equal(RUNNING.filter((p) => p.name === 'mpv.exe').length, 5)
})

test('an mpv two levels down still belongs to the app', () => {
  // A secondary engine spawned by a utility process, or mpv re-launched through
  // a shim, is still ours. Only walking the immediate parent would miss it.
  const tree = [P(100, 4, 'RLPlayer.exe'), P(150, 100, 'RLPlayer.exe'), P(250, 150, 'mpv.exe')]
  assert.deepEqual(
    mpvDescendantsOf(tree, 100).map((p) => p.pid),
    [250]
  )
})

test('a genuine orphan is reported even while an unrelated mpv exits', () => {
  // THE FALSE GREEN, and the worse of the two. e2e-overlay.mjs:331 was
  //   orphans = countMpv() - (mpvBefore - 1)
  // a DELTA over a machine-wide count. Here the app leaks pid 200 AND a
  // stranger's pid 204 exits in the same window, so the delta computes
  // 4 - (5 - 1) = 0 and the harness prints "0 orphan mpv" -- in the file whose
  // comment reads "THIS IS THE LINE THAT USED TO LIE".
  const before = mpvDescendantsOf(RUNNING, 100)
  const afterQuit = [
    P(4, 0, 'System'),
    P(200, 100, 'mpv.exe'), // ours, orphaned: the app is gone, this is not
    P(101, 4, 'RLPlayer.exe'),
    P(201, 101, 'mpv.exe'),
    P(202, 101, 'mpv.exe'),
    P(203, 101, 'mpv.exe')
    // 204 exited on its own during the quit window
  ]
  assert.deepEqual(orphansAfterQuit(before, afterQuit), [200])

  const oldDelta = afterQuit.filter((p) => p.name === 'mpv.exe').length - (5 - 1)
  assert.equal(oldDelta, 0, 'the delta formula reported a clean quit for this exact table')
})

test('a clean quit reports nothing, even when strangers arrive mid-window', () => {
  const before = mpvDescendantsOf(RUNNING, 100)
  const afterQuit = [
    P(101, 4, 'RLPlayer.exe'),
    P(201, 101, 'mpv.exe'),
    P(202, 101, 'mpv.exe'),
    P(203, 101, 'mpv.exe'),
    P(204, 101, 'mpv.exe'),
    P(205, 101, 'mpv.exe'), // a stranger STARTED during the quit
    P(206, 101, 'mpv.exe')
  ]
  assert.deepEqual(orphansAfterQuit(before, afterQuit), [])

  const oldDelta = afterQuit.filter((p) => p.name === 'mpv.exe').length - (5 - 1)
  assert.equal(oldDelta, 2, 'the delta formula reported 2 orphans for a perfectly clean quit')
})

test('a recycled pid is a different process, not a survivor', () => {
  // Windows reuses pids and a quit window is long enough for it to happen. A
  // survivor is a pid AND the creation time we recorded for it; without that,
  // an unrelated process inheriting pid 200 reads as our mpv refusing to die.
  const before = [{ pid: 200, created: 'A' }]
  assert.deepEqual(survivors(before, [P(200, 1, 'mpv.exe', 'B')]), [])
  assert.deepEqual(survivors(before, [P(200, 1, 'mpv.exe', 'A')]), [{ pid: 200, created: 'A' }])
})

test('a cycle in the process table terminates the ancestor walk', () => {
  // Two pids claiming each other as parent is possible after reuse, and an
  // unbounded walk hangs the harness rather than failing it.
  const cyc = [P(10, 11, 'a.exe'), P(11, 10, 'b.exe'), P(12, 10, 'mpv.exe')]
  assert.deepEqual(mpvDescendantsOf(cyc, 999), [])
  assert.deepEqual(
    mpvDescendantsOf(cyc, 10).map((p) => p.pid),
    [12]
  )
})
