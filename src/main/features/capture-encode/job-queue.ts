/**
 * M23 capture-encode — C18's queue, cancel and progress bookkeeping, with no
 * process and no Electron in it.
 *
 * C18's constraints, and each one is a number in this file rather than a comment
 * somewhere else:
 *
 *  - **Run one job at a time (max 2).** libx265 and libsvtav1 will saturate
 *    every core, and the playing mpv is the process that must not stutter.
 *  - **Cancel must actually kill the child.** §6.3's M23 row is "cancel a
 *    5-minute export and confirm the child process is gone from Task Manager",
 *    so cancel is not a flag the runner notices at the next chunk boundary: it
 *    aborts the run and the runner closes the engine.
 *  - **A queued job cancels without ever having spawned**, which is the case a
 *    "kill the child" implementation forgets.
 *
 * The runner is injected, so the whole state machine is testable against a fake
 * that never spawns anything.
 */

/**
 * Declared once, in `src/shared/features/capture-encode/wire.ts`, and re-exported
 * here so nothing inside this module has to change its import. Both halves cross
 * IPC with these, so the compiler — not a parity test — is what keeps them equal.
 */
import type { JobKind, JobState } from '@shared/features/capture-encode/wire'
export type { JobKind, JobState }

export interface JobResult {
  /** The file (or first file, for a burst) the job produced. */
  readonly output?: string | undefined
  readonly message?: string | undefined
}

export interface Job {
  readonly id: string
  readonly kind: JobKind
  /** Already-localised, for the OSD. The queue never calls t() itself. */
  readonly label: string
  readonly outputFile: string
  state: JobState
  /** 0..1, or undefined while the job has produced no position yet. */
  fraction: number | undefined
  error: string | undefined
}

/** What the runner is handed. `signal.cancelled` is polled AND pushed. */
export interface RunSignal {
  readonly cancelled: boolean
  /** Called when cancel arrives while the job is already running. */
  onCancel(cb: () => void): void
}

export type JobRunner = (job: Job, signal: RunSignal) => Promise<JobResult>

export interface QueueEvents {
  onChange?(jobs: readonly Job[]): void
  onStart?(job: Job): void
  onFinish?(job: Job, result: JobResult): void
}

interface Entry {
  job: Job
  runner: JobRunner
  cancelled: boolean
  cancelCbs: Array<() => void>
  settle: (r: JobResult) => void
}

export class JobQueue {
  #maxConcurrent: number
  readonly #events: QueueEvents
  readonly #entries: Entry[] = []
  #seq = 0
  #pumping = false

  constructor(maxConcurrent: number, events: QueueEvents = {}) {
    this.#maxConcurrent = clampConcurrency(maxConcurrent)
    this.#events = events
  }

  get maxConcurrent(): number {
    return this.#maxConcurrent
  }

  setMaxConcurrent(n: number): void {
    this.#maxConcurrent = clampConcurrency(n)
    this.#pump()
  }

  jobs(): readonly Job[] {
    return this.#entries.map((e) => e.job)
  }

  get runningCount(): number {
    return this.#entries.filter((e) => e.job.state === 'running').length
  }

  get activeCount(): number {
    return this.#entries.filter((e) => e.job.state === 'queued' || e.job.state === 'running').length
  }

  find(id: string): Job | undefined {
    return this.#entries.find((e) => e.job.id === id)?.job
  }

  nextId(kind: JobKind): string {
    this.#seq += 1
    return `${kind}-${this.#seq}`
  }

  /** Resolves when the job reaches a terminal state, whichever one. */
  enqueue(
    spec: { id: string; kind: JobKind; label: string; outputFile: string },
    runner: JobRunner
  ): Promise<JobResult> {
    const job: Job = {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      outputFile: spec.outputFile,
      state: 'queued',
      fraction: undefined,
      error: undefined
    }
    let settle: (r: JobResult) => void = () => {}
    const promise = new Promise<JobResult>((resolve) => {
      settle = resolve
    })
    this.#entries.push({ job, runner, cancelled: false, cancelCbs: [], settle })
    this.#changed()
    this.#pump()
    return promise
  }

  /** Report progress for a running job. Clamped, so a bad reply cannot exceed 1. */
  progress(id: string, fraction: number): void {
    const e = this.#entries.find((x) => x.job.id === id)
    if (!e || e.job.state !== 'running') return
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : undefined
    if (e.job.fraction === f) return
    e.job.fraction = f
    this.#changed()
  }

  /**
   * Cancel one job, whether it is queued or running.
   *
   * A queued job never reaches its runner at all — it goes straight to
   * `cancelled` — which is the half a "kill the child process" implementation
   * misses and which matters here because the queue is one deep by default: the
   * second export a user starts and immediately regrets has no child yet.
   */
  cancel(id: string): boolean {
    const e = this.#entries.find((x) => x.job.id === id)
    if (!e) return false
    if (e.job.state === 'done' || e.job.state === 'failed' || e.job.state === 'cancelled') {
      return false
    }
    e.cancelled = true
    if (e.job.state === 'queued') {
      e.job.state = 'cancelled'
      this.#changed()
      const result: JobResult = { message: 'cancelled' }
      this.#events.onFinish?.(e.job, result)
      e.settle(result)
      this.#pump()
      return true
    }
    for (const cb of e.cancelCbs.splice(0)) {
      try {
        cb()
      } catch {
        /* a cancel hook that throws must not stop the other hooks */
      }
    }
    return true
  }

  cancelAll(): number {
    let n = 0
    // A copy: cancelling mutates state and can start the next job.
    for (const e of [...this.#entries]) if (this.cancel(e.job.id)) n++
    return n
  }

  /** Drop finished rows. The OSD keeps its own history; this is the live list. */
  prune(): void {
    const before = this.#entries.length
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const s = (this.#entries[i] as Entry).job.state
      if (s === 'done' || s === 'failed' || s === 'cancelled') this.#entries.splice(i, 1)
    }
    if (this.#entries.length !== before) this.#changed()
  }

  #changed(): void {
    this.#events.onChange?.(this.jobs())
  }

  #pump(): void {
    // Re-entrancy guard: a runner that resolves synchronously would otherwise
    // recurse through #finish -> #pump -> run for the whole queue.
    if (this.#pumping) return
    this.#pumping = true
    try {
      for (const e of this.#entries) {
        if (this.runningCount >= this.#maxConcurrent) break
        if (e.job.state !== 'queued' || e.cancelled) continue
        this.#start(e)
      }
    } finally {
      this.#pumping = false
    }
  }

  #start(e: Entry): void {
    e.job.state = 'running'
    e.job.fraction = undefined
    this.#changed()
    this.#events.onStart?.(e.job)

    const signal: RunSignal = {
      get cancelled(): boolean {
        return e.cancelled
      },
      onCancel(cb): void {
        if (e.cancelled) cb()
        else e.cancelCbs.push(cb)
      }
    }

    void (async () => {
      try {
        const r = await e.runner(e.job, signal)
        this.#finish(e, e.cancelled ? 'cancelled' : 'done', r)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.#finish(e, e.cancelled ? 'cancelled' : 'failed', { message })
      }
    })()
  }

  #finish(e: Entry, state: JobState, result: JobResult): void {
    if (e.job.state !== 'running') return
    e.job.state = state
    if (state === 'done') e.job.fraction = 1
    if (state === 'failed') e.job.error = result.message
    e.cancelCbs.length = 0
    this.#changed()
    this.#events.onFinish?.(e.job, result)
    e.settle(result)
    this.#pump()
  }
}

export function clampConcurrency(n: number): number {
  // C18: "Run one job at a time (max 2)".
  const v = Number.isFinite(n) ? Math.round(n) : 1
  return v < 1 ? 1 : v > 2 ? 2 : v
}
