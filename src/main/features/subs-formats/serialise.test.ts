import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bakeCues,
  encodeCp949,
  isReadableForExport,
  parseAssCues,
  parseSrtCues,
  parseVttCues,
  readSubtitle,
  toSmi,
  toSrt,
  utf8WithBom
} from './serialise.ts'
import { planConversion } from './convert.ts'
import { needsHeaderRepair, smiProbeScore } from './smi.ts'
import { decodeSubtitle } from './text.ts'
import { cp949, multiLanguageSmi, singleLanguageSmi, utf8, HELLO_KO } from './fixtures.ts'

/**
 * S42 — save a subtitle with the sync baked in.
 *
 * mpv cannot write subtitle files, so the whole feature is parse + transform +
 * serialise and there is nothing to verify against the binary; what there IS to
 * verify is that a file we write is a file we (and FFmpeg) can read back. Every
 * writer here is therefore asserted through a reader, which is also the only way
 * a timestamp transform can be checked without restating it.
 */

test('the readable set is the formats a parser here actually handles', () => {
  for (const f of ['a.srt', 'a.vtt', 'a.ass', 'a.ssa', 'a.smi', 'A.SAMI']) {
    assert.equal(isReadableForExport(f), true, f)
  }
  for (const f of ['a.sup', 'a.idx', 'a.mkv', 'a.ttml']) {
    assert.equal(isReadableForExport(f), false, f)
  }
})

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

test('SRT: an index line is optional and a cue with no text is dropped', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    '첫 줄',
    '두 번째 줄',
    '',
    '00:00:03,000 --> 00:00:04,000',
    '<i>기울임</i>',
    '',
    '3',
    '00:00:05,000 --> 00:00:05,000',
    '길이 0',
    '',
    '4',
    '00:00:06,000 --> 00:00:07,000',
    ''
  ].join('\r\n')
  assert.deepEqual(
    parseSrtCues(srt).map((c) => [c.startMs, c.endMs, c.text]),
    [
      [1000, 2500, '첫 줄\n두 번째 줄'],
      [3000, 4000, '기울임']
    ]
  )
})

test('VTT: the header, NOTE blocks and dot separators are all handled', () => {
  const vtt = [
    'WEBVTT - something',
    '',
    'NOTE this is a comment',
    'that runs on',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:02.000',
    'hello',
    ''
  ].join('\n')
  assert.deepEqual(
    parseVttCues(vtt).map((c) => [c.startMs, c.endMs, c.text]),
    [[1000, 2000, 'hello']]
  )
})

test('ASS: override tags go, \\N becomes a break, commas in text survive', () => {
  const ass = [
    '[Script Info]',
    'Title: x',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Default,Arial,36,&H00FFFFFF',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}가, 나\\N다',
    'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,ignored'
  ].join('\r\n')
  assert.deepEqual(
    parseAssCues(ass).map((c) => [c.startMs, c.endMs, c.text]),
    [[1000, 2500, '가, 나\n다']]
  )
})

test('SMI export takes ONE class, chosen by preference, and reports the rest', () => {
  const text = multiLanguageSmi()
  const ko = readSubtitle(text, 'korean.smi', { preferredLangs: ['ko'] })
  assert.equal(ko.exportedClass, 'KRCC')
  assert.deepEqual(ko.classes, ['KRCC', 'ENCC'])
  assert.equal(ko.cues.length, 2)
  assert.equal(ko.cues[0]?.text, `${HELLO_KO} 여러분`)

  const en = readSubtitle(text, 'korean.smi', { preferredLangs: ['en'] })
  assert.equal(en.exportedClass, 'ENCC')
  assert.equal(en.cues[0]?.text, 'Hello everyone')

  // An explicit class beats the language preference.
  assert.equal(
    readSubtitle(text, 'korean.smi', { className: 'ENCC', preferredLangs: ['ko'] }).exportedClass,
    'ENCC'
  )
  // Merging the two would produce a file with both languages at every
  // timestamp, which is not a subtitle anybody asked for.
  assert.equal(ko.cues.length + en.cues.length, 4)
})

// ---------------------------------------------------------------------------
// bake (the one expression the feature rests on)
// ---------------------------------------------------------------------------

test('baking applies delay and speed and drops cues that collapse', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, text: 'a', ruby: '' },
    { startMs: 3000, endMs: 4000, text: 'b', ruby: '' }
  ]
  assert.deepEqual(
    bakeCues(cues, { delay: 1.5, speed: 1 }).map((c) => [c.startMs, c.endMs]),
    [
      [2500, 3500],
      [4500, 5500]
    ]
  )
  assert.deepEqual(
    bakeCues(cues, { delay: 0, speed: 2 }).map((c) => [c.startMs, c.endMs]),
    [
      [2000, 4000],
      [6000, 8000]
    ]
  )
  // A large negative delay clamps both ends to 0, which makes the cue
  // zero-length; it must be dropped, not written as 00:00:00 --> 00:00:00.
  assert.deepEqual(bakeCues(cues, { delay: -100, speed: 1 }), [])
})

// ---------------------------------------------------------------------------
// Writers, checked through the readers
// ---------------------------------------------------------------------------

test('SRT round-trips through its own parser with the sync baked in', () => {
  const source = readSubtitle(multiLanguageSmi(), 'k.smi', { preferredLangs: ['ko'] }).cues
  const srt = toSrt(bakeCues(source, { delay: 2, speed: 1 }))
  assert.match(srt, /\r\n$/)
  assert.deepEqual(
    parseSrtCues(srt).map((c) => [c.startMs, c.endMs, c.text]),
    [
      [2500, 6000, `${HELLO_KO} 여러분`],
      [8000, 11000, '두 번째 줄\n계속']
    ]
  )
})

test('an empty cue list is an empty file, not a stray blank line', () => {
  assert.equal(toSrt([]), '')
})

test('SMI export probes, parses and round-trips — WITH the BOM S42 requires', () => {
  const source = readSubtitle(multiLanguageSmi(), 'k.smi', { preferredLangs: ['ko'] }).cues
  const smi = toSmi(bakeCues(source, { delay: 0, speed: 1 }), 'KRCC', 'ko')
  const bytes = utf8WithBom(smi)
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])

  // The file we just wrote must be one mpv will load: decode it the way this
  // module decodes any subtitle, then probe it the way FFmpeg does.
  const decoded = decodeSubtitle(bytes, null)
  assert.equal(decoded.encoding, 'utf-8')
  assert.equal(decoded.bom, true)
  assert.equal(smiProbeScore(decoded.text), 100, 'our own export would not load')
  assert.equal(needsHeaderRepair(decoded.text), false, 'our own export needs repairing')

  // …and it round-trips: same cues, same text, one class.
  const back = readSubtitle(decoded.text, 'export.smi')
  assert.equal(back.exportedClass, 'KRCC')
  assert.deepEqual(
    back.cues.map((c) => [c.startMs, c.endMs, c.text]),
    source.map((c) => [c.startMs, c.endMs, c.text])
  )
  // A re-import of the export must not look like a file needing conversion.
  assert.equal(planConversion(bytes, 'export.smi', {
    forcedDecoder: null,
    rubyMode: 'drop',
    useSubtitleStyle: false,
    preferredLangs: ['ko']
  }).kind, 'none')
})

test('SMI export escapes markup so text cannot become tags', () => {
  const smi = toSmi([{ startMs: 0, endMs: 1000, text: '<b>&nbsp;</b>', ruby: '' }], 'KRCC', 'ko')
  assert.ok(smi.includes('&lt;b&gt;&amp;nbsp;&lt;/b&gt;'))
  const back = readSubtitle(smi, 'x.smi')
  assert.equal(back.cues[0]?.text, '<b>&nbsp;</b>')
})

// ---------------------------------------------------------------------------
// CP949 out (S42's "or CP949 on request")
// ---------------------------------------------------------------------------

test('the CP949 encoder is the decoder table, inverted', () => {
  const { bytes, unmappable } = encodeCp949(`ABC ${HELLO_KO}`)
  assert.equal(unmappable, 0)
  assert.equal(new TextDecoder('euc-kr').decode(bytes), `ABC ${HELLO_KO}`)
  assert.deepEqual([...bytes.slice(0, 4)], [0x41, 0x42, 0x43, 0x20])
})

test('what CP949 cannot represent is replaced AND counted, never silently lost', () => {
  // An emoji has no CP949 code point. A player that writes a damaged file and
  // says nothing is worse than one that says "12 characters could not be saved".
  const { bytes, unmappable } = encodeCp949('가😀나')
  assert.equal(unmappable, 1)
  assert.equal(new TextDecoder('euc-kr').decode(bytes), '가?나')
})

test('a CP949 export is read back by our own detector as CP949', () => {
  const smi = toSmi([{ startMs: 0, endMs: 1000, text: HELLO_KO, ruby: '' }], 'KRCC', 'ko')
  const r = decodeSubtitle(encodeCp949(smi).bytes, null)
  assert.equal(r.encoding, 'euc-kr')
  assert.equal(readSubtitle(r.text, 'x.smi').cues[0]?.text, HELLO_KO)
})

test('utf8WithBom is exactly a BOM plus the UTF-8 bytes', () => {
  const b = utf8WithBom('가')
  assert.deepEqual([...b], [0xef, 0xbb, 0xbf, ...utf8('가')])
})

test('a single-language CP949 SMI survives read → bake → write → read', () => {
  const original = readSubtitle(decodeSubtitle(cp949(singleLanguageSmi()), null).text, 'a.smi')
  assert.equal(original.cues.length, 2)
  const rewritten = readSubtitle(
    toSmi(bakeCues(original.cues, { delay: 0.5, speed: 1 }), 'KRCC', 'ko'),
    'b.smi'
  )
  assert.deepEqual(
    rewritten.cues.map((c) => c.startMs),
    original.cues.map((c) => c.startMs + 500)
  )
})
