/**
 * M26 nav-bookmarks — the pure half.
 *
 * Everything here is a total function over plain values: no mpv, no Electron,
 * no filesystem. That is what lets `bookmarks.test.ts` run the REAL logic under
 * `node --test` rather than a copy of it, which is the failure mode four audit
 * rounds kept finding (a check that exercises a hand-written table instead of
 * the thing it is checking).
 *
 * The mpv-facing rules that shape these signatures come from §2.5:
 *   - N17: `ab-loop-a` / `ab-loop-b` hold `number | "no"`. A naive
 *     `typeof x === 'number'` guard reads a CLEARED point as 0, which draws a
 *     loop region starting at 0:00 over a file the user never looped.
 *   - N21: `ab-loop-count` defaults to the STRING `"inf"`, and writing `0`
 *     disables A-B looping outright — so "infinite" is never 0.
 *   - N12: next/prev use a 0.25 s dead zone around `time-pos`, or "next" from
 *     one frame after a bookmark lands back on the bookmark you are standing on.
 */

/** ~200 per file is plenty (PotPlayer caps at 2000); the cap keeps the
 *  per-file record small enough that the seek bar can draw every pin. */
export const MAX_BOOKMARKS = 200

/** N12's dead zone, in seconds. */
export const STEP_EPSILON = 0.25

/**
 * `Bookmark` is DECLARED ONCE, in `src/shared/features/nav-bookmarks/wire.ts`,
 * and re-exported here so the module's own pure half keeps its single import
 * point. It used to be declared here, again in this module's main `index.ts` and
 * again in its renderer half -- three copies of one payload, because a module's
 * two halves share no compilation unit and nothing compared them.
 */
import type { Bookmark } from '@shared/features/nav-bookmarks/wire'
export type { Bookmark }

/** What the module keeps mirrored from `ab-loop-a` / `ab-loop-b`. */
export interface AbLoop {
  a: number | null
  b: number | null
}

// ---------------------------------------------------------------------------
// mpv value coercion
// ---------------------------------------------------------------------------

/**
 * `ab-loop-a` / `ab-loop-b` as a number, or null when the point is not set.
 *
 * mpv answers the STRING `"no"` for a cleared point (§2.5 N17, verified), and
 * `undefined` while the property has not been reported yet. Both mean "unset",
 * and neither may become 0.
 */
export function loopPoint(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return null
}

/**
 * N21: the value to WRITE to `ab-loop-count`.
 *
 * `0` is not "off", it is "do not loop at all", which silently kills the
 * feature the user just switched on. Anything non-positive means infinite, and
 * infinite is the string `"inf"`.
 */
export function loopCountToMpv(count: number): number | 'inf' {
  if (!Number.isFinite(count) || count <= 0) return 'inf'
  return Math.min(999, Math.floor(count))
}

/** `remaining-ab-loops` reads -1 when the count is `"inf"` — not null, not
 *  Infinity — so a `> 0` test would report "no repeats left" forever. */
export function remainingLoops(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')

/** `1:02:03` / `2:03`. Used for list rows and the default bookmark name. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0))
  const h = Math.floor(s / 3600)
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** `1:12.4` — N50's OSD form for an A-B endpoint, where a tenth of a second is
 *  the whole point of the feature. */
export function formatPrecise(sec: number): string {
  const v = Math.max(0, Number.isFinite(sec) ? sec : 0)
  const whole = Math.floor(v)
  const tenth = Math.min(9, Math.floor((v - whole) * 10))
  return `${formatTime(whole)}.${tenth}`
}

/** N11: "default the name to the timecode so a bookmark is never nameless". */
export function defaultTitle(sec: number): string {
  return formatTime(sec)
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

let idCounter = 0

/** Unique within a session and stable once stored. Not a UUID on purpose: it
 *  goes into a JSON record the user can read and hand-edit. */
export function makeId(now: number = Date.now()): string {
  idCounter = (idCounter + 1) % 100000
  return `bm-${now.toString(36)}-${idCounter.toString(36)}`
}

export function sortBookmarks(list: readonly Bookmark[]): Bookmark[] {
  return [...list].sort((x, y) => x.t - y.t || x.createdAt - y.createdAt)
}

/**
 * Whatever came back out of the per-file store, turned into a list we can
 * trust.
 *
 * The store preserves unknown keys across versions (P10) and a user may edit
 * the file, so this is a parser, not a cast: a `t` that is a string, a missing
 * title, a `b` behind its own `a` and a duplicate id all have to survive
 * contact with the panel.
 */
export function sanitizeBookmarks(raw: unknown, max = MAX_BOOKMARKS): Bookmark[] {
  if (!Array.isArray(raw)) return []
  const out: Bookmark[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const t = Number(rec['t'])
    if (!Number.isFinite(t) || t < 0) continue
    const bRaw = Number(rec['b'])
    const b = Number.isFinite(bRaw) && bRaw > t ? bRaw : undefined
    let id = typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : makeId()
    while (seen.has(id)) id = makeId()
    seen.add(id)
    const title = typeof rec['title'] === 'string' && rec['title'].trim() ? rec['title'] : defaultTitle(t)
    const createdAt = Number(rec['createdAt'])
    const bookmark: Bookmark = {
      id,
      t,
      title,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0
    }
    if (b !== undefined) bookmark.b = b
    out.push(bookmark)
    if (out.length >= max) break
  }
  return sortBookmarks(out)
}

/** N12: the first bookmark strictly after the dead zone, or null. */
export function nextBookmark(list: readonly Bookmark[], time: number): Bookmark | null {
  return sortBookmarks(list).find((b) => b.t > time + STEP_EPSILON) ?? null
}

/** N12: the last bookmark strictly before the dead zone, or null. */
export function prevBookmark(list: readonly Bookmark[], time: number): Bookmark | null {
  const before = sortBookmarks(list).filter((b) => b.t < time - STEP_EPSILON)
  return before.length > 0 ? (before[before.length - 1] as Bookmark) : null
}

// ---------------------------------------------------------------------------
// A-B loop
// ---------------------------------------------------------------------------

/**
 * N17's one-key cycle, as a pure transition: A → B → clear.
 *
 * Setting B behind A produces a loop mpv cannot play, so a press that would do
 * that restarts the cycle at the new A instead of storing an inverted pair.
 */
export function cycleAbLoop(current: AbLoop, time: number): AbLoop {
  if (current.a === null) return { a: time, b: null }
  if (current.b === null) {
    return time > current.a ? { a: current.a, b: time } : { a: time, b: null }
  }
  return { a: null, b: null }
}

/**
 * N18: nudge an endpoint by ±0.1 s.
 *
 * The guard is the point. `['add','ab-loop-a',0.1]` on a property holding the
 * string `"no"` is an mpv ERROR, so an unset endpoint must no-op here rather
 * than reach the wire.
 */
export function nudgePoint(value: number | null, delta: number): number | null {
  if (value === null) return null
  return Math.max(0, Math.round((value + delta) * 1000) / 1000)
}

/**
 * N20: the current subtitle line as a loop.
 *
 * `sub-start`/`sub-end` are SUBTITLE time and `ab-loop-*` are VIDEO time, so
 * `sub-delay` has to be applied; and the last syllable clips without a small
 * tail on B. Both properties are null when nothing is on screen, which is a
 * "tell the user" case and not a zero-length loop.
 */
export function subtitleLoop(
  start: unknown,
  end: unknown,
  subDelay: number,
  tailSec: number
): AbLoop | null {
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const delay = Number.isFinite(subDelay) ? subDelay : 0
  const a = Math.max(0, start + delay)
  const b = end + delay + Math.max(0, tailSec)
  return b > a ? { a, b } : null
}

// ---------------------------------------------------------------------------
// N15 — export / import
// ---------------------------------------------------------------------------

export interface BookmarkExport {
  version: 1
  file: string
  bookmarks: Array<{ t: number; title: string; b?: number }>
}

export function toExportJson(file: string, list: readonly Bookmark[]): string {
  const doc: BookmarkExport = {
    version: 1,
    file,
    bookmarks: sortBookmarks(list).map((b) =>
      b.b === undefined ? { t: b.t, title: b.title } : { t: b.t, title: b.title, b: b.b }
    )
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * ffmetadata escaping: `=`, `;`, `#`, `\` and a newline are the five characters
 * ffmpeg's own parser treats as syntax.
 */
function escapeFf(value: string): string {
  return value.replace(/([=;#\\])/g, '\\$1').replace(/\r?\n/g, ' ')
}

/**
 * N15's clever half: the same list as an ffmetadata chapter file, so it round
 * trips through our own `--chapters-file` support (N07) and through mkvtoolnix.
 * A user is never locked into our JSON.
 *
 * A point bookmark has no end, so it borrows the next bookmark's start, and the
 * last one borrows the file duration. END must exceed START or ffmpeg drops the
 * chapter silently.
 */
export function toFfmetadata(list: readonly Bookmark[], duration: number): string {
  const sorted = sortBookmarks(list)
  const lines = [';FFMETADATA1']
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0
  for (let i = 0; i < sorted.length; i++) {
    const bm = sorted[i] as Bookmark
    const startMs = Math.max(0, Math.round(bm.t * 1000))
    const nextT = bm.b ?? sorted[i + 1]?.t ?? (end > bm.t ? end : bm.t + 1)
    const endMs = Math.max(startMs + 1, Math.round(nextT * 1000))
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${endMs}`, `title=${escapeFf(bm.title)}`)
  }
  return `${lines.join('\n')}\n`
}

function unescapeFf(value: string): string {
  return value.replace(/\\([=;#\\])/g, '$1')
}

/**
 * Accepts either form we can emit, plus an ffmetadata file somebody made
 * elsewhere. Import is where a hand-written file arrives, so nothing here may
 * throw on shape: an unparseable file yields an empty list and the caller says
 * so.
 */
export function parseImport(text: string, now: number = Date.now()): Bookmark[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as { bookmarks?: unknown }
      return sanitizeBookmarks(
        Array.isArray(doc.bookmarks)
          ? doc.bookmarks.map((b) => ({ ...(b as object), createdAt: now }))
          : []
      )
    } catch {
      return []
    }
  }
  if (!trimmed.startsWith(';FFMETADATA')) return []

  const out: Array<Record<string, unknown>> = []
  let current: Record<string, unknown> | null = null
  let timebase = 1000
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '[CHAPTER]') {
      current = {}
      out.push(current)
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toUpperCase()
    const value = line.slice(eq + 1)
    if (key === 'TIMEBASE') {
      const denom = Number(value.split('/')[1])
      if (Number.isFinite(denom) && denom > 0) timebase = denom
    } else if (key === 'START') {
      current['start'] = Number(value)
    } else if (key === 'END') {
      current['end'] = Number(value)
    } else if (key === 'TITLE') {
      current['title'] = unescapeFf(value)
    }
  }
  return sanitizeBookmarks(
    out
      .filter((c) => Number.isFinite(Number(c['start'])))
      .map((c) => ({
        t: Number(c['start']) / timebase,
        title: c['title'],
        createdAt: now
      }))
  )
}

/**
 * Merge an imported list into the existing one without producing two pins on
 * the same frame. Same second (within 10 ms) and same title = the same
 * bookmark; anything else is new.
 */
export function mergeBookmarks(
  existing: readonly Bookmark[],
  incoming: readonly Bookmark[],
  max = MAX_BOOKMARKS
): Bookmark[] {
  const out = [...existing]
  for (const bm of incoming) {
    const dup = out.some((e) => Math.abs(e.t - bm.t) < 0.01 && e.title === bm.title)
    if (dup || out.length >= max) continue
    out.push(bm)
  }
  return sortBookmarks(out)
}
