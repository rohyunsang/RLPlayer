import fs from 'node:fs'
import path from 'node:path'
import type { PlaylistItem } from '@shared/types'

export {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  SUB_EXTENSIONS,
  isMediaFile,
  isSubtitleFile
} from '../../shared/media-types.ts'
// Relative + .ts: this file is unit-tested under `node --test`, which strips
// types but knows nothing about the bundler's '@shared' alias.
import { isMediaFile } from '../../shared/media-types.ts'

// --- natural sort ---------------------------------------------------------
//
// Reproduces Windows' StrCmpLogicalW so playlist order matches File Explorer.
// Every constant below was extracted from the real shlwapi API rather than
// guessed; scripts/verify-natural-sort.mjs re-derives them and diffs 1400+
// ordered pairs against this implementation.

/**
 * Apostrophe and hyphen are *ignorable* in Windows word sort: they drop out of
 * the primary comparison entirely and only break an otherwise exact tie. This
 * is why `a-b.mkv` sorts after `a1.mkv` -- it compares as `ab.mkv`.
 */
const IGNORABLE = "'-"

/**
 * ASCII punctuation in Windows word-sort order. Note this is NOT code-point
 * order: '.' precedes digits while '+', '<', '=', '>' and '\' follow all other
 * punctuation, and digits sit between punctuation and letters.
 */
const PUNCT_ORDER = ' !"#$%&()*,./:;?@[]^_`{|}~\\+<=>'
const DIGIT_RANK = PUNCT_ORDER.length
const LETTER_BASE = DIGIT_RANK + 1
const NON_ASCII_BASE = LETTER_BASE + 26

const isDigit = (c: string): boolean => c >= '0' && c <= '9'

const rankCache = new Map<string, number>()

/** Sort weight of a single character, case-insensitive for letters. */
function rank(c: string): number {
  const memo = rankCache.get(c)
  if (memo !== undefined) return memo
  const r = computeRank(c)
  rankCache.set(c, r)
  return r
}

function computeRank(c: string): number {
  if (isDigit(c)) return DIGIT_RANK
  const lower = c.toLowerCase()
  const code = lower.charCodeAt(0)
  if (code >= 97 && code <= 122) return LETTER_BASE + (code - 97)

  const idx = PUNCT_ORDER.indexOf(c)
  if (idx !== -1) return idx

  // Windows folds accented Latin onto its base letter, so `Ätest` sorts with
  // `a` rather than after `z`. Decompose and retry before giving up.
  const base = lower.normalize('NFD').charCodeAt(0)
  if (base >= 97 && base <= 122) return LETTER_BASE + (base - 97)

  // Everything else (Hangul, CJK) sorts after ASCII letters by code point,
  // which is the correct dictionary order for those scripts. Uses the original
  // code point, not the decomposed one, so Hangul syllables stay contiguous.
  return NON_ASCII_BASE + code
}

/**
 * Natural ("human") ordering matching Windows Explorer.
 *
 *   - digit runs compare numerically: `ep2` before `ep10`
 *   - zero padding loses to magnitude but beats everything after it, so
 *     `S01E10` sorts before `S1E2`
 *   - more zero padding sorts first: `01.mkv` before `1.mkv`
 *   - letters are case-insensitive: `x.mkv` and `X.mkv` compare equal
 */
export function naturalCompare(a: string, b: string): number {
  let i = 0
  let j = 0

  for (;;) {
    while (i < a.length && IGNORABLE.includes(a[i]!)) i++
    while (j < b.length && IGNORABLE.includes(b[j]!)) j++

    if (i >= a.length && j >= b.length) break
    if (i >= a.length) return -1
    if (j >= b.length) return 1

    const ca = a[i]!
    const cb = b[j]!

    if (isDigit(ca) && isDigit(cb)) {
      let ai = i
      let bj = j
      while (ai < a.length && isDigit(a[ai]!)) ai++
      while (bj < b.length && isDigit(b[bj]!)) bj++
      const aRun = a.slice(i, ai)
      const bRun = b.slice(j, bj)
      const aSig = aRun.replace(/^0+(?=\d)/, '')
      const bSig = bRun.replace(/^0+(?=\d)/, '')

      if (aSig.length !== bSig.length) return aSig.length < bSig.length ? -1 : 1
      if (aSig !== bSig) return aSig < bSig ? -1 : 1

      // Same value: padding decides here and now. Deferring it to a final
      // tiebreak would order S1E2 before S01E10, which Explorer does not do.
      const az = aRun.length - aSig.length
      const bz = bRun.length - bSig.length
      if (az !== bz) return az > bz ? -1 : 1

      i = ai
      j = bj
      continue
    }

    const ra = rank(ca)
    const rb = rank(cb)
    if (ra !== rb) return ra < rb ? -1 : 1
    i++
    j++
  }

  return ignorableTiebreak(a, b)
}

/**
 * The strings are equal once apostrophes and hyphens are removed. Rank those
 * characters last so the name without them sorts first (`ab` before `a-b`).
 */
const IGNORABLE_RANK_BASE = Number.MAX_SAFE_INTEGER - 16

function ignorableRank(c: string): number {
  const i = IGNORABLE.indexOf(c)
  return i === -1 ? rank(c) : IGNORABLE_RANK_BASE + i
}

function ignorableTiebreak(a: string, b: string): number {
  const len = Math.max(a.length, b.length)
  for (let k = 0; k < len; k++) {
    const ca = a[k]
    const cb = b[k]
    if (ca === undefined) return -1
    if (cb === undefined) return 1
    // Ignorables rank after every real character, but keep their own order
    // relative to each other: Windows sorts an apostrophe before a hyphen.
    const ra = ignorableRank(ca)
    const rb = ignorableRank(cb)
    if (ra !== rb) return ra < rb ? -1 : 1
  }
  return 0
}

// --- folder scanning ------------------------------------------------------

/**
 * Build a playlist from every media file in the same folder as `file`,
 * naturally sorted. Returns the list plus the index of `file` within it.
 */
export function scanFolder(file: string): { items: PlaylistItem[]; index: number } {
  const dir = path.dirname(file)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { items: [{ path: file, name: path.basename(file) }], index: 0 }
  }

  const items: PlaylistItem[] = names
    .filter(isMediaFile)
    .sort(naturalCompare)
    .map((n) => ({ path: path.join(dir, n), name: n }))

  if (items.length === 0) {
    return { items: [{ path: file, name: path.basename(file) }], index: 0 }
  }

  const target = path.resolve(file).toLowerCase()
  let index = items.findIndex((i) => path.resolve(i.path).toLowerCase() === target)
  if (index === -1) {
    // The opened file is not in the folder listing (rare: permissions, race).
    items.unshift({ path: file, name: path.basename(file) })
    index = 0
  }
  return { items, index }
}

/** Fisher-Yates over the indices, keeping `keepIndex` first. */
export function shuffleOrder(length: number, keepIndex: number): number[] {
  const order = Array.from({ length }, (_, i) => i).filter((i) => i !== keepIndex)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return keepIndex >= 0 ? [keepIndex, ...order] : order
}
