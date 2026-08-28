import path from 'node:path'

/**
 * N51 skip intro / skip ending — the whole decision layer, with no I/O in it.
 *
 * Everything here is a pure function over numbers, so every rule the row calls
 * "non-negotiable" is assertable in `skip-model.test.ts` without a running mpv:
 * off by default, never skip a window this folder did not actually record, and
 * never let a *proposal* become an applied window on its own.
 *
 * WHY TIME AND NOT CHAPTERS. N08 (the sibling row) matches `chapter-list[n].title`
 * against a regex, and the Korean drama and anime rips this feature exists for
 * carry `chapters: 0` — there is nothing to match. So the mechanism is the one
 * PotPlayer ships: two numbers per *series folder*, applied to every sibling.
 *
 * THE ONE ASYMMETRY WORTH READING TWICE. An intro is anchored to the START of
 * the file and an ending is anchored to its END. Episode runtimes inside one
 * folder differ by tens of seconds (different ad breaks, different encodes), so
 * an ending stored as an absolute `endingStart` from episode 1 lands mid-credits
 * on episode 2 and mid-scene on episode 3. The stored value is therefore a LEAD
 * — `duration - endingStart` — and `resolveWindows()` re-derives the absolute
 * point per file. §2.5's record shape (`{introStart, introEnd, endingStart}`) is
 * kept as written for the file it was set on, and `endingLead` is what is
 * actually applied; `'absolute'` is available as a setting for the person whose
 * folder really is one runtime.
 */

export const SKIP_STORE_VERSION = 1

/** How a window came to exist. There is no `'proposed'`: see `learnIntro()`. */
export type SkipSource = 'manual' | 'learned' | 'fingerprint'

export type SkipKind = 'intro' | 'ending'

export interface SkipWindow {
  /** Where the intro window arms. Absent means "from the start of the file". */
  introStart?: number
  /** Where the intro ends, i.e. the seek target. The window is [start, end). */
  introEnd?: number
  /** Absolute ending start, as set on the file it was set on (§2.5's shape). */
  endingStart?: number
  /** `refDuration - endingStart`. THIS is what gets applied to a sibling. */
  endingLead?: number
  /** The duration of the file the ending was set on, for the record. */
  refDuration?: number
  source: SkipSource
  updatedAt: number
}

/**
 * One skip the user performed by hand. `file` is a BASENAME, never a full path:
 * this store is keyed by folder already, and a per-file path index would make
 * `skip.json` a viewing-history file that nothing in the product asked for.
 */
export interface SkipObservation {
  file: string
  from: number
  to: number
  duration: number
  at: number
}

export interface SkipFolder {
  window?: SkipWindow
  intro?: SkipObservation[]
  ending?: SkipObservation[]
}

export interface SkipStoreData {
  version: number
  folders: Record<string, SkipFolder>
  /** P10 one level down: a key a future version wrote is carried, not dropped. */
  [extra: string]: unknown
}

export const MAX_FOLDERS = 500
export const MAX_OBSERVATIONS = 12

/** Defaults every threshold in this file reads from, so a test can vary one. */
export interface SkipTuning {
  /** A time-pos delta this large forward is a seek, not playback. */
  minJumpSec: number
  /** A jump whose origin is inside this many seconds is an intro candidate. */
  introZoneSec: number
  /** A jump whose origin is this close to the end is an ending candidate. */
  endingZoneSec: number
  /** Two observations agree when their targets are this close. */
  learnToleranceSec: number
  /** How many DISTINCT episodes must agree before anything is proposed. */
  learnMinFiles: number
}

export const DEFAULT_TUNING: SkipTuning = {
  minJumpSec: 20,
  introZoneSec: 600,
  endingZoneSec: 900,
  learnToleranceSec: 4,
  learnMinFiles: 2
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The store key: the containing directory plus the episode prefix.
 *
 * The prefix is M28's (`playlist.seriesPrefix`, the computation L50 already
 * needs) and is passed in rather than re-derived — re-deriving it is exactly the
 * duplication §3.7.3 sanctions a mediator to prevent. An EMPTY prefix is a legal
 * answer and means "this folder", which is also the fallback §3.6 requires when
 * M28 is not in the build at all.
 *
 * Lower-cased because this is a Windows path, where `D:\Anime` and `d:\anime`
 * are one directory and a case-sensitive key would silently split a folder's
 * learned window in two.
 */
export function folderKey(file: string, prefix: string): string {
  const dir = path
    .dirname(file)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  const p = prefix.trim().toLowerCase()
  return `${dir}|${p}`
}

/** The basename an observation is recorded under. */
export function observationFile(file: string): string {
  return path.basename(file)
}

// ---------------------------------------------------------------------------
// Sanitising what came off disk
// ---------------------------------------------------------------------------

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function isSource(v: unknown): v is SkipSource {
  return v === 'manual' || v === 'learned' || v === 'fingerprint'
}

/**
 * A window that survived the round trip, or `undefined`.
 *
 * A half-written record is normal, not corrupt: "set intro start here" is one of
 * three separate keypresses and the user may only ever press one. What is NOT
 * allowed through is a window that would seek somewhere absurd — an
 * `introEnd <= introStart`, an `endingLead` longer than the file — because that
 * lands as a silent wrong skip, which is the one failure mode this row's own
 * design notes call worse than having no feature.
 */
export function sanitizeWindow(raw: unknown): SkipWindow | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: SkipWindow = {
    source: isSource(r['source']) ? r['source'] : 'manual',
    updatedAt: finite(r['updatedAt']) ?? 0
  }
  const introStart = finite(r['introStart'])
  const introEnd = finite(r['introEnd'])
  if (introEnd !== undefined && introEnd > (introStart ?? 0)) {
    if (introStart !== undefined) out.introStart = introStart
    out.introEnd = introEnd
  }
  const refDuration = finite(r['refDuration'])
  const endingStart = finite(r['endingStart'])
  let endingLead = finite(r['endingLead'])
  // A record written before `endingLead` existed, or by hand: derive it.
  if (endingLead === undefined && endingStart !== undefined && refDuration !== undefined) {
    endingLead = Math.max(0, refDuration - endingStart)
  }
  if (endingLead !== undefined && endingLead > 0) {
    out.endingLead = endingLead
    if (endingStart !== undefined) out.endingStart = endingStart
    if (refDuration !== undefined) out.refDuration = refDuration
  }
  if (out.introEnd === undefined && out.endingLead === undefined) return undefined
  return out
}

function sanitizeObservations(raw: unknown): SkipObservation[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SkipObservation[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const file = typeof r['file'] === 'string' ? r['file'] : null
    const from = finite(r['from'])
    const to = finite(r['to'])
    if (file === null || from === undefined || to === undefined || to <= from) continue
    out.push({
      file,
      from,
      to,
      duration: finite(r['duration']) ?? 0,
      at: finite(r['at']) ?? 0
    })
  }
  return out.length > 0 ? out.slice(0, MAX_OBSERVATIONS) : undefined
}

export function sanitizeStore(raw: unknown): SkipStoreData {
  const empty: SkipStoreData = { version: SKIP_STORE_VERSION, folders: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const r = raw as Record<string, unknown>
  const out: SkipStoreData = { version: SKIP_STORE_VERSION, folders: {} }
  // Unknown keys are carried across versions (P10's reasoning, one level down).
  for (const [k, v] of Object.entries(r)) {
    if (k !== 'version' && k !== 'folders') out[k] = v
  }
  const folders = r['folders']
  if (folders !== null && typeof folders === 'object' && !Array.isArray(folders)) {
    for (const [key, value] of Object.entries(folders as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const rec: SkipFolder = {}
      const win = sanitizeWindow(v['window'])
      if (win) rec.window = win
      const intro = sanitizeObservations(v['intro'])
      if (intro) rec.intro = intro
      const ending = sanitizeObservations(v['ending'])
      if (ending) rec.ending = ending
      if (rec.window || rec.intro || rec.ending) out.folders[key] = rec
    }
  }
  return evictOldest(out, MAX_FOLDERS)
}

/** Newest-first eviction, so a 400-folder archive cannot grow this file forever. */
export function evictOldest(data: SkipStoreData, cap: number): SkipStoreData {
  const keys = Object.keys(data.folders)
  if (keys.length <= cap) return data
  const stamp = (k: string): number => {
    const f = data.folders[k]
    if (!f) return 0
    const obs = [...(f.intro ?? []), ...(f.ending ?? [])]
    return Math.max(f.window?.updatedAt ?? 0, ...obs.map((o) => o.at), 0)
  }
  const keep = keys.sort((a, b) => stamp(b) - stamp(a)).slice(0, cap)
  const folders: Record<string, SkipFolder> = {}
  for (const k of keep) {
    const f = data.folders[k]
    if (f) folders[k] = f
  }
  return { ...data, folders }
}

// ---------------------------------------------------------------------------
// Applying a window to the file that is playing
// ---------------------------------------------------------------------------

export interface ResolvedWindow {
  start: number
  end: number
}

export interface ResolvedWindows {
  intro?: ResolvedWindow
  ending?: ResolvedWindow
}

export type EndingAnchor = 'end' | 'absolute'

/**
 * The absolute [start, end) pair for THIS file, from the folder's record.
 *
 * `duration` is `0` for a live stream and for a file whose duration has not
 * arrived yet (§3.3.1: `undefined` is a real value from the bus and the caller
 * coerces it here, once). With no duration there is no ending window at all —
 * "the last 90 seconds" of an unbounded stream is not a thing — while the intro
 * window is still perfectly well defined.
 */
export function resolveWindows(
  w: SkipWindow | undefined,
  duration: number,
  anchor: EndingAnchor = 'end'
): ResolvedWindows {
  const out: ResolvedWindows = {}
  if (!w) return out
  if (w.introEnd !== undefined && w.introEnd > 0) {
    const start = Math.max(0, w.introStart ?? 0)
    const end = duration > 0 ? Math.min(w.introEnd, duration) : w.introEnd
    if (end > start) out.intro = { start, end }
  }
  if (duration > 0) {
    const lead = anchor === 'absolute' ? undefined : w.endingLead
    const start = lead !== undefined ? duration - lead : w.endingStart
    // An ending that would start inside the intro, or in the first five
    // seconds, is a record about a different file. Dropping it beats seeking to
    // EOF on frame one.
    const floor = Math.max(out.intro?.end ?? 0, 5)
    if (start !== undefined && start > floor && start < duration) {
      out.ending = { start, end: duration }
    }
  }
  return out
}

export function windowAt(t: number, w: ResolvedWindows): SkipKind | null {
  if (w.intro && t >= w.intro.start && t < w.intro.end) return 'intro'
  if (w.ending && t >= w.ending.start && t < w.ending.end) return 'ending'
  return null
}

/**
 * The kind of window playback has just ENTERED, or null.
 *
 * Entry, not containment: a window the player was already inside on the
 * previous tick has had its chance. That is what stops an undo from being
 * re-skipped 200 ms later by the very next `time-pos` callback, and it is why
 * `prev === null` (the first tick of a new file) counts as an entry — a file
 * resumed at 00:30 of a 00:00–01:40 intro should still offer the skip.
 */
export function enteredWindow(
  prev: number | null,
  next: number,
  w: ResolvedWindows
): SkipKind | null {
  const now = windowAt(next, w)
  if (now === null) return null
  if (prev === null) return now
  return windowAt(prev, w) === now ? null : now
}

// ---------------------------------------------------------------------------
// Where a skip actually lands
// ---------------------------------------------------------------------------

export interface SkipPlan {
  ok: true
  kind: SkipKind
  target: number
  /** 'window' used the folder's record; 'fallback' used the keypress default. */
  via: 'window' | 'fallback'
}

export interface SkipRefusal {
  ok: false
  reason: 'no-duration' | 'before-window' | 'no-window'
  /** Where the window this refusal is about begins, when there is one. */
  at?: number
}

export interface SkipFallback {
  /** How far the intro key jumps with no stored window (PotPlayer's `%s`). */
  introSeconds: number
  /** How close to the end the ending key must be with no stored window. */
  endingSeconds: number
}

/**
 * The target of a KEYPRESS, which is not the same question as the target of an
 * automatic skip, and conflating the two is how this feature gets dangerous.
 *
 * Three cases the obvious version gets wrong, each of them a test below:
 *
 *  - pressing "skip intro" at 15:00 of a file whose intro window is 00:10–01:40
 *    must not seek BACKWARDS to 01:40. The window is behind the playhead; the
 *    keypress falls back to a relative jump.
 *  - pressing "skip ending" at 00:30 must not end the episode. Nothing in the
 *    UI told the user that key means "finish this file", so before the ending
 *    window it refuses and says where the window starts.
 *  - a file with no duration (a live stream) has no ending at all.
 */
export function planManualSkip(
  kind: SkipKind,
  from: number,
  duration: number,
  w: ResolvedWindows,
  fallback: SkipFallback,
  eofMargin: number
): SkipPlan | SkipRefusal {
  if (kind === 'intro') {
    const intro = w.intro
    if (intro && from < intro.end) return { ok: true, kind, target: intro.end, via: 'window' }
    const target = duration > 0 ? Math.min(from + fallback.introSeconds, duration) : from + fallback.introSeconds
    return { ok: true, kind, target, via: 'fallback' }
  }
  if (!(duration > 0)) return { ok: false, reason: 'no-duration' }
  const eof = Math.max(0, duration - eofMargin)
  const ending = w.ending
  if (ending) {
    if (from >= ending.start) return { ok: true, kind, target: eof, via: 'window' }
    return { ok: false, reason: 'before-window', at: ending.start }
  }
  const floor = duration - fallback.endingSeconds
  if (from >= floor) return { ok: true, kind, target: eof, via: 'fallback' }
  return { ok: false, reason: 'no-window', at: Math.max(0, floor) }
}

/**
 * The target of an AUTOMATIC skip. Deliberately narrower than the manual plan:
 * it has no fallback at all, so nothing this folder did not record can ever move
 * playback on its own. That is the second of the row's non-negotiables.
 */
export function planAutoSkip(
  kind: SkipKind,
  duration: number,
  w: ResolvedWindows,
  eofMargin: number
): SkipPlan | SkipRefusal {
  if (kind === 'intro') {
    const intro = w.intro
    if (!intro) return { ok: false, reason: 'no-window' }
    return { ok: true, kind, target: intro.end, via: 'window' }
  }
  if (!(duration > 0)) return { ok: false, reason: 'no-duration' }
  if (!w.ending) return { ok: false, reason: 'no-window' }
  return { ok: true, kind, target: Math.max(0, duration - eofMargin), via: 'window' }
}

// ---------------------------------------------------------------------------
// Learning from what the user does by hand (tier 2)
// ---------------------------------------------------------------------------

export type JumpKind = 'forward' | 'backward' | null

/** Playback advances by ~1 s per tick; anything else is a seek. */
export function jumpKind(prev: number, next: number, tuning: SkipTuning): JumpKind {
  if (next - prev >= tuning.minJumpSec) return 'forward'
  if (prev - next >= tuning.minJumpSec) return 'backward'
  return null
}

/**
 * Which window a hand-made forward jump is evidence about.
 *
 * The ending test runs first: on a 20-minute episode the last 900 s and the
 * first 600 s overlap, and a jump at 15:00 of a 20:00 file is somebody skipping
 * the credits, not the OP.
 */
export function classifyJump(
  from: number,
  to: number,
  duration: number,
  tuning: SkipTuning
): SkipKind | null {
  if (to <= from) return null
  if (duration > 0 && from >= duration - tuning.endingZoneSec && from > duration / 2) {
    return 'ending'
  }
  if (from <= tuning.introZoneSec) return 'intro'
  return null
}

/** Newest first, one entry per episode, capped. */
export function recordObservation(
  list: readonly SkipObservation[] | undefined,
  obs: SkipObservation
): SkipObservation[] {
  const rest = (list ?? []).filter((o) => o.file.toLowerCase() !== obs.file.toLowerCase())
  return [obs, ...rest].slice(0, MAX_OBSERVATIONS)
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2 === 1) return s[mid] as number
  return ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

interface Cluster {
  members: SkipObservation[]
  files: string[]
}

/**
 * The largest set of observations whose projected value agrees within `tol`, and
 * that spans at least `minFiles` DISTINCT episodes.
 *
 * "Distinct episodes" is the whole point, and it is the check a naive version
 * gets wrong: a user who fumbles the same skip four times on episode 1 has
 * demonstrated nothing about episode 2. Two files agreeing is evidence; one file
 * agreeing with itself is not.
 */
function cluster(
  list: readonly SkipObservation[] | undefined,
  project: (o: SkipObservation) => number,
  tol: number,
  minFiles: number
): Cluster | null {
  const items = (list ?? []).filter((o) => Number.isFinite(project(o)))
  let best: Cluster | null = null
  for (const seed of items) {
    const c = project(seed)
    const members = items.filter((o) => Math.abs(project(o) - c) <= tol)
    const files = [...new Set(members.map((m) => m.file.toLowerCase()))]
    if (files.length < minFiles) continue
    if (best === null || files.length > best.files.length || members.length > best.members.length) {
      best = { members, files }
    }
  }
  return best
}

export interface IntroProposal {
  kind: 'intro'
  introStart: number
  introEnd: number
  files: string[]
}

export interface EndingProposal {
  kind: 'ending'
  endingLead: number
  files: string[]
}

/**
 * A candidate intro window, or null. This is a PROPOSAL and the return type says
 * so: nothing in this file can write a `SkipWindow`, so tier 2 cannot become an
 * auto-apply by accident. The caller offers it; the user accepts it.
 *
 * Clustered on the seek TARGET, because that is the number the feature will use.
 * Two episodes where the user landed at ~01:38 mean the OP ends there, whatever
 * second they happened to start pressing.
 */
export function learnIntro(
  list: readonly SkipObservation[] | undefined,
  tuning: SkipTuning
): IntroProposal | null {
  const c = cluster(list, (o) => o.to, tuning.learnToleranceSec, tuning.learnMinFiles)
  if (!c) return null
  const introEnd = median(c.members.map((m) => m.to))
  const introStart = median(c.members.map((m) => m.from))
  if (!(introEnd > introStart)) return null
  return { kind: 'intro', introStart, introEnd, files: c.files }
}

/** The same, for the ending — clustered on the LEAD, never on the absolute time. */
export function learnEnding(
  list: readonly SkipObservation[] | undefined,
  tuning: SkipTuning
): EndingProposal | null {
  const usable = (list ?? []).filter((o) => o.duration > 0)
  const c = cluster(usable, (o) => o.duration - o.from, tuning.learnToleranceSec, tuning.learnMinFiles)
  if (!c) return null
  const lead = median(c.members.map((m) => m.duration - m.from))
  if (!(lead > 0)) return null
  return { kind: 'ending', endingLead: lead, files: c.files }
}

/** Fold a proposal the user ACCEPTED into a window. The only path from one to
 *  the other, so "proposes, never applies" is a property of the type graph. */
export function applyProposal(
  existing: SkipWindow | undefined,
  proposal: IntroProposal | EndingProposal,
  source: SkipSource,
  now: number
): SkipWindow {
  const out: SkipWindow = { ...(existing ?? {}), source, updatedAt: now }
  if (proposal.kind === 'intro') {
    out.introStart = proposal.introStart
    out.introEnd = proposal.introEnd
  } else {
    out.endingLead = proposal.endingLead
    delete out.endingStart
    delete out.refDuration
  }
  return out
}

/** "Set intro start here" and its two siblings, as a fold over the record. */
export function setPoint(
  existing: SkipWindow | undefined,
  point: 'introStart' | 'introEnd' | 'endingStart',
  t: number,
  duration: number,
  now: number
): SkipWindow {
  const out: SkipWindow = { ...(existing ?? {}), source: 'manual', updatedAt: now }
  if (point === 'introStart') {
    out.introStart = Math.max(0, t)
    // Keep the pair ordered: setting a start past the end would otherwise store
    // a window `resolveWindows()` silently drops, with no feedback to the user.
    if (out.introEnd !== undefined && out.introEnd <= out.introStart) delete out.introEnd
  } else if (point === 'introEnd') {
    out.introEnd = Math.max(0, t)
    if (out.introStart !== undefined && out.introStart >= out.introEnd) out.introStart = 0
  } else {
    out.endingStart = Math.max(0, t)
    if (duration > 0) {
      out.refDuration = duration
      out.endingLead = Math.max(0, duration - t)
    }
  }
  return out
}

export function clearPoint(
  existing: SkipWindow | undefined,
  which: SkipKind,
  now: number
): SkipWindow | undefined {
  if (!existing) return undefined
  const out: SkipWindow = { ...existing, updatedAt: now }
  if (which === 'intro') {
    delete out.introStart
    delete out.introEnd
  } else {
    delete out.endingStart
    delete out.endingLead
    delete out.refDuration
  }
  if (out.introEnd === undefined && out.endingLead === undefined) return undefined
  return out
}

// ---------------------------------------------------------------------------
// Formatting (shared by the OSD text and the setup panel's payload)
// ---------------------------------------------------------------------------

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}
