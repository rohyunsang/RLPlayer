/**
 * M23 capture-encode — C18's queue, with no process in it.
 *
 * Every assertion here is on the queue's resulting STATE, not on the fact that a
 * runner was called. The runners are fakes, so "the runner ran" is trivially
 * true and says nothing about whether the job the user sees is queued, running,
 * cancelled or wrong.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JobQueue, clampConcurrency, type Job, type JobResult, type RunSignal } from './job-queue.ts'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const spec = (id: string): { id: string; kind: 'clip'; label: string; outputFile: string } => ({
  id,
  kind: 'clip',
  label: `job ${id}`,
  outputFile: `C:/out/${id}.mp4`
})

/** A runner that only finishes when the test says so. */
function held(): {
  run: (job: Job, s: RunSignal) => Promise<JobResult>
  finish: (r?: JobResult) => void
  started: () => boolean
  signal: () => RunSignal | null
} {
  let release: ((r: JobResult) => void) | null = null
  let sig: RunSignal | null = null
  return {
    run: (_job, s) =>
      new Promise<JobResult>((resolve) => {
        sig = s
        release = resolve
      }),
    finish: (r = { output: 'C:/out/a.mp4' }) => release?.(r),
    started: () => release !== null,
    signal: () => sig
  }
}

// ---------------------------------------------------------------------------

test('C18: one job runs and the rest wait', async () => {
  const q = new JobQueue(1)
  const a = held()
  const b = held()
  void q.enqueue(spec('a'), a.run)
  void q.enqueue(spec('b'), b.run)
  await tick()

  assert.equal(q.find('a')?.state, 'running')
  assert.equal(q.find('b')?.state, 'queued')
  assert.equal(b.started(), false, 'the second job must not have a process yet')
  assert.equal(q.runningCount, 1)
  assert.equal(q.activeCount, 2)

  a.finish()
  await tick()
  assert.equal(q.find('a')?.state, 'done')
  assert.equal(q.find('b')?.state, 'running')
  b.finish()
  await tick()
})

test('concurrency is clamped to C18\'s "one at a time (max 2)"', async () => {
  assert.equal(clampConcurrency(0), 1)
  assert.equal(clampConcurrency(1), 1)
  assert.equal(clampConcurrency(2), 2)
  assert.equal(clampConcurrency(8), 2)
  assert.equal(clampConcurrency(Number.NaN), 1)
  assert.equal(clampConcurrency(1.6), 2)

  // Raising the limit starts a waiting job immediately: libx265 saturating every
  // core is the reason the default is 1, and the setting must take effect
  // without a restart.
  const q = new JobQueue(1)
  const a = held()
  const b = held()
  void q.enqueue(spec('a'), a.run)
  void q.enqueue(spec('b'), b.run)
  await tick()
  assert.equal(q.find('b')?.state, 'queued')
  q.setMaxConcurrent(2)
  await tick()
  assert.equal(q.find('b')?.state, 'running')
  a.finish()
  b.finish()
  await tick()
})

test('cancelling a QUEUED job never reaches its runner', async () => {
  // The half a "kill the child process" implementation misses, and the one that
  // matters most with a one-deep queue: the second export a user starts and
  // immediately regrets has no child to kill.
  const q = new JobQueue(1)
  const a = held()
  let bRan = false
  void q.enqueue(spec('a'), a.run)
  const bDone = q.enqueue(spec('b'), async () => {
    bRan = true
    return {}
  })
  await tick()

  assert.equal(q.cancel('b'), true)
  const r = await bDone
  assert.equal(r.message, 'cancelled')
  assert.equal(q.find('b')?.state, 'cancelled')
  assert.equal(bRan, false)
  a.finish()
  await tick()
})

test('cancelling a RUNNING job pushes the signal through to the runner', async () => {
  const q = new JobQueue(1)
  const a = held()
  const done = q.enqueue(spec('a'), a.run)
  await tick()

  let cancelSeen = false
  a.signal()?.onCancel(() => {
    cancelSeen = true
  })
  assert.equal(a.signal()?.cancelled, false)
  assert.equal(q.cancel('a'), true)
  assert.equal(cancelSeen, true, 'the runner was never told')
  assert.equal(a.signal()?.cancelled, true)

  // The runner rejects, as `runEncode` does, and the job is CANCELLED rather
  // than FAILED — a user who cancelled must not get an error toast.
  a.finish()
  await done
  assert.equal(q.find('a')?.state, 'cancelled')
})

test('a runner that rejects after cancel is reported as cancelled, not failed', async () => {
  const q = new JobQueue(1)
  let sig: RunSignal | null = null
  const done = q.enqueue(spec('a'), async (_j, s) => {
    sig = s
    await new Promise((r) => setTimeout(r, 5))
    if (s.cancelled) throw new Error('cancelled')
    return {}
  })
  await tick()
  assert.ok(sig)
  q.cancel('a')
  const r = await done
  assert.equal(q.find('a')?.state, 'cancelled')
  assert.equal(q.find('a')?.error, undefined, 'a cancelled job has no error to show')
  assert.equal(r.message, 'cancelled')
})

test('a failing runner keeps its message and does not stall the queue', async () => {
  const q = new JobQueue(1)
  const bad = q.enqueue(spec('a'), async () => {
    throw new Error('video output initialization failed')
  })
  const b = held()
  void q.enqueue(spec('b'), b.run)
  const r = await bad
  await tick()
  assert.equal(q.find('a')?.state, 'failed')
  assert.equal(q.find('a')?.error, 'video output initialization failed')
  assert.equal(r.message, 'video output initialization failed')
  assert.equal(q.find('b')?.state, 'running')
  b.finish()
  await tick()
})

test('a non-Error throw still produces a message', async () => {
  const q = new JobQueue(1)
  const r = await q.enqueue(spec('a'), async () => {
    throw 'plain string'
  })
  assert.equal(r.message, 'plain string')
  assert.equal(q.find('a')?.state, 'failed')
})

test('cancelAll clears both the running and the queued, and counts', async () => {
  const q = new JobQueue(1)
  const a = held()
  void q.enqueue(spec('a'), a.run)
  void q.enqueue(spec('b'), async () => ({}))
  void q.enqueue(spec('c'), async () => ({}))
  await tick()
  assert.equal(q.cancelAll(), 3)
  a.finish()
  await tick()
  assert.deepEqual(
    q.jobs().map((j) => j.state),
    ['cancelled', 'cancelled', 'cancelled']
  )
  // Nothing left to cancel, and cancelling a terminal job is not an error.
  assert.equal(q.cancelAll(), 0)
  assert.equal(q.cancel('a'), false)
  assert.equal(q.cancel('nope'), false)
})

test('progress is clamped, ignored for non-running jobs, and deduplicated', async () => {
  const q = new JobQueue(1)
  const changes: number[] = []
  const q2 = new JobQueue(1, { onChange: (jobs) => changes.push(jobs.length) })
  void q2.enqueue(spec('a'), held().run)
  await tick()

  q2.progress('a', 0.5)
  q2.progress('a', 0.5)
  assert.equal(q2.find('a')?.fraction, 0.5)
  q2.progress('a', 4)
  assert.equal(q2.find('a')?.fraction, 1)
  q2.progress('a', -2)
  assert.equal(q2.find('a')?.fraction, 0)
  q2.progress('a', Number.NaN)
  assert.equal(q2.find('a')?.fraction, undefined, 'NaN is "unknown", not 0')

  // A queued job has no position to report.
  void q.enqueue(spec('x'), held().run)
  void q.enqueue(spec('y'), held().run)
  await tick()
  q.progress('y', 0.9)
  assert.equal(q.find('y')?.fraction, undefined)
  q.progress('missing', 0.5)
})

test('a done job reads 100%, and prune keeps only the live rows', async () => {
  const q = new JobQueue(1)
  const done = q.enqueue(spec('a'), async () => ({ output: 'C:/out/a.mp4' }))
  await done
  assert.equal(q.find('a')?.fraction, 1)

  const live = held()
  void q.enqueue(spec('b'), live.run)
  await tick()
  q.prune()
  assert.deepEqual(
    q.jobs().map((j) => j.id),
    ['b']
  )
  live.finish()
  await tick()
})

test('ids are unique per kind and monotonic', () => {
  const q = new JobQueue(1)
  assert.equal(q.nextId('clip'), 'clip-1')
  assert.equal(q.nextId('gif'), 'gif-2')
  assert.equal(q.nextId('clip'), 'clip-3')
})

test('onStart and onFinish fire once each, in order', async () => {
  const seen: string[] = []
  const q = new JobQueue(1, {
    onStart: (j) => seen.push(`start:${j.id}`),
    onFinish: (j) => seen.push(`finish:${j.id}:${j.state}`)
  })
  await q.enqueue(spec('a'), async () => ({}))
  await q.enqueue(spec('b'), async () => {
    throw new Error('nope')
  })
  assert.deepEqual(seen, ['start:a', 'finish:a:done', 'start:b', 'finish:b:failed'])
})

test('a synchronous runner cannot recurse the pump', async () => {
  // The re-entrancy guard: #finish calls #pump, and a runner that resolves
  // synchronously would otherwise re-enter for the whole queue.
  const q = new JobQueue(1)
  const order: string[] = []
  const all = [1, 2, 3, 4].map((n) =>
    q.enqueue(spec(`j${n}`), async () => {
      order.push(`j${n}`)
      return {}
    })
  )
  await Promise.all(all)
  assert.deepEqual(order, ['j1', 'j2', 'j3', 'j4'])
  assert.equal(q.activeCount, 0)
})

test('a cancel hook that throws does not stop the others', async () => {
  const q = new JobQueue(1)
  let second = false
  const done = q.enqueue(spec('a'), async (_j, s) => {
    s.onCancel(() => {
      throw new Error('bad hook')
    })
    s.onCancel(() => {
      second = true
    })
    await new Promise((r) => setTimeout(r, 5))
    return {}
  })
  await tick()
  assert.equal(q.cancel('a'), true)
  assert.equal(second, true)
  await done
})

test('onCancel after cancel fires immediately', async () => {
  const q = new JobQueue(1)
  let fired = false
  const done = q.enqueue(spec('a'), async (_j, s) => {
    await new Promise((r) => setTimeout(r, 5))
    // The runner registers late — the shape `runEncode` has while it awaits its
    // spawn. It must still learn that cancel already happened.
    s.onCancel(() => {
      fired = true
    })
    return {}
  })
  await tick()
  q.cancel('a')
  await done
  assert.equal(fired, true)
})
