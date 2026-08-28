import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bakeTime,
  decodeSubtitle,
  detectBom,
  formatAssTime,
  formatSrtTime,
  looksLikeUtf8,
  scoreEncoding,
  stripBom
} from './text.ts'
import { CODEPAGES, DEFAULT_CODEPAGE, codepageEntry, decoderFor } from './codepages.ts'
import { cp949, utf8, HELLO_KO, HELLO_KO_CP949, singleLanguageSmi } from './fixtures.ts'

/** U+FEFF as an escape: a literal BOM in tracked source fails check:control-chars. */
const BOM = '\uFEFF'

/**
 * S33/S34 — encoding, which for this product is the feature.
 *
 * The one thing these tests must not do is confirm our own encoder against our
 * own decoder and call that evidence, so the CP949 byte sequence for 안녕하세요 is
 * written out literally and checked against the platform's own `TextDecoder`
 * index. Everything else hangs off that.
 */

test('the fixture really is CP949 and not UTF-8 wearing a hat', () => {
  assert.deepEqual([...cp949(HELLO_KO)], [...HELLO_KO_CP949])
  assert.equal(new TextDecoder('euc-kr').decode(HELLO_KO_CP949), HELLO_KO)
  assert.equal(looksLikeUtf8(HELLO_KO_CP949), false)
  assert.equal(looksLikeUtf8(utf8(HELLO_KO)), true)
})

test("`cp949` is not a TextDecoder label — that is why codepages.ts has two columns", () => {
  // Measured under this Node: `new TextDecoder('cp949')` THROWS. A single
  // reused string would have made every forced-CP949 conversion fall through to
  // detection, silently, on the most important row in the module.
  assert.throws(() => new TextDecoder('cp949'))
  assert.equal(decoderFor('+cp949'), 'euc-kr')
  assert.equal(decoderFor('+euc-kr'), 'euc-kr')
  assert.equal(decoderFor('auto'), null)
  for (const c of CODEPAGES) {
    if (c.decoder === null) continue
    assert.doesNotThrow(
      () => new TextDecoder(c.decoder as string),
      `${c.mpv} maps to an unusable TextDecoder label '${c.decoder}'`
    )
  }
})

test('every codepage value carries the force prefix except auto', () => {
  assert.equal(DEFAULT_CODEPAGE, 'auto')
  for (const c of CODEPAGES) {
    if (c.mpv === 'auto') continue
    assert.ok(
      c.mpv.startsWith('+'),
      `${c.mpv} has no '+', so mpv short-circuits to UTF-8 whenever the bytes ` +
        `happen to validate — which every ASCII-only subtitle does`
    )
    assert.ok(c.labelKey.startsWith('subs-formats.'), `${c.labelKey} is out of namespace`)
  }
  assert.equal(codepageEntry('+cp949')?.decoder, 'euc-kr')
  assert.equal(codepageEntry('nonsense'), undefined)
})

test('detection picks CP949 for a Korean SMI with no BOM', () => {
  const r = decodeSubtitle(cp949(singleLanguageSmi()), null)
  assert.equal(r.encoding, 'euc-kr')
  assert.equal(r.forced, false)
  assert.ok(r.text.includes(HELLO_KO), 'the Korean text did not survive detection')
})

test('a Hangul mis-decode scores below the right answer', () => {
  const bytes = cp949(HELLO_KO.repeat(20))
  const right = scoreEncoding(bytes, 'euc-kr')
  for (const wrong of ['gb18030', 'big5', 'shift_jis', 'windows-1252']) {
    assert.ok(
      right > scoreEncoding(bytes, wrong),
      `${wrong} scored ${scoreEncoding(bytes, wrong)} against euc-kr's ${right}; ` +
        `CJK codepages accept most CP949 byte pairs without a replacement char, ` +
        `so 'fewest U+FFFD' is not a usable tiebreak`
    )
  }
})

test('BOM beats detection, and a forced label beats the BOM', () => {
  const bomUtf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(HELLO_KO)])
  assert.equal(detectBom(bomUtf8), 'utf-8')
  const auto = decodeSubtitle(bomUtf8, null)
  assert.equal(auto.encoding, 'utf-8')
  assert.equal(auto.bom, true)
  assert.equal(auto.text, HELLO_KO, 'the BOM was left in the text')
  // mpv's '+' prefix overrides everything including a BOM; ours must agree with
  // it or the same file decodes two ways in one product.
  const forced = decodeSubtitle(bomUtf8, 'euc-kr')
  assert.equal(forced.forced, true)
  assert.equal(forced.encoding, 'euc-kr')
  assert.notEqual(forced.text, HELLO_KO)
})

test('UTF-16 BOMs are recognised, and stripBom is idempotent', () => {
  assert.equal(detectBom(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'utf-16le')
  assert.equal(detectBom(new Uint8Array([0xfe, 0xff, 0x00, 0x41])), 'utf-16be')
  assert.equal(detectBom(new Uint8Array([0x41])), null)
  assert.equal(stripBom(`${BOM}x`), 'x')
  assert.equal(stripBom('x'), 'x')
})

test('a forced label that TextDecoder cannot build falls back to detection', () => {
  const r = decodeSubtitle(cp949(HELLO_KO), 'cp949')
  assert.equal(r.forced, false, 'an unusable label must not be reported as forced')
  assert.equal(r.encoding, 'euc-kr')
})

// ---------------------------------------------------------------------------
// Timestamps (S42)
// ---------------------------------------------------------------------------

test('bakeTime is t*speed + delay, clamped at zero', () => {
  assert.equal(bakeTime(10, 0, 1), 10)
  assert.equal(bakeTime(10, 1.5, 1), 11.5)
  assert.equal(bakeTime(10, 0, 2), 20)
  assert.equal(bakeTime(10, -2, 1), 8)
  // A negative result is not a subtitle before the file starts, it is a cue mpv
  // would never show; clamp rather than write a negative timestamp no parser
  // accepts.
  assert.equal(bakeTime(1, -5, 1), 0)
  // speed 0 would collapse the whole file onto frame 0.
  assert.equal(bakeTime(10, 0, 0), 10)
})

test('SRT and ASS clocks are formatted in their own shapes', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000')
  assert.equal(formatSrtTime(3661.5), '01:01:01,500')
  assert.equal(formatSrtTime(-1), '00:00:00,000')
  assert.equal(formatAssTime(0), '0:00:00.00')
  assert.equal(formatAssTime(3661.5), '1:01:01.50')
  // Centiseconds ROUND, they do not truncate, and the carry has to reach the
  // minute: 59.999 s is 1:00.00, not 0:59.100.
  assert.equal(formatAssTime(3661.504), '1:01:01.50')
  assert.equal(formatAssTime(3661.506), '1:01:01.51')
  assert.equal(formatAssTime(59.999), '0:01:00.00')
})
