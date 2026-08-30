import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheKey,
  countDuplicateTimestamps,
  isConvertibleExtension,
  planConversion
} from './convert.ts'
import type { ConvertOptions } from './convert.ts'
import { parseSmi } from './smi.ts'
import { parseAssCues, parseSrtCues } from './serialise.ts'
import {
  brokenHeaderSmi,
  cp949,
  multiLanguageSmi,
  singleLanguageSmi,
  ttmlDocument,
  utf8,
  HELLO_KO
} from './fixtures.ts'

/**
 * SM-F, the spec's acceptance test for this module (§7.13, §7.14):
 *
 *   "the multi-language SMI yields TWO selectable tracks and the Korean line is
 *    visible; the malformed copy loads instead of silently rendering nothing;
 *    forcing +cp1252 produces mojibake and switching back fixes it"
 *
 * Everything here asserts the CONTENT of what would be handed to mpv, parsed
 * back with this module's own reader, rather than that a conversion happened.
 * "A conversion happened" is satisfied by a conversion that drops the Korean
 * line, which is the exact bug the module exists to fix.
 */

const OPTS: ConvertOptions = {
  forcedDecoder: null,
  rubyMode: 'drop',
  useSubtitleStyle: false,
  preferredLangs: ['ko', 'en']
}

test('only the extensions we can actually convert are claimed', () => {
  for (const f of ['a.smi', 'A.SAMI', 'x.ttml', 'x.dfxp', 'x.xml']) {
    assert.equal(isConvertibleExtension(f), true, f)
  }
  for (const f of ['a.srt', 'a.ass', 'a.vtt', 'a.sup', 'a.mkv']) {
    assert.equal(isConvertibleExtension(f), false, f)
  }
})

// ---------------------------------------------------------------------------
// S02 vs S03: convert only what mpv gets WRONG
// ---------------------------------------------------------------------------

/**
 * THE FALSE POSITIVE THIS TEST EXISTS FOR, and it fails on the previous
 * implementation. `countDuplicateTimestamps` counted EVERY event that shared a
 * timestamp with an earlier one, `&nbsp;` clear events included — and the shape
 *
 *     <SYNC Start=3000><P Class=KRCC>&nbsp;
 *     <SYNC Start=3000><P Class=KRCC>두 번째
 *
 * (clear the previous line and start the next one at the same instant) is in
 * more or less every real Korean `.smi`. Measured on the single-language
 * fixture, which S02 records as WORKING NATIVELY on the pinned binary:
 *
 *     countDuplicateTimestamps  ->  1        (before)
 *     planConversion().kind     ->  'split'  (before)
 *     planConversion().kind     ->  'none'   (after)
 *
 * So the module's headline safety rule — "convert only what mpv gets wrong" —
 * was inverted for the commonest file in the target market: every ordinary
 * Korean subtitle got a cache file and a SECOND track in the track list, and
 * the user picked between two identical-looking Korean tracks on every file.
 * FFmpeg giving a clear event duration 0 loses nothing: the clear is there to
 * end the previous cue, and the cue that follows it at the same PTS ends it
 * anyway.
 */
test('a clear event sharing a timestamp is not a defect', () => {
  const doc = parseSmi(singleLanguageSmi())
  assert.ok(
    doc.events.some((e) => e.clear),
    'the fixture lost its clear events, so this test is vacuous'
  )
  assert.equal(countDuplicateTimestamps(doc), 0)

  const plan = planConversion(cp949(singleLanguageSmi()), 'C:/v/Movie.ko.smi', OPTS)
  assert.equal(plan.kind, 'none')
  assert.equal(plan.reasonKey, 'subs-formats.reason.native')
  assert.deepEqual(plan.outputs, [])
  assert.equal(plan.encoding, 'euc-kr')
  assert.equal(plan.diagnostics.probeScore, 100)
})

test('two renderable events at one timestamp ARE a defect', () => {
  const doc = parseSmi(multiLanguageSmi())
  assert.equal(countDuplicateTimestamps(doc), 2)
})

// ---------------------------------------------------------------------------
// S03 — the split
// ---------------------------------------------------------------------------

test('SM-F: the multi-language SMI yields two tracks and Korean survives', () => {
  const plan = planConversion(cp949(multiLanguageSmi()), 'C:/v/korean.smi', OPTS)
  assert.equal(plan.kind, 'split')
  assert.equal(plan.encoding, 'euc-kr')
  assert.equal(plan.outputs.length, 2)

  const ko = plan.outputs.find((o) => o.className === 'KRCC')
  const en = plan.outputs.find((o) => o.className === 'ENCC')
  assert.ok(ko && en)
  assert.equal(ko.lang, 'ko')
  assert.equal(en.lang, 'en')
  assert.equal(ko.title, '한국어 (KRCC)')
  assert.equal(en.title, 'English (ENCC)')
  assert.equal(ko.preferred, true, 'ko is first in preferredLangs and must be the selected one')
  assert.equal(en.preferred, false)
  assert.ok(ko.fileName.endsWith('.ass') && ko.fileName.includes('.ko.'))

  // …and the Korean line is REALLY THERE, with a duration FFmpeg would have
  // given it zero of.
  const cues = parseAssCues(ko.text)
  assert.equal(cues.length, 2)
  assert.equal(cues[0]?.text, `${HELLO_KO} 여러분`)
  assert.deepEqual(
    cues.map((c) => [c.startMs, c.endMs]),
    [
      [500, 4000],
      [6000, 9000]
    ]
  )
  assert.equal(parseAssCues(en.text)[0]?.text, 'Hello everyone')
})

test('the split output is a valid ASS script with one style and no ruby leak', () => {
  const plan = planConversion(cp949(multiLanguageSmi()), 'C:/v/korean.smi', OPTS)
  const text = plan.outputs[0]?.text ?? ''
  assert.match(text, /^\[Script Info\]/)
  assert.match(text, /ScriptType: v4\.00\+/)
  assert.match(text, /\[V4\+ Styles\]\r\nFormat: Name, Fontname/)
  assert.match(text, /\[Events\]\r\nFormat: Layer, Start, End/)
  // One style, and no Ruby style at all in 'drop' mode.
  assert.equal((text.match(/^Style: /gm) ?? []).length, 1)
  assert.ok(!text.includes('Style: Ruby'))
  // A `Dialogue:` line must never contain a raw newline.
  for (const line of text.split('\r\n')) {
    if (line.startsWith('Dialogue:')) assert.ok(!line.includes('\n'))
  }
})

test('ruby modes are all three honest about what they do', () => {
  const smi = [
    '<SAMI>',
    '<BODY>',
    '<SYNC Start=100><P Class=KRCC><ruby>漢字<rt>한자</rt></ruby>입니다',
    '<SYNC Start=100><P Class=ENCC>Chinese characters',
    '<SYNC Start=2000><P Class=KRCC>&nbsp;',
    '</BODY>'
  ].join('\r\n')
  const of = (rubyMode: 'drop' | 'inline' | 'above'): string => {
    const plan = planConversion(utf8(smi), 'C:/v/r.smi', { ...OPTS, rubyMode })
    return plan.outputs.find((o) => o.className === 'KRCC')?.text ?? ''
  }
  const drop = parseAssCues(of('drop'))
  assert.equal(drop.length, 1)
  assert.equal(drop[0]?.text, '漢字입니다')

  const inline = parseAssCues(of('inline'))
  assert.equal(inline[0]?.text, '漢字입니다(한자)')

  const above = of('above')
  assert.ok(above.includes('Style: Ruby'))
  const events = parseAssCues(above)
  assert.equal(events.length, 2, 'above mode emits the base line and a second event')
  assert.deepEqual(
    events.map((e) => e.text),
    ['漢字입니다', '한자']
  )
})

test('S06 styling is off unless asked for, and then it reaches the style line', () => {
  const plain = planConversion(cp949(multiLanguageSmi()), 'C:/v/k.smi', OPTS)
  const plainStyle = (plain.outputs.find((o) => o.className === 'ENCC')?.text ?? '')
    .split('\r\n')
    .find((l) => l.startsWith('Style: '))
  assert.ok(plainStyle?.includes('&H00FFFFFF'), 'unstyled output must be plain white')

  const styled = planConversion(cp949(multiLanguageSmi()), 'C:/v/k.smi', {
    ...OPTS,
    useSubtitleStyle: true
  })
  const line = (styled.outputs.find((o) => o.className === 'ENCC')?.text ?? '')
    .split('\r\n')
    .find((l) => l.startsWith('Style: '))
  assert.ok(line, 'no style line at all')
  const fields = line.split(',')
  assert.equal(fields[1], 'Arial', 'font-family from the P rule')
  assert.equal(fields[3], '&H0000FFFF', 'the ENCC yellow, in BGR with opaque alpha')
})

// ---------------------------------------------------------------------------
// S04 — the malformed header
// ---------------------------------------------------------------------------

test('SM-F: the malformed copy is repaired rather than silently silent', () => {
  for (let i = 0; i < 3; i++) {
    const plan = planConversion(cp949(brokenHeaderSmi(i)), 'C:/v/korean-broken.smi', OPTS)
    assert.equal(plan.kind, 'repair', `broken header ${i}`)
    assert.equal(plan.diagnostics.probeScore, 0)
    assert.equal(plan.outputs.length, 1)
    const out = plan.outputs[0]
    assert.ok(out)
    // Handed back as `.smi`, NOT as ASS: the body is fine, so let mpv's own
    // samidec and uchardet do their job. Rewriting a working body into ASS
    // would throw away libass's SAMI handling for no gain.
    assert.ok(out.fileName.endsWith('.smi'), out.fileName)
    assert.equal(out.text.startsWith('<SAMI>'), true)
    assert.equal(out.preferred, true)
    // The repaired copy still probes, still parses, and still says 안녕하세요.
    assert.ok(out.text.includes(HELLO_KO))
    // …and the repaired text is written out as UTF-8 by the caller, so a
    // re-read of it must not need a codepage at all.
    const again = planConversion(utf8(out.text), 'C:/v/repaired.smi', OPTS)
    assert.equal(again.kind, 'none')
  }
})

test('a broken header AND two languages goes to split, not repair', () => {
  const plan = planConversion(
    cp949('\r\n\r\n' + multiLanguageSmi('<sami>')),
    'C:/v/korean-broken.smi',
    OPTS
  )
  assert.equal(plan.kind, 'split')
  assert.equal(plan.outputs.length, 2)
  assert.equal(parseAssCues(plan.outputs[0]?.text ?? '')[0]?.text, `${HELLO_KO} 여러분`)
})

// ---------------------------------------------------------------------------
// S34 — the forced codepage, both ways
// ---------------------------------------------------------------------------

test('SM-F: forcing cp1252 produces mojibake and going back to auto fixes it', () => {
  const bytes = cp949(multiLanguageSmi())
  const wrong = planConversion(bytes, 'C:/v/korean.smi', {
    ...OPTS,
    forcedDecoder: 'windows-1252'
  })
  const wrongText = parseAssCues(wrong.outputs[0]?.text ?? '')[0]?.text ?? ''
  assert.equal(wrong.encoding, 'windows-1252')
  assert.ok(wrongText.length > 0)
  assert.ok(!wrongText.includes(HELLO_KO), 'forcing cp1252 must NOT still render Korean')
  assert.match(wrongText, /[¾È³ç]/, 'the classic CP949-as-latin1 mojibake')

  const right = planConversion(bytes, 'C:/v/korean.smi', OPTS)
  assert.equal(parseAssCues(right.outputs[0]?.text ?? '')[0]?.text, `${HELLO_KO} 여러분`)
  // And the two must not collide in the cache, or switching back would serve
  // the mojibake file from disk.
  assert.notEqual(cacheKey(bytes, OPTS), cacheKey(bytes, { ...OPTS, forcedDecoder: 'windows-1252' }))
})

test('the cache key changes with every option that changes the output', () => {
  const bytes = cp949(multiLanguageSmi())
  const base = cacheKey(bytes, OPTS)
  assert.equal(base.length, 16)
  assert.equal(cacheKey(bytes, OPTS), base, 'not deterministic')
  assert.notEqual(cacheKey(bytes, { ...OPTS, rubyMode: 'inline' }), base)
  assert.notEqual(cacheKey(bytes, { ...OPTS, useSubtitleStyle: true }), base)
  assert.notEqual(cacheKey(cp949(singleLanguageSmi()), OPTS), base)
})

// ---------------------------------------------------------------------------
// S07 — TTML
// ---------------------------------------------------------------------------

test('TTML becomes SRT, one track per xml:lang, with all three time forms', () => {
  const plan = planConversion(utf8(ttmlDocument()), 'C:/v/show.ttml', OPTS)
  assert.equal(plan.kind, 'ttml')
  assert.equal(plan.outputs.length, 2)
  const ko = plan.outputs.find((o) => o.lang === 'ko')
  assert.ok(ko)
  assert.equal(ko.preferred, true)
  assert.ok(ko.fileName.endsWith('.srt'))
  const cues = parseSrtCues(ko.text)
  assert.deepEqual(
    cues.map((c) => [c.startMs, c.endMs, c.text]),
    [
      [1000, 3500, HELLO_KO],
      [4000, 6000, '두\n번째'],
      [7000, 9000, '세 번째']
    ]
  )
})

test('an .xml that is not timed text is left alone', () => {
  const plan = planConversion(utf8('<?xml version="1.0"?><rss><channel/></rss>'), 'a.xml', OPTS)
  assert.equal(plan.kind, 'unsupported')
  assert.equal(plan.reasonKey, 'subs-formats.reason.notTtml')
})

test('an empty or textless SMI is unsupported, not an empty track', () => {
  const plan = planConversion(utf8('<SAMI>\r\n<BODY>\r\n</BODY>\r\n</SAMI>'), 'e.smi', OPTS)
  assert.equal(plan.kind, 'unsupported')
  assert.equal(plan.reasonKey, 'subs-formats.reason.empty')
  assert.deepEqual(plan.outputs, [])
})

test('every reasonKey the planner can emit is in this module namespace', () => {
  const plans = [
    planConversion(cp949(singleLanguageSmi()), 'a.smi', OPTS),
    planConversion(cp949(multiLanguageSmi()), 'a.smi', OPTS),
    planConversion(cp949(brokenHeaderSmi(0)), 'a.smi', OPTS),
    planConversion(utf8(ttmlDocument()), 'a.ttml', OPTS),
    planConversion(utf8('nope'), 'a.mkv', OPTS)
  ]
  for (const p of plans) {
    assert.match(p.reasonKey, /^subs-formats\./, p.reasonKey)
  }
})
