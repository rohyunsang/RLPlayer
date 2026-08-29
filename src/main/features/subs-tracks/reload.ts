import path from 'node:path'
import {
  describeIdentity,
  identityOf,
  planReselection,
  type TrackIdentity,
  type TrackLike
} from '@shared/mpv/tracks'

/**
 * `sub-reload`, WITH THE SELECTION RE-RESOLVED BY IDENTITY.
 *
 * THE DEFECT THIS REPLACES, measured in the packaged build on a real CP949
 * `kor.smi` beside `kor.mp4`, one press of the default Alt+C
 * (`subs-formats.cycleCodepage`):
 *
 *     boot   sid=1       sub-text="안녕하세요 세계"
 *     Alt+C  sid=false   sub-text "property unavailable"
 *
 * permanently — setting `sub-codepage` back to `auto` did not bring it back,
 * because the codepage was never what broke. `--sub-auto=fuzzy` (our own spawn
 * arg) picks up two external subs; `sub-reload` RENUMBERS them
 * (`1:kor.smi*, 2:kor_srt.srt` -> `2:kor_srt.srt, 3:kor.smi*`) and mpv
 * re-selects the right FILE on its own. `index.ts` then wrote back the sid it
 * had captured BEFORE the reload — 1 — mpv answered `{"error":"success"}` and
 * resolved it to `false`, and `.catch(() => undefined)` swallowed the episode.
 *
 * Three things are different, one per way that failed:
 *
 *   1. THE TRACK IS RE-FOUND BY IDENTITY, not by index — external filename
 *      first, because the reload changed the ORDER too, so an ordinal would
 *      have silently selected `kor_srt.srt` instead.
 *   2. WHEN MPV ALREADY GOT IT RIGHT, NOTHING IS WRITTEN. That is the normal
 *      case, and the old write was pure damage.
 *   3. NOTHING IS SWALLOWED. `selectTrack` returns what mpv RESOLVED to, and a
 *      lost track names the file that went missing.
 *
 * WHY THIS IS ITS OWN FILE. `index.ts` imports `../../services/config.ts`,
 * which reaches `core/paths.ts` and `electron` — so `index.ts` cannot be loaded
 * by `node --test` at all, and the reload path is the single most
 * Korean-market-critical piece of behaviour in the product. The port below is
 * the narrow slice of `ctx` this needs; `module.test.ts` drives it against an
 * mpv that renumbers exactly the way the real one was measured to.
 */

export interface ReloadPort {
  get<T>(name: string): Promise<T>
  command(args: unknown[]): Promise<unknown>
  selectTrack(name: 'sid', id: number | false | 'no'): Promise<number | false>
  peek<T>(name: string): T | undefined
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
  toast(kind: 'error' | 'info', message: string): void
  t(key: string, vars?: Record<string, string | number>): string
}

export type ReloadOutcome =
  | { kind: 'embedded' }
  | { kind: 'no-selection' }
  | { kind: 'reload-failed'; message: string }
  | { kind: 'already'; id: number }
  | { kind: 'reselected'; id: number }
  | { kind: 'lost'; name: string }
  | { kind: 'refused'; wanted: number; resolved: number | false }

const nameOf = (t: TrackLike): string =>
  t['external-filename'] ? path.basename(t['external-filename']) : String(t.id)

export async function reloadSubtitles(port: ReloadPort): Promise<ReloadOutcome> {
  /**
   * `get`, not `peek`. The observation cache is filled by an async
   * `property-change` event, so peeking straight after `sub-reload` hands back
   * the PRE-reload list — the same stale-index bug wearing a different hat.
   */
  const before = (await port.get<TrackLike[]>('track-list').catch(() => [])) ?? []
  const sid = (await port.get<number | false>('sid').catch(() => false as const)) ?? false
  const track = before.find((t) => t.type === 'sub' && t.id === sid)
  if (!track) return { kind: 'no-selection' }
  // sub-reload re-reads EXTERNAL subtitles only; mkv subtitles "are always
  // assumed to be UTF-8", so there is nothing for it to do for an embedded one.
  if (!track.external) return { kind: 'embedded' }

  const identity = identityOf(before, track)

  try {
    await port.command(['sub-reload'])
  } catch (e) {
    const message = (e as Error).message
    port.log.error('sub-reload failed:', message)
    port.toast('error', port.t('subs-tracks.reloadFailed'))
    return { kind: 'reload-failed', message }
  }

  const after = (await port.get<TrackLike[]>('track-list').catch(() => [])) ?? []
  const now = (await port.get<number | false>('sid').catch(() => false as const)) ?? false
  const plan = planReselection(after, identity, now)

  if (plan.kind === 'lost') {
    const name = nameOf(track)
    port.log.error(
      `sub-reload lost ${describeIdentity(identity)}: it is not among the ` +
        `${after.filter((t) => t.type === 'sub').length} subtitle track(s) mpv now reports. ` +
        `Not falling back to an ordinal — that would select a DIFFERENT subtitle without ` +
        `saying so, which is worse than reporting the loss.`
    )
    port.toast('error', port.t('subs-tracks.reloadLost', { name }))
    return { kind: 'lost', name }
  }

  if (plan.kind === 'already') {
    // mpv re-selected the right track by itself. The old code's write went HERE,
    // over a correct selection, with a number that no longer named anything.
    port.log.info(
      `sub-reload: mpv re-selected ${describeIdentity(identity)} as sid=${plan.id} ` +
        `(matched on ${plan.tier}); nothing written.`
    )
    return { kind: 'already', id: plan.id }
  }

  const resolved = await port.selectTrack('sid', plan.id)
  if (resolved !== plan.id) {
    port.log.error(
      `after sub-reload, sid=${plan.id} for ${describeIdentity(identity)} was ACCEPTED by mpv ` +
        `and resolved to ${JSON.stringify(resolved)}.`
    )
    port.toast('error', port.t('subs-tracks.reloadLost', { name: nameOf(track) }))
    return { kind: 'refused', wanted: plan.id, resolved }
  }
  port.log.info(
    `sub-reload: ${describeIdentity(identity)} moved to sid=${plan.id} ` +
      `(matched on ${plan.tier}), re-selected.`
  )
  return { kind: 'reselected', id: plan.id }
}

// ---------------------------------------------------------------------------
// The per-file restore, which is the same lesson one level up
// ---------------------------------------------------------------------------

export interface SubsSlice {
  sid: number | false
  identity: TrackIdentity | null
  visible: boolean
}

export function captureSlice(list: readonly TrackLike[], sid: number | false, visible: boolean): SubsSlice {
  const track = list.find((t) => t.type === 'sub' && t.id === sid)
  return { sid, identity: track ? identityOf(list, track) : null, visible }
}

/**
 * A remembered `sid` is an index into a PREVIOUS session's track list, and a
 * sibling `.srt` the user has added since shifts every id after it. `identity`
 * is additive, so a bucket written by an older build still restores by index —
 * and `selectTrack` then says when that index lands on nothing.
 */
export async function restoreSelection(
  port: ReloadPort,
  slice: Partial<SubsSlice>
): Promise<ReloadOutcome> {
  const identity = slice.identity ?? null
  if (!identity || typeof identity.type !== 'string') {
    if (typeof slice.sid !== 'number') return { kind: 'no-selection' }
    const got = await port.selectTrack('sid', slice.sid)
    if (got !== slice.sid) {
      port.log.warn(
        `the remembered sid=${slice.sid} was accepted by mpv and resolved to ` +
          `${JSON.stringify(got)}. This bucket predates identity capture.`
      )
      return { kind: 'refused', wanted: slice.sid, resolved: got }
    }
    return { kind: 'reselected', id: slice.sid }
  }
  const list = (await port.get<TrackLike[]>('track-list').catch(() => [])) ?? []
  const now = (await port.get<number | false>('sid').catch(() => false as const)) ?? false
  const plan = planReselection(list, identity, now)
  if (plan.kind === 'lost') {
    port.log.warn(
      `the remembered subtitle ${describeIdentity(identity)} is not in this file's track list ` +
        `any more; leaving mpv's own choice alone.`
    )
    return { kind: 'lost', name: identity.externalFilename ?? String(identity.capturedId) }
  }
  if (plan.kind === 'already') return { kind: 'already', id: plan.id }
  const got = await port.selectTrack('sid', plan.id)
  if (got !== plan.id) {
    port.log.warn(
      `restoring ${describeIdentity(identity)} as sid=${plan.id} resolved to ${JSON.stringify(got)}.`
    )
    return { kind: 'refused', wanted: plan.id, resolved: got }
  }
  return { kind: 'reselected', id: plan.id }
}
