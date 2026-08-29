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
// guessed; scripts/verify-natural-sort.mjs re-derives them and diffs 27k+
// ordered pairs against this implementation.
//
// THE DIVERGENCE THAT ADDED THE FOLDING LAYER. Judged against
// `shlwapi!StrCmpLogicalW` over a real folder, 28 of 29 entries matched — and
// `ﬁle.mp4` (U+FB01, the 'fi' ligature) sat at index 21 for Explorer and 28 for
// us, which is EIGHT positional divergences from one character. The
// 27,225-pair differential passed because its generated corpus contained no
// such character: the check was clean because it could not see the case.
//
// Windows does two different things to characters that look like other
// characters, and conflating them is what produced the bug:
//
//   EXPANSION — an exact tie at every level. Measured with the real API over
//   U+00C0..U+024F, U+1E00..U+1EFF, U+2100..U+217F, U+2460..U+24FF,
//   U+3130..U+318F, U+1100..U+11FF, U+FB00..U+FB4F and U+FF01..U+FF60:
//   StrCmpLogicalW("xﬁy.mp4", "xfiy.mp4") is 0, and so are ß/ss, æ/ae, Œ/OE,
//   Ĳ/IJ, þ/th and the LJ/NJ/DZ digraphs. Those are folded away here.
//
//   VARIATION — the same PRIMARY weight, broken at the end. `ａ` (U+FF41) is
//   not equal to `a`, but `ａ2.mp4` < `a10.mp4`, which is only possible if the
//   full-width form carries the primary weight of `a`; it then sorts AFTER `a`
//   when everything else ties. Accents behave the same way (`é` primary-sorts
//   as `e`, and `é.mp4` > `e.mp4`).
//
// And two things that LOOK foldable and measurably are not: Roman numerals
// (U+2160 `Ⅰ` sorts between the digits and the letters, NOT with `I`) and
// circled forms (U+2460 `①`), so a blanket NFKC would have replaced one
// divergence with several hundred. Canonical composition IS applied: NFC makes
// a decomposed `é` equal to a precomposed one and composes Hangul jamo into
// syllables, both of which the API confirms are exact ties.

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

/**
 * SIX BANDS, in the order the API puts them. The old code had four and folded
 * everything non-ASCII into one bucket after the letters, which is wrong for
 * two families a Korean or Japanese release name really does carry:
 *
 *     'Ⅰm.mkv' vs '9m.mkv'  ->  Win32: Ⅰ is GREATER   (after the digits)
 *     'Ⅰm.mkv' vs 'am.mkv'  ->  Win32: Ⅰ is LESS      (before the letters)
 *     '€m.mkv' vs '0m.mkv'  ->  Win32: € is LESS      (before the digits)
 *     '가m.mkv' vs 'zm.mkv'  ->  Win32: 가 is GREATER   (after the letters)
 *
 * so a Roman numeral sits BETWEEN the digits and the letters, a symbol sits
 * BEFORE the digits, and only the letters of other scripts belong after `z`.
 * Measured over 35 representative characters against six ASCII references.
 *
 * A band is `band * BAND_STRIDE + sub`, so within-band order is by code point
 * (or by PUNCT_ORDER index, or by letter) in one integer comparison.
 */
const BAND_STRIDE = 0x400000
const BAND_PUNCT = 0
const BAND_SYMBOL = 1
const BAND_DIGIT = 2
const BAND_ROMAN = 3
const BAND_LETTER = 4
const BAND_SCRIPT = 5
const DIGIT_RANK = BAND_DIGIT * BAND_STRIDE

const isDigit = (c: string): boolean => c >= '0' && c <= '9'

/**
 * A Roman numeral compares by its VALUE, not by its code point: measured,
 * `Ⅸ.mkv` (U+2168) is GREATER than `ⅰv.mkv` (U+2170), which code-point order
 * gets backwards. U+2160..U+216F and U+2170..U+217F are the same twelve
 * numerals plus L, C, D, M in each case.
 */
const ROMAN_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, 100, 500, 1000]

function romanValue(c: string): number {
  const cp = c.codePointAt(0) ?? 0
  if (cp >= 0x2160 && cp <= 0x216f) return ROMAN_VALUES[cp - 0x2160]!
  if (cp >= 0x2170 && cp <= 0x217f) return ROMAN_VALUES[cp - 0x2170]!
  return cp
}

/** Unicode general categories, via the engine's own tables rather than a list. */
const ROMAN_NUMERAL = /\p{Nl}/u
const OTHER_NUMBER = /\p{No}/u
const SYMBOL_OR_PUNCT = /[\p{P}\p{S}]/u

/**
 * Characters Windows treats as EXACTLY EQUAL to a multi-character expansion,
 * at every weight level. Derived by asking the API, not by reading a table:
 * each row is a character `c` for which `StrCmpLogicalW('x'+c+'y', 'x'+e+'y')`
 * returned 0.
 *
 * Both cases are listed because the expansion happens before ranking, and
 * `rank()` folds case afterwards.
 */
const EXPANSIONS: ReadonlyMap<string, string> = new Map([
  // Latin ligatures with no canonical decomposition at all.
  ['ß', 'ss'], // ß
  ['Æ', 'AE'],
  ['æ', 'ae'],
  ['Œ', 'OE'],
  ['œ', 'oe'],
  ['Þ', 'th'], // Þ  (measured: folds, and case-insensitively)
  ['þ', 'th'], // þ
  // Latin digraph letters.
  ['Ĳ', 'IJ'],
  ['ĳ', 'ij'],
  ['Ǉ', 'LJ'],
  ['ǈ', 'Lj'],
  ['ǉ', 'lj'],
  ['Ǌ', 'NJ'],
  ['ǋ', 'Nj'],
  ['ǌ', 'nj'],
  ['Ǳ', 'DZ'],
  ['ǲ', 'Dz'],
  ['ǳ', 'dz'],
  // The alphabetic presentation forms — the block `ﬁle.mp4` came from.
  ['ﬀ', 'ff'],
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬆ', 'st'],
  // Letterlike symbols that fold onto a real letter.
  ['K', 'K'], // KELVIN SIGN
  ['Ω', 'Ω'] // OHM SIGN -> Greek capital omega
])

/** U+FF01..U+FF5E: the same primary weight as the ASCII twin, one tier later. */
function fullWidthTwin(c: string): string | null {
  const n = c.charCodeAt(0)
  return n >= 0xff01 && n <= 0xff5e ? String.fromCharCode(n - 0xfee0) : null
}

/**
 * The form the PRIMARY comparison runs on: canonical composition, expansions
 * applied, full-width folded to its ASCII twin.
 *
 * Full-width folding here is what makes `ａ2.mp4` < `a10.mp4` (a numeric run
 * comparison, which needs `２` to be a digit) rather than sorting the whole
 * FF block after every ASCII letter.
 */
function foldPrimary(s: string): string {
  let out = ''
  for (const c of s.normalize('NFC')) {
    const expansion = EXPANSIONS.get(c)
    if (expansion !== undefined) {
      out += expansion
      continue
    }
    /**
     * Full-width LETTERS and PUNCTUATION fold to their ASCII twin, which is
     * what makes `ａ2.mkv` < `a10.mkv` — a numeric-run comparison that only
     * happens once `ａ` is an `a`.
     *
     * Full-width DIGITS deliberately do NOT fold, and that is measured rather
     * than tidy: `１.mkv` > `1.mkv` and `１.mkv` < `2.mkv`, so `１` carries the
     * WEIGHT of the digit without being one. Folding it into the ASCII digit
     * run would make `１0` the number ten; Windows does not.
     */
    const wide = fullWidthTwin(c)
    if (wide !== null && !isDigit(wide)) {
      out += wide
      continue
    }
    out += c
  }
  return out
}

/**
 * The digit a character carries the WEIGHT of without being an ASCII digit:
 * `１` (U+FF11) and `①` (U+2460) both compare as `1` — measured `①m.mkv` is
 * greater than `1m.mkv`, less than `2m.mkv` and less than `9m.mkv` — but
 * neither of them joins an ASCII digit run.
 *
 * `⑩` is NOT one of these: it is measured GREATER than `99.mkv` and less than
 * `a.mkv`, so it does not carry the value ten. Only the single-digit forms do,
 * which is why the compatibility decomposition has to be one character long.
 */
function digitWeight(c: string): number | null {
  if (isDigit(c)) return c.charCodeAt(0) - 48
  const wide = fullWidthTwin(c)
  if (wide !== null && isDigit(wide)) return wide.charCodeAt(0) - 48
  if (OTHER_NUMBER.test(c)) {
    const compat = c.normalize('NFKD')
    if (compat.length === 1 && isDigit(compat)) return compat.charCodeAt(0) - 48
  }
  return null
}

/**
 * The form the TIEBREAK runs on: composition and expansions, but full-width
 * and accented characters kept, because those are exactly the differences the
 * tiebreak exists to see.
 */
function foldTertiary(s: string): string {
  let out = ''
  for (const c of s.normalize('NFC')) out += EXPANSIONS.get(c) ?? c
  return out
}

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
  // Every digit-weighted character sits in the digit band AT ITS OWN VALUE, so
  // `①` compares less than `9` and greater than `0` when the other side is a
  // plain digit. (Two ASCII digits never reach here: `comparePrimary` takes the
  // numeric-run path for those.)
  const weight = digitWeight(c)
  if (weight !== null) return DIGIT_RANK + weight
  const lower = c.toLowerCase()
  const code = lower.charCodeAt(0)
  if (code >= 97 && code <= 122) return BAND_LETTER * BAND_STRIDE + (code - 97)

  const idx = PUNCT_ORDER.indexOf(c)
  if (idx !== -1) return BAND_PUNCT * BAND_STRIDE + idx

  // Windows folds accented Latin onto its base letter, so `Ätest` sorts with
  // `a` rather than after `z`. Decompose and retry before giving up.
  const base = lower.normalize('NFD').charCodeAt(0)
  if (base >= 97 && base <= 122) return BAND_LETTER * BAND_STRIDE + (base - 97)

  // A Roman numeral is not the letter it looks like: measured, `Ⅰ` is greater
  // than `9`, less than `a`, and less than `I`. It gets its own band rather
  // than a compatibility expansion — which is exactly why `foldPrimary`
  // refuses to expand this category.
  //
  // A multi-digit circled form lands here too: `⑩` is measured GREATER than
  // `99` and less than `a`, so it does not carry the value 10 — only the
  // single-digit forms (`①`..`⑨`, which `foldPrimary` turns into digits) do.
  // A Roman numeral outranks a circled number inside the band: measured,
  // `Ⅰ.mkv` is GREATER than both `①.mkv` and `⑩.mkv`, which their code points
  // say the other way round.
  if (ROMAN_NUMERAL.test(c)) {
    return BAND_ROMAN * BAND_STRIDE + 0x200000 + romanValue(c)
  }
  if (OTHER_NUMBER.test(c)) return BAND_ROMAN * BAND_STRIDE + (c.codePointAt(0) ?? 0)

  // Currency, arrows, box drawing, dingbats: measured BEFORE the digits, where
  // the old single non-ASCII bucket put them after `z`.
  if (SYMBOL_OR_PUNCT.test(c)) return BAND_SYMBOL * BAND_STRIDE + (c.codePointAt(0) ?? 0)

  // Letters of every other script — Hangul, CJK, Kana, Greek, Cyrillic — sort
  // after ASCII letters by code point, which is the correct dictionary order
  // for those scripts. The ORIGINAL code point, not the decomposed one, so
  // Hangul syllables stay contiguous.
  // The Hangul COMPATIBILITY jamo block (U+3130..U+318F) ranks ABOVE the
  // syllables, which its code points do not: measured, `한글.mkv` (U+D55C…) is
  // LESS than `ㅏ.mkv` (U+314F). The CONJOINING jamo are a different story —
  // `NFC` composes them into syllables above, which is what the API does too.
  const cp = c.codePointAt(0) ?? 0
  const isCompatJamo = cp >= 0x3130 && cp <= 0x318f
  return BAND_SCRIPT * BAND_STRIDE + (isCompatJamo ? 0x20000 + cp : cp)
}

/**
 * Natural ("human") ordering matching Windows Explorer.
 *
 *   - digit runs compare numerically: `ep2` before `ep10`
 *   - zero padding loses to magnitude but beats everything after it, so
 *     `S01E10` sorts before `S1E2`
 *   - more zero padding sorts first: `01.mkv` before `1.mkv`
 *   - letters are case-insensitive: `x.mkv` and `X.mkv` compare equal
 *   - `ﬁle.mkv` compares as `file.mkv`, and `ａ.mkv` as `a.mkv` but one tier
 *     later
 */
export function naturalCompare(a: string, b: string): number {
  const primary = comparePrimary(foldPrimary(a), foldPrimary(b))
  if (primary !== 0) return primary
  // The last tier needs the ORIGINALS: `foldTertiary` composes, and the Hangul
  // difference it has to see is precisely the one composition erases.
  return tiebreak(foldTertiary(a), foldTertiary(b), a, b)
}

/**
 * `'ascii'` for `0`-`9`, `'wide'` for `０`-`９`, null otherwise.
 *
 * A run is homogeneous in KIND, and that is the measured rule rather than a
 * simplification: `１0.mkv` < `10.mkv` < `100.mkv`, and `１0.mkv` > `1.mkv`,
 * which only holds if `１0` is the number ONE followed by a separate run `0`.
 * Merging the two kinds into `10` would make it a tie, and folding `１` to a
 * plain `1` would make `007.mkv` < `１z.mkv` — Win32 says greater.
 */
function digitKind(c: string | undefined): 'ascii' | 'wide' | null {
  if (c === undefined) return null
  if (isDigit(c)) return 'ascii'
  const wide = fullWidthTwin(c)
  return wide !== null && isDigit(wide) ? 'wide' : null
}

/** A digit run as plain ASCII, so the value comparison sees one alphabet. */
function digitRun(s: string, from: number, kind: 'ascii' | 'wide'): string {
  let out = ''
  for (let k = from; k < s.length && digitKind(s[k]) === kind; k++) {
    out += kind === 'ascii' ? s[k] : fullWidthTwin(s[k]!)
  }
  return out
}

function comparePrimary(a: string, b: string): number {
  let i = 0
  let j = 0

  for (;;) {
    while (i < a.length && IGNORABLE.includes(a[i]!)) i++
    while (j < b.length && IGNORABLE.includes(b[j]!)) j++

    if (i >= a.length && j >= b.length) return 0
    if (i >= a.length) return -1
    if (j >= b.length) return 1

    const ca = a[i]!
    const cb = b[j]!
    const ka = digitKind(ca)
    const kb = digitKind(cb)

    if (ka !== null && kb !== null) {
      const aRun = digitRun(a, i, ka)
      const bRun = digitRun(b, j, kb)
      const ai = i + aRun.length
      const bj = j + bRun.length
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
}

/**
 * The strings carry the same primary weight. What is left is the tier Windows
 * decides last: the ignorable characters, and the VARIATIONS that share a
 * primary weight with a plainer character — an accent, a full-width form.
 *
 * A plain ASCII character contributes nothing here (weight 0), which is what
 * makes `x.mkv` and `X.mkv` compare equal and `ﬁle.mkv` and `file.mkv` compare
 * equal: after expansion both sides are the same ASCII, so every position ties.
 */
const IGNORABLE_RANK_BASE = Number.MAX_SAFE_INTEGER - 16

/**
 * TWO PASSES, and the order between them is measured rather than chosen.
 *
 *     'ａ.mkv' vs '-a.mkv'   ->  Win32 says ａ is GREATER
 *
 * Both sides carry the primary weight `a.mkv` (the hyphen is ignorable). A
 * single-pass tiebreak that walks positions has to decide whether the hyphen or
 * the full-width `ａ` speaks first, and putting the hyphen first gets this
 * backwards. So the VARIATION difference — width, accent — is settled over the
 * ignorable-free text, and only if that ties do the ignorables get a vote.
 * That is the ordinary Unicode tertiary-then-quaternary arrangement, arrived at
 * from the API rather than from the spec.
 */
function tiebreak(a: string, b: string, rawA: string, rawB: string): number {
  const variation = compareVariation(a, b)
  if (variation !== 0) return variation
  const ignorables = compareIgnorables(a, b)
  if (ignorables !== 0) return ignorables
  return compareHangulComposition(rawA, rawB)
}

/**
 * The width/accent tier, over the ignorable-free text.
 *
 * A plain ASCII character contributes nothing (weight 0), which is what makes
 * `x.mkv` and `X.mkv` compare equal, and `ﬁle.mkv` and `file.mkv` equal — after
 * expansion both sides are the same ASCII, so every position ties.
 *
 * Full-width forms get their own band BELOW every other variation, because
 * `１.mkv` is measured LESS than `①.mkv` while their code points run the other
 * way; a raw code-point tiebreak gets that pair backwards.
 */
function variationRank(c: string): number {
  const lower = c.toLowerCase()
  const code = lower.codePointAt(0) ?? 0
  if (code < 0x80) return 0
  const wide = fullWidthTwin(lower)
  if (wide !== null) return 0x100 + (wide.codePointAt(0) ?? 0)
  return 0x10000 + code
}

function compareVariation(a: string, b: string): number {
  let i = 0
  let j = 0
  for (;;) {
    while (i < a.length && isIgnorable(a[i]!)) i++
    while (j < b.length && isIgnorable(b[j]!)) j++
    if (i >= a.length && j >= b.length) return 0
    if (i >= a.length) return -1
    if (j >= b.length) return 1
    const ra = variationRank(a[i]!)
    const rb = variationRank(b[j]!)
    if (ra !== rb) return ra < rb ? -1 : 1
    i++
    j++
  }
}

/**
 * The ignorables, in their own order: Windows sorts an apostrophe before a
 * hyphen, and the full-width forms of both after the ASCII ones
 * (`－a.mkv` > `-a.mkv`, measured).
 */
const IGNORABLE_ORDER = ["'", '-', '’', '＇', '－']

function isIgnorable(c: string): boolean {
  return IGNORABLE_ORDER.includes(c)
}

function compareIgnorables(a: string, b: string): number {
  const len = Math.max(a.length, b.length)
  for (let k = 0; k < len; k++) {
    const ca = a[k]
    const cb = b[k]
    if (ca === undefined) return -1
    if (cb === undefined) return 1
    const ia = IGNORABLE_ORDER.indexOf(ca)
    const ib = IGNORABLE_ORDER.indexOf(cb)
    const ra = ia === -1 ? 0 : IGNORABLE_RANK_BASE + ia
    const rb = ib === -1 ? 0 : IGNORABLE_RANK_BASE + ib
    if (ra !== rb) return ra < rb ? -1 : 1
  }
  return 0
}

/**
 * The last discriminator, and it applies to HANGUL ONLY.
 *
 * The asymmetry is the whole point. A decomposed `é` (`e` + U+0301) and a
 * precomposed `é` compare EXACTLY EQUAL at every tier; a jamo-spelled `가`
 * (U+1100 U+1161) is measured LESS than the precomposed syllable U+AC00. Both
 * pairs are canonically equivalent and `NFC` makes each pair identical, so the
 * difference cannot come from the primary comparison — it is the last tier, and
 * only Hangul has it. A general code-point fallback here would break the Latin
 * case, which is why this is not one.
 */
const CONJOINING_JAMO = /[ᄀ-ᇿ]/

function compareHangulComposition(a: string, b: string): number {
  const ja = CONJOINING_JAMO.test(a)
  const jb = CONJOINING_JAMO.test(b)
  if (ja === jb) return 0
  return ja ? -1 : 1
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

/**
 * Every media file directly inside `dir`, in Explorer's order.
 *
 * U34 opens a dropped FOLDER, and the first cut of that path called
 * `fs.readdirSync` and used the result as-is. `readdir` returns whatever order
 * the filesystem hands back (NTFS: a B-tree walk, which is UTF-16 code-unit
 * order), so a folder of `a1 a10 a2 b` played in that order while Explorer —
 * and every other entry point in this app — showed `a1 a2 a10 b`. Explorer-exact
 * ordering is a headline feature; it belongs to the function that produces a
 * listing, not to each of its callers.
 */
export function expandDirectory(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter(isMediaFile)
    .sort(naturalCompare)
    .map((n) => path.join(dir, n))
}

/**
 * Sort a set of already-chosen paths the way Explorer would.
 *
 * Multi-select in Explorer and a multi-file drop both arrive in selection
 * order, which is the order the user happened to ctrl-click in. Files from one
 * folder sort together and folders keep their own order, so the comparison is
 * (directory, then filename) — sorting the full path as one string would
 * interleave `a\z.mkv` and `a-b\c.mkv` by the separator's rank.
 */
export function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const da = path.dirname(a)
    const db = path.dirname(b)
    if (da !== db) {
      const d = naturalCompare(da, db)
      if (d !== 0) return d
    }
    return naturalCompare(path.basename(a), path.basename(b))
  })
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
