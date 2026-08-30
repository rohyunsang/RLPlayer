/**
 * M35 R03 — the recent-URL history.
 *
 * Pure list logic plus a load/save pair that takes its path, so the reducer is
 * testable without touching a disk and the module owns the only file handle.
 *
 * WHY THIS IS A FILE OF ITS OWN AND NOT A PER-FILE SLICE. `ctx.perFile` is
 * keyed by a one-way hash of path AND SIZE (§9), which a URL does not have; and
 * the history is a list ABOUT files rather than state OF one. `ctx.settings`
 * would put a fifty-entry LRU in the generated settings form. So this is the one
 * place the module keeps its own JSON, in `ctx.paths.dataDir()`, and the write
 * is deliberately boring — see `saveRecent` for what it does NOT promise.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface RecentUrl {
  /** The user's original string. Never a parser's round trip. */
  readonly url: string
  /** mpv's `media-title` once it is known; the URL until then. */
  readonly title: string
  readonly lastPlayed: number
}

/** PotPlayer's own cap is "about 50"; the spec says LRU-capped ~50. */
export const MAX_RECENT = 50

/**
 * Most-recent-first insert with de-duplication on the URL.
 *
 * The de-duplication key is the URL EXACTLY as entered, because two strings that
 * differ only in a query parameter are two different streams — an HLS URL with a
 * rotated `?token=` is the same channel, but we cannot know that, and collapsing
 * them would silently discard the token the user pasted.
 */
export function addRecent(
  list: readonly RecentUrl[],
  entry: RecentUrl,
  cap: number = MAX_RECENT
): RecentUrl[] {
  const rest = list.filter((r) => r.url !== entry.url)
  return [entry, ...rest].slice(0, Math.max(0, cap))
}

/** Retitle an existing entry once mpv reports `media-title`. A no-op if absent. */
export function retitleRecent(
  list: readonly RecentUrl[],
  url: string,
  title: string
): RecentUrl[] {
  let hit = false
  const out = list.map((r) => {
    if (r.url !== url || r.title === title) return r
    hit = true
    return { url: r.url, title, lastPlayed: r.lastPlayed }
  })
  return hit ? out : list.slice()
}

export function removeRecent(list: readonly RecentUrl[], url: string): RecentUrl[] {
  return list.filter((r) => r.url !== url)
}

/**
 * Reject anything that is not shaped like an entry, entry by entry.
 *
 * A corrupt or hand-edited file must lose the bad rows and keep the good ones:
 * throwing away the whole list because row 12 has a numeric `url` is the same
 * mistake P10 is about one level up. Unknown keys are dropped rather than
 * preserved — this file is entirely ours, so there is no forward-compatibility
 * story to protect, and keeping unknown keys in a list of user URLs would be a
 * place for junk to accumulate.
 */
export function sanitizeRecent(raw: unknown, cap: number = MAX_RECENT): RecentUrl[] {
  if (!Array.isArray(raw)) return []
  const out: RecentUrl[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const url = rec['url']
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    const title = typeof rec['title'] === 'string' && rec['title'].length > 0 ? rec['title'] : url
    const lastPlayed = typeof rec['lastPlayed'] === 'number' && Number.isFinite(rec['lastPlayed'])
      ? rec['lastPlayed']
      : 0
    seen.add(url)
    out.push({ url, title, lastPlayed })
    if (out.length >= cap) break
  }
  return out
}

export function recentFile(dataDir: string): string {
  return path.join(dataDir, 'stream-urls.json')
}

export function loadRecent(dataDir: string): RecentUrl[] {
  try {
    return sanitizeRecent(JSON.parse(fs.readFileSync(recentFile(dataDir), 'utf8')))
  } catch {
    // A missing file and a corrupt one are the same thing to a history list.
    return []
  }
}

/**
 * Write, atomically enough for a history list and no more.
 *
 * Deliberately NOT the settings store's fsync-and-quarantine dance (P11/P12):
 * losing the last URL a user pasted on a power cut is an annoyance, and a module
 * re-implementing the durable store here would be the duplication §9 warns
 * about. `tmp` + `rename` is enough to never leave a half-written file behind,
 * which is the only failure that would cost the whole list.
 */
export function saveRecent(dataDir: string, list: readonly RecentUrl[]): void {
  const target = recentFile(dataDir)
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing to do; the next save will overwrite it */
    }
  }
}
