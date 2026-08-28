import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cssColourToAss,
  cuesByClass,
  decodeEntities,
  extractRuby,
  langOfStyle,
  needsHeaderRepair,
  parseSmi,
  parseStyleBlock,
  repairHeader,
  smiProbeScore,
  smiTextToPlain
} from './smi.ts'
import { multiLanguageSmi, singleLanguageSmi, brokenHeaderSmi, HELLO_KO } from './fixtures.ts'

/** U+FEFF as an escape: a literal BOM in tracked source fails check:control-chars. */
const BOM = '\uFEFF'

/**
 * SMI parsing, asserted on RESULTS.
 *
 * The standing lesson of this project is that the valuable finding is a check
 * that lied, so every assertion here names the value it expects rather than the
 * call it expects. `smiProbeScore` is the sharpest case: it is this module's
 * MODEL of FFmpeg's `sami_probe`, and every decision the converter makes is
 * downstream of it, so a model that disagrees with the binary silently converts
 * files that work and passes through files that do not.
 */

// ---------------------------------------------------------------------------
// The probe (S04)
// ---------------------------------------------------------------------------

test('the probe matches FFmpeg: exact, case-sensitive, no leading whitespace', () => {
  assert.equal(smiProbeScore('<SAMI>\r\n<BODY>'), 100)
  assert.equal(smiProbeScore('<sami>\r\n<BODY>'), 0)
  assert.equal(smiProbeScore('\r\n\r\n<SAMI>'), 0)
  assert.equal(smiProbeScore('<SAMI >'), 0)
  assert.equal(smiProbeScore('<SAM'), 0)
})

/**
 * THE REGRESSION THIS TEST EXISTS FOR, and it fails on the previous
 * implementation — measured, not asserted from memory:
 *
 *   smiProbeScore('\uFEFF<SAMI>…')  ->  0     (before)
 *   smiProbeScore('\uFEFF<SAMI>…')  ->  100   (after)
 *
 * FFmpeg's `sami_probe()` reads its six bytes through an `FFTextReader`, which
 * skips a BOM and transcodes UTF-16 before the `strncmp` ever runs — this
 * module's own header comment says so ("so a BOM and UTF-16 are handled"). The
 * old one-liner compared the raw string, so it answered "FFmpeg cannot load
 * this" for a BOM-prefixed file.
 *
 * That is not academic: S42 requires our own exported `.smi` to be
 * **UTF-8 with a BOM** (otherwise Notepad and every Korean subtitle editor
 * opens it as CP949 and shows mojibake — the exact PotPlayer bug the row
 * quotes). So the model said the file this module WRITES is a file this module
 * cannot read, and `needsHeaderRepair` inherited it: a BOM'd, perfectly
 * well-formed export was routed into the S04 repair path and rewritten into the
 * cache for nothing, on every load, forever.
 */
test('a BOM does not defeat the probe, because FFTextReader skips it', () => {
  assert.equal(smiProbeScore(`${BOM}<SAMI>\r\n<BODY>`), 100)
  assert.equal(needsHeaderRepair(`${BOM}<SAMI>\r\n<BODY>`), false)
  // …and the broken shapes are still broken with a BOM in front of them.
  assert.equal(smiProbeScore(`${BOM}<sami>`), 0)
  assert.equal(needsHeaderRepair(`${BOM}<sami>`), true)
})

test('repairHeader fixes exactly the six bytes and nothing else', () => {
  for (let i = 0; i < 3; i++) {
    const broken = brokenHeaderSmi(i)
    assert.equal(smiProbeScore(broken), 0, `fixture ${i} should not probe`)
    assert.equal(needsHeaderRepair(broken), true)
    const fixed = repairHeader(broken)
    assert.equal(smiProbeScore(fixed), 100)
    // The body is the user's data. Same events, same text, same order.
    assert.deepEqual(
      parseSmi(fixed).events.map((e) => [e.startMs, e.text]),
      parseSmi(singleLanguageSmi()).events.map((e) => [e.startMs, e.text])
    )
  }
})

test('needsHeaderRepair says no to a file that is merely not SAMI', () => {
  assert.equal(needsHeaderRepair('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi'), false)
})

// ---------------------------------------------------------------------------
// Parsing (S03)
// ---------------------------------------------------------------------------

test('the multi-language fixture yields both classes, Korean first', () => {
  const doc = parseSmi(multiLanguageSmi())
  assert.deepEqual(doc.classes, ['KRCC', 'ENCC'])
  const first = doc.events[0]
  assert.equal(first?.className, 'KRCC')
  assert.equal(first?.startMs, 500)
  assert.equal(first?.text, `${HELLO_KO} 여러분`)
})

test('cuesByClass ends a cue with the next event OF ITS OWN CLASS', () => {
  const cues = cuesByClass(parseSmi(multiLanguageSmi()))
  const ko = cues.get('KRCC') ?? []
  const en = cues.get('ENCC') ?? []
  assert.equal(ko.length, 2)
  assert.equal(en.length, 2)
  // This is the whole point of the module: FFmpeg gives the FIRST of a
  // duplicate-PTS pair duration 0, and in Korean files that is the Korean line.
  // Here it is 3.5 s long.
  assert.deepEqual(
    ko.map((c) => [c.startMs, c.endMs]),
    [
      [500, 4000],
      [6000, 9000]
    ]
  )
  assert.equal(ko[1]?.text, '두 번째 줄\n계속')
  assert.equal(en[0]?.text, 'Hello everyone')
})

test('a &nbsp; paragraph ends a line and never becomes one', () => {
  const cues = cuesByClass(parseSmi(multiLanguageSmi())).get('KRCC') ?? []
  assert.ok(
    cues.every((c) => c.text.trim().length > 0),
    'a clear event leaked into the cue list'
  )
})

test('an ID=Source speaker label is dropped, not concatenated into the line', () => {
  const doc = parseSmi(
    ['<SAMI>', '<BODY>', '<SYNC Start=100><P ID=Source>홍길동<P Class=KRCC>대사', '</BODY>'].join(
      '\n'
    )
  )
  assert.deepEqual(
    doc.events.map((e) => e.text),
    ['대사']
  )
})

test('a SYNC with no <P> still produces an event', () => {
  const doc = parseSmi(['<SAMI>', '<BODY>', '<SYNC Start=250>bare text', '</BODY>'].join('\n'))
  assert.deepEqual(
    doc.events.map((e) => [e.startMs, e.className, e.text]),
    [[250, '', 'bare text']]
  )
})

test('the trailing cue gets a finite duration rather than none', () => {
  const cues =
    cuesByClass(
      parseSmi(['<SAMI>', '<BODY>', '<SYNC Start=1000><P Class=KRCC>끝', '</BODY>'].join('\n'))
    ).get('KRCC') ?? []
  assert.equal(cues.length, 1)
  assert.equal(cues[0]?.startMs, 1000)
  assert.equal(cues[0]?.endMs, 6000)
})

// ---------------------------------------------------------------------------
// Inline markup, entities, ruby (S05)
// ---------------------------------------------------------------------------

test('<br> becomes a line break and other markup disappears', () => {
  const { text } = smiTextToPlain('<font color=red>가</font><br>나<b>다</b>')
  assert.equal(text, '가\n나다')
})

test('entities decode, including numeric and hex', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&#44032;&#xAC01;'), '&<>가각')
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;')
})

test('ruby markup NEVER leaks into the visible line', () => {
  const r = extractRuby('<ruby>漢字<rt>한자</rt></ruby>입니다')
  assert.equal(r.base, '漢字입니다')
  assert.equal(r.ruby, '한자')
  const plain = smiTextToPlain('<ruby>漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby>')
  assert.equal(plain.text, '漢字')
  assert.equal(plain.ruby, '한자')
  assert.ok(!plain.text.includes('한자'), 'the reading ran into the base text')
})

// ---------------------------------------------------------------------------
// The CSS block (S06)
// ---------------------------------------------------------------------------

test('CSS colour becomes ASS &HAABBGGRR — BGR order, inverted alpha', () => {
  // Pure red is 0000FF in BGR, and 00 alpha is OPAQUE. Getting either backwards
  // gives blue text or invisible text, and both look like "the font is wrong".
  assert.equal(cssColourToAss('#ff0000'), '&H000000FF')
  assert.equal(cssColourToAss('#00ff00'), '&H0000FF00')
  assert.equal(cssColourToAss('#0000ff'), '&H00FF0000')
  assert.equal(cssColourToAss('yellow'), '&H0000FFFF')
  assert.equal(cssColourToAss('#fff'), '&H00FFFFFF')
  assert.equal(cssColourToAss('nonsense'), undefined)
})

test('the style block is read per class, and P is the document default', () => {
  const styles = parseStyleBlock(multiLanguageSmi())
  assert.equal(styles.get('')?.fontFamily, 'Arial')
  assert.equal(styles.get('')?.fontSize, 20)
  assert.equal(styles.get('')?.alignment, 2)
  assert.equal(styles.get('KRCC')?.name, '한국어')
  assert.equal(styles.get('KRCC')?.lang, 'ko-KR')
  assert.equal(styles.get('ENCC')?.primaryColour, '&H0000FFFF')
})

test('a class language comes from CSS, then from the class name', () => {
  const styles = parseStyleBlock(multiLanguageSmi())
  assert.equal(langOfStyle(styles.get('KRCC'), 'KRCC'), 'ko')
  assert.equal(langOfStyle(styles.get('ENCC'), 'ENCC'), 'en')
  assert.equal(langOfStyle(undefined, 'KRCC'), 'ko')
  assert.equal(langOfStyle(undefined, 'ENCC'), 'en')
  assert.equal(langOfStyle(undefined, 'JPCC'), 'ja')
  assert.equal(langOfStyle(undefined, 'WHAT'), 'und')
})
