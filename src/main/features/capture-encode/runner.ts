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
 * THE THREE THINGS THIS FILE EXISTS TO GET RIGHT, all of them consequences of
 * `SecondaryEngine` being shaped for M27's thumbnailer rather than for an encode:
 *
 * 1. **A container is not finished when its bytes stop arriving.** Polling the
 *    output file — which is what M27's poster path does, correctly, for a
 *    single-frame PNG — is wrong for MP4/MKV/WebM/GIF/WebP/M4A: the trailer (the
 *    `moov` atom, the Matroska cues) is written when the encoder is torn down.
 *    So the wait here is on the PROCESS, not on the file, and `ENCODE_OVERRIDES`
 *    passes `--idle=no` so mpv tears the encoder down and exits by itself
 *    instead of sitting idle with an unfinalised file (see encode-args.ts).
 * 2. **There is no exit code.** `SecondaryEngine` exposes `pid`, `running`,
 *    `command`, `getProperty`, `onEvent` and `close()` — no exit code and no
 *    exit event. Success is therefore judged from mpv's `end-file` event plus
 *    the output file, and a failure message comes from the child's stderr, which
 *    is why `--terminal=yes --msg-level=all=error` is in the override list.
 * 3. **There is no `observeProperty`.** C18 says to drive progress from
 *    `observe_property` on `time-pos`; the interface has no such method, so this
 *    file issues the IPC command by hand and reads the resulting
 *    `property-change` events off `onEvent`. That works and is not obvious.
 *
 * `os.setPriority` is C18's "spawn below-normal priority so playback always
 * wins". It has to be applied after the fact because `SecondaryEngineOptions`
 * carries no priority either.
 */
import fs from 'node:fs'
import os from 'node:os'
import type { EngineService, Logger, SecondaryEngine } from '@shared/feature-api'
import type { RunSignal } from './job-queue.ts'

export interface RunEncodeInput {
  /** `[a-z0-9-]`, names the process in the log and in its pipe name. */
  readonly purpose: string
  readonly args: readonly string[]
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
  /** How long to allow for the trailer write after `end-file`. */
  readonly finalizeTimeoutMs?: number | undefined
  /** Hard ceiling on one job, so a wedged encoder cannot hold the queue. */
  readonly timeoutMs?: number | undefined
}

export interface RunEncodeDeps {
  readonly engine: EngineService
  readonly log: Logger
}

export interface RunEncodeResult {
  readonly output: string
  readonly bytes: number
}

const FINALIZE_TIMEOUT_MS = 60_000
const JOB_TIMEOUT_MS = 30 * 60_000

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

/**
 * Drive one encode-mode mpv to completion.
 *
 * Resolves with the output only when mpv ended the file cleanly AND something is
 * on disk. Rejects on cancel, on a hard timeout, and on an `end-file` that
 * carries an error — with mpv's own reason in the message, because "encode
 * failed" with no cause is the error report this module would otherwise produce
 * for every one of C11's eight presets.
 */
export async function runEncode(
  deps: RunEncodeDeps,
  input: RunEncodeInput
): Promise<RunEncodeResult> {
  const verify = input.verify ?? ((): boolean => sizeOf(input.outputFile) > 0)
  const span = Math.max(0.001, input.endSec - input.startSec)

  let engine: SecondaryEngine | null = null
  let closing = false
  const closeNow = (): void => {
    if (closing) return
    closing = true
    void engine?.close().catch(() => undefined)
  }
  input.signal.onCancel(closeNow)

  try {
    engine = await deps.engine.spawn({ purpose: input.purpose, args: [...input.args] })
  } catch (e) {
    /**
     * The spawn-connect race, and why a throw here is not automatically a
     * failure.
     *
     * `ctx.engine.spawn()` awaits an IPC connect with a 15 s deadline. With
     * `--idle=no` a very short job can encode, finalise and exit before the
     * first connect attempt lands, and then no pipe will ever appear: spawn
     * throws after the deadline for a job that actually SUCCEEDED. So the output
     * is the authority, not the connection.
     */
    if (verify()) {
      deps.log.info(`${input.purpose}: finished before IPC connected; output is present`)
      return { output: input.outputFile, bytes: sizeOf(input.outputFile) }
    }
    throw new Error(`could not start the encoder: ${(e as Error).message}`)
  }

  deprioritise(engine.pid, deps.log)

  let ended = false
  let endError: string | null = null

  const offEnd = engine.onEvent('end-file', (msg) => {
    ended = true
    const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'
    // mpv reports a decode/mux failure as reason 'error' with a `file_error`
    // string. 'eof' is the outcome we want; 'quit' is our own close().
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
    // C18's progress source. `observe_property` is an IPC-level command with no
    // entry in `--input-cmdlist`, which is why it goes through `command()`
    // rather than through a method on the engine: there is no method.
    await engine.command(['observe_property', 1, 'time-pos'])
  } catch (e) {
    // Progress is a nicety; an export with no progress bar still exports.
    deps.log.warn(`${input.purpose}: could not observe time-pos:`, (e as Error).message)
  }

  const jobDeadline = Date.now() + (input.timeoutMs ?? JOB_TIMEOUT_MS)
  let finalizeDeadline = Infinity

  try {
    for (;;) {
      if (input.signal.cancelled) {
        closeNow()
        throw new Error('cancelled')
      }
      if (!engine.running) break
      if (ended && finalizeDeadline === Infinity) {
        // The file is over; mpv is now writing the trailer and shutting down.
        finalizeDeadline = Date.now() + (input.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS)
      }
      if (Date.now() > finalizeDeadline) {
        /**
         * mpv reached EOF and did not exit. Either `--idle=no` did not take
         * effect or the muxer is still working. `close()` sends `quit`, which
         * IS a clean shutdown and does finalise the container — but core's
         * `closeOne()` escalates to `kill()` after a fixed 800 ms and to
         * `taskkill /F` after that, and a TerminateProcess mid-trailer truncates
         * the file. Reported as a finding; the file check below is what keeps a
         * truncated output from being announced as a success.
         */
        deps.log.warn(`${input.purpose}: EOF reached but the process is still up; quitting it`)
        closeNow()
        break
      }
      if (Date.now() > jobDeadline) {
        closeNow()
        throw new Error('the encoder exceeded its time budget and was stopped')
      }
      await sleep(120)
    }
  } finally {
    offProp()
    offEnd()
    closeNow()
  }

  if (input.signal.cancelled) throw new Error('cancelled')
  if (endError !== null) throw new Error(endError)
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
 * Deliberately NOT `runEncode`: the probe keeps core's `--idle=yes`, because a
 * 0.2 s encode with `--idle=no` loses the connect race often enough that a
 * working encoder would be reported broken (see `hardwareProbeArgs`). So it
 * waits for `end-file` and closes explicitly, and judges on the event plus the
 * file.
 */
export async function probeEncoder(
  deps: RunEncodeDeps,
  input: { purpose: string; args: readonly string[]; outputFile: string; timeoutMs?: number }
): Promise<boolean> {
  let engine: SecondaryEngine | null = null
  try {
    engine = await deps.engine.spawn({ purpose: input.purpose, args: [...input.args] })
  } catch {
    return sizeOf(input.outputFile) > 0
  }
  let ended = false
  let failed = false
  const off = engine.onEvent('end-file', (msg) => {
    ended = true
    if (msg.reason === 'error') failed = true
  })
  const deadline = Date.now() + (input.timeoutMs ?? 15_000)
  try {
    while (!ended && engine.running && Date.now() < deadline) await sleep(80)
  } finally {
    off()
    await engine.close().catch(() => undefined)
  }
  const ok = !failed && sizeOf(input.outputFile) > 0
  fs.rmSync(input.outputFile, { force: true })
  return ok
}
