/**
 * M23 capture-encode — the half that owns a child process.
 *
 * ONE mpv per job, spawned through `ctx.engine.spawn()` (§12) and never through
 * `child_process`: core registers every secondary, reaps them on the quit path
 * before the playing mpv, and has a synchronous `process.on('exit')` fallback.
 * "No orphan mpv on quit" is a v0.1 guarantee and §6.3's M23 row tests it
 * directly — "cancel a 5-minute export and confirm the child process is gone
 * from Task Manager".
 *
 * THIS FILE WAS REWRITTEN, and the reason is a measurement rather than taste.
 * The first draft ran each job the way the §2.4 rows are written for a shell:
 * `--idle=no` plus the source on the command line, so mpv would encode on
 * startup and exit by itself. Through `ctx.engine.spawn()` that is unworkable,
 * and it fails in the direction that hurts — a success reported as a failure,
 * late:
 *
 *   2 s clip, 320x240, libx264, --idle=no, source on the command line
 *     [  161 ms] mpv exited 0; the output was a valid 15,269-byte MP4
 *     [15016 ms] core's client.connect() gave up: "connect timeout"
 *                ctx.engine.spawn() THREW. No progress had been reported.
 *
 * `MpvClient.connect()` retries for a fixed 15 s, and once the encode has
 * finished there is no pipe left to connect to — so every job shorter than the
 * handshake ended in a 15-second stall and an error message. The draft did try
 * to rescue that case by treating "spawn threw but the output exists" as
 * success, which is a check that lies in the other direction too: at EOF a
 * container's bytes are on disk but its trailer is not, and a partially written
 * MP4 is `size > 0`. Measured below.
 *
 * THE SHAPE THAT WORKS, and every number here is from the pinned binary
 * (mpv v0.41.0-923-g7b8915bc1) driven over JSON IPC exactly as core spawns:
 *
 *   1. spawn with core's `--idle=yes` INTACT and encode options only. mpv comes
 *      up idle, so the pipe is always there: connected at 145 ms.
 *   2. `observe_property time-pos`, then `loadfile <source> replace`. Encoding
 *      starts on the reply (`error: "success"`), and progress is complete
 *      rather than starting halfway: 3150 samples on a 60 s job, 52 on a 2 s
 *      one. The command-line `--start`/`--end` still apply to a file loaded
 *      afterwards — `--start=2 --end=4` on a 6 s source produced 26,733 bytes
 *      against the whole file's 67,357.
 *   3. wait for `end-file`. This is the ONLY completion signal and the only
 *      failure channel: `SecondaryEngine` exposes no exit code, no exit event
 *      and no stderr. `{reason:'eof'}` is success; `{reason:'error',
 *      file_error:'video output initialization failed'}` is what all three
 *      unavailable hardware encoders on this machine answered.
 *   4. `await engine.close()`, which sends `quit`, and ONLY THEN look at the
 *      file. **The output is not valid until the process is gone.** At `end-file`
 *      the WebP was 0 bytes, the MP3 0, the M4A 44 and the GIF 786,432; after
 *      quit, 42,742 / 72,768 / 69,603 / 856,011. Finalisation took 63–102 ms,
 *      including for a 1 MB / 60 s MP4, which is comfortably inside the 800 ms
 *      grace core's `closeOne()` allows before it escalates to `taskkill /F`.
 *      That grace is a fixed constant in a core file this module cannot change,
 *      and it is the one place where a very large output could still be
 *      truncated; reported as a finding.
 *
 * `os.setPriority` is C18's "spawn below-normal priority so playback always
 * wins". It is applied after the fact because `SecondaryEngineOptions` carries
 * no priority field either.
 */
import fs from 'node:fs'
import os from 'node:os'
import type { EngineService, Logger, SecondaryEngine } from '@shared/feature-api'
import { forbiddenEngineOverrides } from './encode-args.ts'
import type { RunSignal } from './job-queue.ts'

export interface RunEncodeInput {
  /** `[a-z0-9-]`, names the process in the log and in its pipe name. */
  readonly purpose: string
  /** Encode OPTIONS only. The source is never a command-line argument here. */
  readonly args: readonly string[]
  /** What to `loadfile`. An absolute path, or an `av://` / URL source. */
  readonly source: string
  /** Where the job should have left something. Checked, never assumed. */
  readonly outputFile: string
  /** Absolute seconds, for turning `time-pos` into a fraction. */
  readonly startSec: number
  readonly endSec: number
  readonly signal: RunSignal
  readonly onProgress: (fraction: number) => void
  /**
   * Replaces the default "outputFile exists and is non-empty" check. C09 writes
   * `<stem>_%04d.png`, so the name that exists is never the one we passed.
   */
  readonly verify?: (() => boolean) | undefined
  /** Hard ceiling on one job, so a wedged encoder cannot hold the queue. */
  readonly timeoutMs?: number | undefined
  /** Test seam. Real jobs wait on the real clock. */
  readonly pollMs?: number | undefined
}

export interface RunEncodeDeps {
  readonly engine: EngineService
  readonly log: Logger
}

export interface RunEncodeResult {
  readonly output: string
  readonly bytes: number
}

const JOB_TIMEOUT_MS = 30 * 60_000
const POLL_MS = 120

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Below-normal, so a 4-core box encoding libx265 still plays video smoothly.
 *
 * Failure is logged and ignored: on a locked-down machine `setPriority` throws
 * EPERM, and an export that runs at normal priority is far better than an export
 * that does not run.
 */
function deprioritise(pid: number | null, log: Logger): void {
  if (pid === null) return
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch (e) {
    log.warn(`could not lower encode priority for pid ${pid}:`, (e as Error).message)
  }
}

/** A half-written container is worse than no file: nothing can open it. */
function discardPartial(file: string, log: Logger): void {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  } catch (e) {
    log.warn(`could not remove the partial output ${file}:`, (e as Error).message)
  }
}

/**
 * Drive one encode-mode mpv to completion.
 *
 * Resolves with the output only when mpv ended the file cleanly, the process has
 * exited (so the trailer is written) AND something is on disk. Rejects on
 * cancel, on a hard timeout, and on an `end-file` that carries an error — with
 * mpv's own reason in the message, because "encode failed" with no cause is the
 * error report this module would otherwise produce for every one of C11's eight
 * presets.
 */
export async function runEncode(
  deps: RunEncodeDeps,
  input: RunEncodeInput
): Promise<RunEncodeResult> {
  const verify = input.verify ?? ((): boolean => sizeOf(input.outputFile) > 0)
  const span = Math.max(0.001, input.endSec - input.startSec)
  const poll = input.pollMs ?? POLL_MS

  let engine: SecondaryEngine | null = null
  let closed: Promise<void> | null = null
  /** Idempotent, and its promise is what "the trailer is written" means. */
  const closeNow = (): Promise<void> => {
    if (closed === null) closed = (engine?.close() ?? Promise.resolve()).catch(() => undefined)
    return closed
  }
  input.signal.onCancel(() => void closeNow())

  if (input.signal.cancelled) throw new Error('cancelled')

  /**
   * The five options core owns outright, checked here rather than only in a
   * test. mpv takes the last occurrence and reports success, so re-stating one
   * fails silently: `--idle=no` hangs the connect handshake, `--no-config` lets
   * a `vf` in the user's mpv.conf into every export, `--ytdl=no` and
   * `--load-scripts=no` are the zero-network promise, and `--input-ipc-server`
   * is the unguessable pipe name.
   */
  const clashes = forbiddenEngineOverrides(input.args)
  if (clashes.length > 0) {
    throw new Error(
      `${input.purpose}: these are core's to set and must not be re-stated: ` +
        `${clashes.join(', ')} (see ENGINE_APPLIED_OPTIONS).`
    )
  }

  /**
   * A spawn failure is a spawn failure now, and that is the point of the
   * rewrite. With core's `--idle=yes` left in place the child cannot exit
   * before the handshake, so there is no successful-job-reported-as-a-throw
   * case left to paper over — and no need for the "spawn threw but the file
   * looks big enough" rescue that would have accepted an unfinalised container.
   */
  engine = await deps.engine.spawn({ purpose: input.purpose, args: [...input.args] })
  deprioritise(engine.pid, deps.log)

  let ended = false
  let endError: string | null = null
  /** Set once, by whichever of cancel / timeout / end-file gets there first. */
  let failure: string | null = null

  const offEnd = engine.onEvent('end-file', (msg) => {
    ended = true
    const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'
    // mpv reports a decode/mux/encoder-init failure as reason 'error' with a
    // `file_error` string. 'eof' is the outcome we want; 'quit' and 'stop' are
    // our own close().
    if (reason === 'error') {
      endError = typeof msg.file_error === 'string' ? msg.file_error : 'encode error'
    } else if (reason !== 'eof' && reason !== 'quit' && reason !== 'stop') {
      endError = `mpv ended the file: ${reason}`
    }
  })

  const offProp = engine.onEvent('property-change', (msg) => {
    if (msg.name !== 'time-pos') return
    const t = typeof msg.data === 'number' ? msg.data : NaN
    if (!Number.isFinite(t)) return
    input.onProgress(Math.min(1, Math.max(0, (t - input.startSec) / span)))
  })

  try {
    /**
     * C18's progress source. `observe_property` is an IPC-level command with no
     * entry in `--input-cmdlist`, which is why it goes through `command()`
     * rather than through a method on the engine: there is no method.
     *
     * Registered BEFORE `loadfile` so the first frames are counted.
     */
    await engine.command(['observe_property', 1, 'time-pos'])
  } catch (e) {
    // Progress is a nicety; an export with no progress bar still exports.
    deps.log.warn(`${input.purpose}: could not observe time-pos:`, (e as Error).message)
  }

  const jobDeadline = Date.now() + (input.timeoutMs ?? JOB_TIMEOUT_MS)

  try {
    /**
     * Three arguments, and no `-1`.
     *
     * §7.7 trap 1 is about `loadfile`'s OPTIONS MAP: `['loadfile', p,
     * 'replace', {start: '5.5'}]` hard-errors with `invalid parameter` unless
     * the insertion index `-1` sits between the two. There is no options map
     * here — every encode option is a command-line one, which is also what lets
     * `--start`/`--end` be verified as literal strings by the unit tests — so
     * the three-argument form is correct and was measured returning
     * `{"error":"success"}`.
     */
    await engine.command(['loadfile', input.source, 'replace'])

    /**
     * NOTHING IN THIS LOOP THROWS, and that is deliberate.
     *
     * A `throw` here would propagate through the `finally` and skip the cleanup
     * below it — which is exactly the bug the cancel test caught: `close()` ran,
     * the container was finalised, and the half-written file was left sitting
     * next to the user's video because the `discardPartial` call was after the
     * try/finally rather than inside the failure path. The loop records a reason
     * and breaks; one place decides what happens.
     */
    for (;;) {
      if (input.signal.cancelled) {
        failure = 'cancelled'
        break
      }
      if (ended) break
      if (!engine.running) {
        // The process went away without an end-file: a crash, or core's idle
        // reaper. Either way there is nothing to wait for; the file decides.
        break
      }
      if (Date.now() > jobDeadline) {
        failure = 'the encoder exceeded its time budget and was stopped'
        break
      }
      await sleep(poll)
    }
  } finally {
    offProp()
    offEnd()
    // The container is finalised by `quit`, so this await is load-bearing: it is
    // what makes the size check below mean anything.
    await closeNow()
  }

  if (input.signal.cancelled) failure ??= 'cancelled'
  failure ??= endError
  if (failure !== null) {
    discardPartial(input.outputFile, deps.log)
    throw new Error(failure)
  }
  if (!verify()) {
    throw new Error(
      'the encoder produced no output. The mpv line is in the log; a hardware ' +
        'encoder that is present but will not initialise is the usual cause (C19).'
    )
  }
  return { output: input.outputFile, bytes: sizeOf(input.outputFile) }
}

/**
 * C19's probe: does this encoder actually initialise on this machine?
 *
 * Same shape as `runEncode`, deliberately — the row says "cache the exit code"
 * and there is no exit code to cache, so the answer comes from `end-file`. That
 * is not a downgrade: measured on this box, `h264_nvenc`, `h264_qsv` and
 * `h264_amf` each answered `{reason:'error', file_error:'video output
 * initialization failed'}` and wrote nothing, while `h264_mf` answered
 * `{reason:'eof'}` and wrote 16,371 bytes.
 */
export async function probeEncoder(
  deps: RunEncodeDeps,
  input: {
    purpose: string
    args: readonly string[]
    source: string
    outputFile: string
    timeoutMs?: number
    pollMs?: number
  }
): Promise<boolean> {
  const poll = input.pollMs ?? 80
  let engine: SecondaryEngine | null = null
  try {
    engine = await deps.engine.spawn({ purpose: input.purpose, args: [...input.args] })
  } catch (e) {
    deps.log.warn(`${input.purpose}: could not start the probe:`, (e as Error).message)
    return false
  }
  let ended = false
  let failed = false
  const off = engine.onEvent('end-file', (msg) => {
    ended = true
    if (msg.reason === 'error') failed = true
  })
  const deadline = Date.now() + (input.timeoutMs ?? 15_000)
  try {
    await engine.command(['loadfile', input.source, 'replace'])
    while (!ended && engine.running && Date.now() < deadline) await sleep(poll)
  } catch (e) {
    deps.log.warn(`${input.purpose}: probe failed to load:`, (e as Error).message)
    failed = true
  } finally {
    off()
    await engine.close().catch(() => undefined)
  }
  const ok = !failed && sizeOf(input.outputFile) > 0
  try {
    fs.rmSync(input.outputFile, { force: true })
  } catch {
    /* a probe artefact we could not delete is not worth failing the probe for */
  }
  return ok
}
