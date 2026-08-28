import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_RUN_OPTIONS,
  fingerprint,
  longestCommonRun,
  parseWav,
  proposeFromRun,
  toMono,
  type FingerprintProposal
} from './skip-fingerprint.ts'
import type { SecondaryEngine, SecondaryEngineOptions } from '@shared/feature-api'

/**
 * Tier 3's I/O half: decode two siblings through a SECOND mpv and correlate.
 *
 * §2.5 gives this tier `M27's engine`, which is `ctx.engine.spawn()` — the one
 * sanctioned way to run a second mpv (§5.3). Not `ctx.paths.mpvBinary()` plus
 * `child_process`: an engine minted here is registered, reaped on the quit path
 * and covered by the synchronous exit hook, and "no orphan mpv on quit" is a
 * v0.1 guarantee that has to mean all of them.
 *
 * THE DEPENDENCY IS AN ARGUMENT, NOT AN IMPORT, and that is deliberate: it is
 * what lets `skip-detect.test.ts` drive this whole orchestration — spawn args,
 * the unpause, the wait, the parse, the correlation, the cleanup — against a
 * fake engine that writes a WAV the test built. What no unit test can prove is
 * that the real mpv writes that WAV for these arguments, so the argument list
 * below is the one thing in this feature that needs a desktop session before it
 * is called evidence. It is behind an opt-in setting and an explicit command for
 * exactly that reason.
 *
 * NOTHING HERE APPLIES ANYTHING. The return value is a proposal. D-11: "a wrong
 * automatic skip is a worse bug than no skip at all, and this feature's whole
 * audience is people watching something for the first time."
 */

export const INTRO_DECODE_SEC = 90
export const ENDING_DECODE_SEC = 120
const DECODE_SAMPLE_RATE = 8000

export interface DetectDeps {
  spawn(opts: SecondaryEngineOptions): Promise<SecondaryEngine>
  /** A scratch directory the caller owns (`ctx.paths.tempJobDir`). */
  jobDir: string
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  /** Overridable so the test does not wait real seconds. */
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  cancelled?: () => boolean
}

export interface DecodedRegion {
  file: string
  /** Where the decoded region begins in the original file. */
  startSec: number
  duration: number
  mono: Float32Array
  sampleRate: number
}

/**
 * Options `ctx.engine.spawn()` applies to every secondary itself (§5.3).
 *
 * Re-stating one is not an error mpv reports -- it is a silent last-one-wins, and
 * the one that wins is not the one you can see here. M27 keeps the same list for
 * the same reason; it is duplicated rather than imported because that file is
 * M27's, and a two-line array is a smaller cost than a cross-module import.
 */
export const ENGINE_APPLIED_OPTIONS: readonly string[] = [
  '--no-config',
  '--idle',
  '--terminal',
  '--msg-level',
  '--load-scripts',
  '--ytdl',
  '--input-ipc-server'
]

/**
 * The spawn line for one decoded region.
 *
 * Exported as a value because it is the part that needs verifying against the
 * real binary, and a list you can print and a test can assert on is the only
 * form in which that verification means anything.
 *
 * `--start=-N` is mpv's "N seconds before the end", which is what makes the
 * ending region reachable WITHOUT first knowing the duration — the alternative
 * is a probe spawn per sibling before the decode spawn. A file shorter than the
 * region starts at 0 and `startSec` is clamped by the caller.
 */
export function decodeArgs(input: {
  file: string
  region: 'intro' | 'ending'
  outputFile: string
  seconds: number
}): string[] {
  return [
    // Load paused so `duration` can be read before the decode runs away.
    '--pause=yes',
    '--no-video',
    '--no-sub',
    '--load-stats-overlay=no',
    '--load-console=no',
    '--load-auto-profiles=no',
    // Decode as fast as the CPU allows; this is a file on disk, not a playout.
    '--untimed',
    '--audio-display=no',
    `--audio-samplerate=${DECODE_SAMPLE_RATE}`,
    '--audio-channels=mono',
    '--ao=pcm',
    '--ao-pcm-waveheader=yes',
    `--ao-pcm-file=${input.outputFile}`,
    input.region === 'intro' ? '--start=0' : `--start=-${input.seconds}`,
    `--length=${input.seconds}`,
    // `--` before the filename, or a rip whose name begins with a dash is parsed
    // as an option. M27's poster path already learned this one.
    '--',
    input.file
  ]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Decode one region of one file to mono PCM.
 *
 * The completion test is the FILE, not the reply: mpv's `end-file` arrives when
 * playback ends and `ao=pcm` has already flushed by then, but a decode killed by
 * the timeout still leaves a usable prefix, and a prefix is a perfectly good
 * fingerprint. So the wait is "the file stopped growing or `end-file` arrived",
 * and a short file is a result rather than an error.
 */
export async function decodeRegion(
  deps: DetectDeps,
  file: string,
  region: 'intro' | 'ending',
  slot: number
): Promise<DecodedRegion | null> {
  const seconds = region === 'intro' ? INTRO_DECODE_SEC : ENDING_DECODE_SEC
  const out = path.join(deps.jobDir, `skip-${region}-${slot}.wav`)
  const timeout = deps.timeoutMs ?? 60_000
  const poll = deps.pollMs ?? 250
  const now = deps.now ?? ((): number => Date.now())
  try {
    fs.mkdirSync(deps.jobDir, { recursive: true })
    fs.rmSync(out, { force: true })
  } catch {
    /* a locked leftover is overwritten by mpv anyway */
  }

  let engine: SecondaryEngine | null = null
  try {
    engine = await deps.spawn({
      purpose: 'skip-detect',
      args: decodeArgs({ file, region, outputFile: out, seconds }),
      idleTimeoutMs: Math.max(10_000, timeout)
    })
    let ended = false
    const offEnd = engine.onEvent('end-file', () => {
      ended = true
    })

    // Duration first, while the file is still paused on frame one.
    let duration = 0
    const durationDeadline = now() + Math.min(timeout, 15_000)
    while (now() < durationDeadline) {
      try {
        const d = await engine.getProperty<number>('duration')
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
          duration = d
          break
        }
      } catch {
        /* not loaded yet */
      }
      await sleep(poll)
    }

    // Ownership is skipped on a secondary (§5.3) — there is no shared property
    // namespace on a private instance to protect.
    await engine.command(['set', 'pause', 'no']).catch(() => undefined)

    const deadline = now() + timeout
    let lastSize = -1
    let stable = 0
    let cancelled = false
    for (;;) {
      if (deps.cancelled?.() === true) {
        cancelled = true
        break
      }
      let size = -1
      try {
        size = fs.statSync(out).size
      } catch {
        size = -1
      }
      if (size >= 0 && size === lastSize) stable++
      else stable = 0
      lastSize = size
      // `ended` plus one stable poll is the fast path; two stable polls with
      // real bytes on disk is the fallback for the case where the event never
      // arrives (a demuxer that stalls, a killed process).
      if (size > 44 && ((ended && stable >= 1) || stable >= 3)) break
      if (now() >= deadline) {
        deps.log.warn(`skip-detect: ${region} decode of ${path.basename(file)} timed out`)
        break
      }
      await sleep(poll)
    }
    offEnd()
    // A cancelled decode returns nothing.
    //
    // The draft broke out of the wait loop on cancel and then went on to parse
    // whatever was on disk and return it, so pressing Cancel produced a
    // fingerprint from a partial decode of one file and a full decode of the
    // other -- which is worse than either finishing or stopping, because the
    // proposal that came out looked exactly like a real one.
    if (cancelled) return null

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(fs.readFileSync(out))
    } catch (e) {
      deps.log.warn(`skip-detect: no PCM for ${path.basename(file)}: ${(e as Error).message}`)
      return null
    }
    const pcm = parseWav(bytes)
    if (!pcm || pcm.samples.length === 0) {
      deps.log.warn(`skip-detect: ${out} is not readable 16-bit PCM`)
      return null
    }
    const startSec = region === 'intro' ? 0 : Math.max(0, duration - seconds)
    return { file, startSec, duration, mono: toMono(pcm), sampleRate: pcm.sampleRate }
  } catch (e) {
    deps.log.warn(`skip-detect: ${(e as Error).message}`)
    return null
  } finally {
    try {
      await engine?.close()
    } catch {
      /* core reaps whatever is left on the quit path */
    }
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* left for the next run; tempJobDir is ours */
    }
  }
}

export interface DetectResult {
  intro: FingerprintProposal | null
  ending: FingerprintProposal | null
  /** The two files that were compared, for the proposal's own message. */
  compared: string[]
}

/**
 * Compare two siblings and return what they share, for both regions.
 *
 * Two files, not the whole folder: this is the cheapest thing that can possibly
 * work, and the row's own effort note puts this tier at `md` on top of a `sm`
 * row. A twelve-file cross-correlation is a different feature.
 */
export async function detectWindows(
  deps: DetectDeps,
  reference: string,
  sibling: string,
  regions: ReadonlyArray<'intro' | 'ending'> = ['intro', 'ending']
): Promise<DetectResult> {
  const result: DetectResult = { intro: null, ending: null, compared: [reference, sibling] }
  for (const region of regions) {
    if (deps.cancelled?.() === true) break
    const a = await decodeRegion(deps, reference, region, 0)
    if (!a) continue
    if (deps.cancelled?.() === true) break
    const b = await decodeRegion(deps, sibling, region, 1)
    if (!b) continue
    const fa = fingerprint(a.mono, a.sampleRate, a.startSec)
    const fb = fingerprint(b.mono, b.sampleRate, b.startSec)
    const run = longestCommonRun(fa, fb, DEFAULT_RUN_OPTIONS)
    const proposal = proposeFromRun(region, fa, run, a.duration)
    if (region === 'intro') result.intro = proposal
    else result.ending = proposal
    if (proposal) {
      deps.log.info(
        `skip-detect: ${region} run of ${(proposal.end - proposal.start).toFixed(1)}s ` +
          `at ${proposal.start.toFixed(1)}s across ${path.basename(reference)} / ` +
          `${path.basename(sibling)}`
      )
    }
  }
  return result
}
