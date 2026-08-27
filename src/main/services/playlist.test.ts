import test from 'node:test'
import assert from 'node:assert/strict'
import { naturalCompare, isMediaFile, shuffleOrder } from './playlist.ts'

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
