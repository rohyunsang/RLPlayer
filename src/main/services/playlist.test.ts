import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  expandDirectory,
  isMediaFile,
  naturalCompare,
  shuffleOrder,
  sortPaths
} from './playlist.ts'

/**
 * These expectations were captured from the real Win32 StrCmpLogicalW.
 * scripts/verify-natural-sort.mjs re-checks 27k ordered pairs against the API
 * itself; this file pins the cases that actually matter to users so a
 * regression fails fast without needing PowerShell.
 */

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

function ordered(names: string[]): void {
  for (let i = 0; i < names.length - 1; i++) {
    const a = names[i]!
    const b = names[i + 1]!
    assert.equal(sign(naturalCompare(a, b)), -1, `expected ${a} < ${b}`)
    assert.equal(sign(naturalCompare(b, a)), 1, `expected ${b} > ${a}`)
  }
}

test('digit runs compare numerically, not lexically', () => {
  ordered(['ep1.mkv', 'ep2.mkv', 'ep10.mkv', 'ep11.mkv', 'ep100.mkv'])
  ordered(['part 2.avi', 'part 10.avi'])
  ordered(['file (2).mp4', 'file (10).mp4'])
  ordered(['9.mkv', '10.mkv', '99.mkv', '100.mkv'])
})

test('zero padding: value first, then more padding sorts earlier', () => {
  ordered(['01.mkv', '1a.mkv'])
  ordered(['001.mkv', '01.mkv', '1.mkv'])
  // Padding decides before a later digit run does -- Explorer really does put
  // S01E10 ahead of S1E2.
  ordered(['Show.S01E10.mkv', 'Show.S1E2.mkv'])
  ordered(['007.mkv', '7.mkv'])
})

/**
 * THE FOUR FAMILIES THAT SHARE A SORT WEIGHT WITH A PLAINER CHARACTER.
 *
 * `ﬁle.mp4` (U+FB01) sat at index 21 in Explorer and 28 for us — eight
 * positional divergences from one character — while the 27,225-pair
 * differential printed "0 mismatches", because every name it generated was
 * ASCII, Hangul or a Latin-1 accent. Each expectation here is the API's own
 * answer, taken from `scripts/verify-natural-sort.mjs`'s corpus.
 */
test('ligatures compare EXACTLY as their expansion (the ﬁle.mp4 divergence)', () => {
  assert.equal(naturalCompare('ﬁle.mp4', 'file.mp4'), 0)
  assert.equal(naturalCompare('ﬂy.mkv', 'fly.mkv'), 0)
  assert.equal(naturalCompare('ﬃx.mkv', 'ffix.mkv'), 0)
  assert.equal(naturalCompare('ß.mkv', 'ss.mkv'), 0)
  assert.equal(naturalCompare('æon.mkv', 'aeon.mkv'), 0)
  assert.equal(naturalCompare('Ĳ.mkv', 'IJ.mkv'), 0)
  // …and therefore lands between its neighbours rather than after every letter.
  ordered(['fh.mkv', 'fi.mkv', 'ﬁle.mp4', 'fj.mkv'])
})

test('decomposed and precomposed Latin are the same name', () => {
  assert.equal(naturalCompare('épisode.mkv', 'épisode.mkv'), 0)
  assert.equal(naturalCompare('Änna.mkv', 'Änna.mkv'), 0)
  // …and both fold onto the base letter for the primary comparison.
  ordered(['anna.mkv', 'Änna.mkv', 'azna.mkv'])
})

test('full-width forms carry the ASCII weight and sort one tier later', () => {
  assert.equal(sign(naturalCompare('ａ.mkv', 'a.mkv')), 1)
  assert.equal(sign(naturalCompare('１.mkv', '1.mkv')), 1)
  assert.equal(sign(naturalCompare('１.mkv', '2.mkv')), -1)
  // The primary weight is real: a numeric run comparison happens through it.
  assert.equal(sign(naturalCompare('ａ2.mkv', 'a10.mkv')), -1)
  ordered(['a.mkv', 'ａ.mkv', 'b.mkv'])
})

test('Hangul: jamo and syllables, and the blocks around them', () => {
  const jamoGa = '가'
  // A jamo-spelled syllable is the same NAME, one tier below the precomposed
  // form — measured, not assumed.
  assert.equal(sign(naturalCompare(`${jamoGa}.mkv`, '가.mkv')), -1)
  assert.equal(sign(naturalCompare(`${jamoGa}.mkv`, '가[.mkv')), -1)
  assert.equal(sign(naturalCompare(`${jamoGa}.mkv`, '가1.mkv')), -1)
  assert.equal(sign(naturalCompare(`${jamoGa}.mkv`, '각.mkv')), -1)
  assert.equal(sign(naturalCompare(`${jamoGa}.mkv`, '시즌.mkv')), -1)
  assert.equal(
    sign(naturalCompare('한글.mkv', '한글.mkv')),
    1
  )
})

test('what LOOKS foldable and is not: Roman numerals and circled numbers', () => {
  // A Roman numeral is not the letter it resembles: it sits between the digits
  // and the letters, and orders by VALUE.
  ordered(['9.mkv', 'Ⅰ.mkv', 'a.mkv'])
  assert.equal(sign(naturalCompare('Ⅸ.mkv', 'ⅰv.mkv')), 1)
  assert.equal(sign(naturalCompare('Ⅰ.mkv', '⑩.mkv')), 1)
  // A single-digit circled number carries the digit's weight without being one.
  ordered(['0.mkv', '①.mkv', '9.mkv'])
  assert.equal(sign(naturalCompare('①.mkv', '1.mkv')), 1)
  // A symbol sorts before the digits, where the old single non-ASCII bucket put
  // it after every letter.
  ordered(['~.mkv', '€.mkv', '0.mkv'])
})

test('letters compare case-insensitively', () => {
  assert.equal(naturalCompare('x.mkv', 'X.mkv'), 0)
  assert.equal(naturalCompare('ABC.mkv', 'abc.mkv'), 0)
})

test('punctuation follows Windows word sort, not code points', () => {
  // '.' precedes digits even though '.' (0x2E) < '1' (0x31) is the only reason
  // a naive comparator would get this right by accident; '_' and '[' do not.
  ordered(['a.mkv', 'a1.mkv'])
  ordered(['_pre.mkv', '1.mkv'])
  ordered(['[grp] 2.mkv', '1.mkv'])
  // '+', '<', '=', '>' and '\' sort after the other punctuation.
  ordered(['a_b.mkv', 'a+b.mkv'])
})

test('apostrophe and hyphen are ignorable, breaking ties only', () => {
  // `a-b` compares as `ab`, so it lands after `a1` and after `a.`
  ordered(['a1.mkv', 'a-b.mkv'])
  ordered(['a.mkv', 'a-b.mkv'])
  ordered(['ab.mkv', 'a-b.mkv'])
  ordered(["a'b.mkv", 'a-b.mkv'])
})

test('accented Latin folds onto its base letter', () => {
  ordered(['Ätest.mkv', 'etest.mkv'])
  ordered(['a.mkv', 'é1.mkv'])
})

test('Hangul sorts after Latin, in dictionary order', () => {
  ordered(['zzz.mkv', '시즌1 2화.mkv'])
  ordered(['시즌1 2화.mkv', '시즌1 10화.mkv', '시즌2 1화.mkv'])
})

test('sorting a realistic folder matches Explorer order', () => {
  const files = [
    'ep10.mkv', 'ep2.mkv', 'ep1.mkv', 'ep20.mkv', 'ep3.mkv', 'ep11.mkv'
  ]
  assert.deepEqual(
    [...files].sort(naturalCompare),
    ['ep1.mkv', 'ep2.mkv', 'ep3.mkv', 'ep10.mkv', 'ep11.mkv', 'ep20.mkv']
  )
})

test('comparator is a consistent total order', () => {
  const names = ['1.mkv', '01.mkv', 'a-b.mkv', 'ab.mkv', 'B.mkv', '한글.mkv', 'a b.mkv']
  for (const a of names) {
    assert.equal(naturalCompare(a, a), 0, `${a} must equal itself`)
    for (const b of names) {
      const forward = sign(naturalCompare(a, b))
      const reverse = sign(naturalCompare(b, a))
      // `|| 0` normalises -0, which strict equality distinguishes from 0.
      assert.equal(forward, -reverse || 0, `antisymmetry broken for ${a} / ${b}`)
    }
  }
})

test('media file detection covers the shipped associations', () => {
  for (const f of ['a.mkv', 'a.MP4', 'a.avi', 'a.m2ts', 'a.rmvb', 'a.flac']) {
    assert.equal(isMediaFile(f), true, `${f} should be media`)
  }
  for (const f of ['a.srt', 'a.txt', 'a.exe', 'noext']) {
    assert.equal(isMediaFile(f), false, `${f} should not be media`)
  }
})

test('shuffle keeps the current item first and loses nothing', () => {
  const order = shuffleOrder(10, 4)
  assert.equal(order[0], 4)
  assert.deepEqual([...order].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

// --- folder expansion (U34) -------------------------------------------------
//
// scanFolder() has always sorted; the U34 "open a dropped FOLDER" path added in
// Wave 0 called fs.readdirSync directly and used the result as-is, so a folder
// of a1/a10/a2/b played in NTFS order. These cover the expansion path itself,
// not just the comparator.

test('expandDirectory sorts a folder the way Explorer does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-expand-'))
  try {
    // Written in an order that is neither sorted nor reverse-sorted, so a
    // pass-through implementation cannot accidentally look correct.
    for (const n of ['a10.mkv', 'b.mkv', 'a1.mkv', 'a2.mkv', 'notes.txt', 'a.srt']) {
      fs.writeFileSync(path.join(dir, n), '')
    }
    assert.deepEqual(
      expandDirectory(dir).map((p) => path.basename(p)),
      ['a1.mkv', 'a2.mkv', 'a10.mkv', 'b.mkv']
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('expandDirectory keeps episode numbering in broadcast order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-expand-ep-'))
  try {
    for (const n of ['ep10.mkv', 'ep2.mkv', 'ep1.mkv', 'ep100.mkv', 'ep20.mkv']) {
      fs.writeFileSync(path.join(dir, n), '')
    }
    assert.deepEqual(
      expandDirectory(dir).map((p) => path.basename(p)),
      ['ep1.mkv', 'ep2.mkv', 'ep10.mkv', 'ep20.mkv', 'ep100.mkv']
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('expandDirectory returns nothing for an unreadable path rather than throwing', () => {
  assert.deepEqual(expandDirectory(path.join(os.tmpdir(), 'rl-does-not-exist-9f3a')), [])
})

const V = (name: string): string => path.join('C:', 'v', name)
const IN = (dir: string, name: string): string => path.join('C:', dir, name)

test('sortPaths orders a multi-select the way Explorer does', () => {
  // Selection order, i.e. whatever the user ctrl-clicked in.
  const picked = [V('a10.mkv'), V('b.mkv'), V('a1.mkv'), V('a2.mkv')]
  assert.deepEqual(sortPaths(picked), [V('a1.mkv'), V('a2.mkv'), V('a10.mkv'), V('b.mkv')])
})

test('sortPaths groups by folder before it compares names', () => {
  const picked = [IN('b', '1.mkv'), IN('a', '2.mkv'), IN('a', '10.mkv'), IN('b', '2.mkv')]
  assert.deepEqual(sortPaths(picked), [
    IN('a', '2.mkv'),
    IN('a', '10.mkv'),
    IN('b', '1.mkv'),
    IN('b', '2.mkv')
  ])
})

test('sortPaths does not mutate its argument', () => {
  const picked = [V('b.mkv'), V('a.mkv')]
  const copy = [...picked]
  sortPaths(picked)
  assert.deepEqual(picked, copy)
})
