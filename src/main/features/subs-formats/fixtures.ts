/**
 * SM-F, the spec's own acceptance fixture, as bytes.
 *
 * §7.13 names it: `korean.smi` + `korean-broken.smi` — "CP949, `<P Class=KRCC>`
 * **and** `<P Class=ENCC>` at identical `Start=`; the broken copy uses lowercase
 * `<sami>` and two leading blank lines", and calls it "**M18 — the highest-value
 * subtitle test**".
 *
 * WHY THE BYTES ARE BUILT HERE INSTEAD OF CHECKED IN. A `.smi` fixture is a
 * CP949 binary, and this repo's `check:control-chars` and every editor between
 * here and CI would be free to "fix" its encoding on the way past — at which
 * point the fixture for the CP949 bug is UTF-8 and every encoding test passes
 * for the wrong reason. Building the bytes in code makes the encoding an
 * assertion rather than a file property.
 *
 * The five syllables of 안녕하세요 were read out of `TextDecoder('euc-kr')` and
 * are asserted byte-for-byte in `text.test.ts`, so this file cannot drift into
 * agreeing with a broken encoder.
 *
 * Not test-only by accident: nothing in `index.ts` imports it, so it is not in
 * the bundle.
 */

import { encodeCp949 } from './serialise.ts'

/** 안녕하세요 in CP949: BE C8 B3 E7 C7 CF BC BC BF E4. */
export const HELLO_KO = '안녕하세요'
export const HELLO_KO_CP949 = Uint8Array.from([
  0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4
])

const CRLF = '\r\n'

/**
 * The multi-language body: KRCC and ENCC as SEPARATE `<SYNC>` elements at the
 * SAME `Start=`, which is the layout that loses the Korean line (S03).
 */
export function multiLanguageSmi(header = '<SAMI>'): string {
  return [
    header,
    '<HEAD>',
    '<TITLE>korean.smi</TITLE>',
    '<STYLE TYPE="text/css">',
    '<!--',
    'P { font-family:Arial; font-size:20pt; color:white; text-align:center; }',
    '.KRCC { Name:한국어; lang:ko-KR; SAMIType:CC; }',
    '.ENCC { Name:English; lang:en-US; SAMIType:CC; color:#ffff00; }',
    '-->',
    '</STYLE>',
    '</HEAD>',
    '<BODY>',
    `<SYNC Start=500><P Class=KRCC>${HELLO_KO} 여러분`,
    '<SYNC Start=500><P Class=ENCC>Hello everyone',
    '<SYNC Start=4000><P Class=KRCC>&nbsp;',
    '<SYNC Start=4000><P Class=ENCC>&nbsp;',
    '<SYNC Start=6000><P Class=KRCC>두 번째 줄<br>계속',
    '<SYNC Start=6000><P Class=ENCC>Second line<br>continued',
    '<SYNC Start=9000><P Class=KRCC>&nbsp;',
    '<SYNC Start=9000><P Class=ENCC>&nbsp;',
    '</BODY>',
    '</SAMI>'
  ].join(CRLF)
}

/**
 * A well-formed SINGLE-language file. S02: this one already works, so the
 * converter must leave it alone — `kind: 'none'`.
 *
 * The clear event and the next line share a timestamp on purpose. That shape is
 * everywhere in real Korean SMI and it is what made the first version of
 * `countDuplicateTimestamps` claim every ordinary file was broken.
 */
export function singleLanguageSmi(): string {
  return [
    '<SAMI>',
    '<HEAD>',
    '<STYLE TYPE="text/css">',
    '<!--',
    'P { font-family:굴림; font-size:20pt; color:white; }',
    '.KRCC { Name:한국어; lang:ko-KR; }',
    '-->',
    '</STYLE>',
    '</HEAD>',
    '<BODY>',
    `<SYNC Start=1000><P Class=KRCC>${HELLO_KO}`,
    '<SYNC Start=3000><P Class=KRCC>&nbsp;',
    '<SYNC Start=3000><P Class=KRCC>두 번째',
    '<SYNC Start=5000><P Class=KRCC>&nbsp;',
    '</BODY>',
    '</SAMI>'
  ].join(CRLF)
}

/** The three verified total-silence header shapes (S04). */
export const BROKEN_HEADERS: ReadonlyArray<{ name: string; header: string; prefix: string }> = [
  { name: 'lowercase', header: '<sami>', prefix: '' },
  { name: 'leading blank lines', header: '<SAMI>', prefix: '\r\n\r\n' },
  { name: 'space before >', header: '<SAMI >', prefix: '' }
]

/** A single-language file whose only defect is its first six bytes. */
export function brokenHeaderSmi(which: number): string {
  const shape = BROKEN_HEADERS[which]
  if (!shape) throw new Error(`no broken header ${which}`)
  return shape.prefix + singleLanguageSmi().replace('<SAMI>', shape.header)
}

/** Text -> CP949 bytes, the encoding every Korean rip actually ships. */
export function cp949(text: string): Uint8Array {
  const { bytes, unmappable } = encodeCp949(text)
  if (unmappable > 0) throw new Error(`fixture is not representable in CP949 (${unmappable})`)
  return bytes
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** A TTML sidecar exercising clock-time, offset-time and `ttp:tickRate` (S07). */
export function ttmlDocument(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ko" ttp:tickRate="1000">',
    '  <body>',
    '    <div xml:lang="ko">',
    `      <p begin="00:00:01.000" end="00:00:03.500">${HELLO_KO}</p>`,
    '      <p begin="4s" dur="2s">두<br/>번째</p>',
    '      <p begin="7000t" end="9000t">세 번째</p>',
    '    </div>',
    '    <div xml:lang="en">',
    '      <p begin="00:00:01.000" end="00:00:03.500">Hello</p>',
    '    </div>',
    '  </body>',
    '</tt>'
  ].join('\n')
}
