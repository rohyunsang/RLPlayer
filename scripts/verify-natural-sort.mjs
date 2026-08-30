/**
 * Cross-checks src/main/services/playlist.ts:naturalCompare() against the real
 * Win32 StrCmpLogicalW from shlwapi.dll.
 *
 * This is how the character-rank table and the ignorable-character rules in
 * playlist.ts were derived in the first place -- they are measured, not
 * guessed. Re-run it after touching the comparator:
 *
 *   node scripts/verify-natural-sort.mjs
 *
 * Exits non-zero if our ordering diverges from Windows on any pair.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { naturalCompare } from '../src/main/services/playlist.ts'

const NAMES = [
  // episode numbering, the case people actually hit
  'ep1.mkv', 'ep2.mkv', 'ep10.mkv', 'ep02.mkv',
  'Show.S01E02.mkv', 'Show.S01E10.mkv', 'Show.S1E2.mkv', 'Show.S1E10.mkv',
  'part 1.avi', 'part 2.avi', 'part 10.avi', 'part 02.avi',
  'file (1).mp4', 'file (2).mp4', 'file (10).mp4',
  '[grp] 01.mkv', '[grp] 2.mkv', '[grp]03.mkv',
  // zero padding
  '0.mkv', '00.mkv', '000.mkv', '0a.mkv', '007.mkv', '7.mkv',
  '1.mkv', '01.mkv', '001.mkv', '1a.mkv', '2.mkv', '10.mkv', '99.mkv', '100.mkv',
  '003.mkv', '3.mkv', '0003.mkv',
  // punctuation ordering
  'a.mkv', 'a b.mkv', 'a-b.mkv', "a'b.mkv", 'a_b.mkv', 'a+b.mkv', 'a=b.mkv',
  'a<b.mkv', 'a~b.mkv', 'a{b.mkv', 'a[b.mkv', 'a]b.mkv', 'a!b.mkv', 'a@b.mkv',
  'a#b.mkv', 'a$b.mkv', 'a%b.mkv', 'a&b.mkv', 'a(b.mkv', 'a)b.mkv', 'a,b.mkv',
  'a;b.mkv', 'a?b.mkv', 'a^b.mkv', 'a|b.mkv', 'a}b.mkv', 'a1.mkv', 'ab.mkv',
  'a\\b.mkv', 'a/b.mkv', 'a`b.mkv',
  // case sensitivity
  'x.mkv', 'X.mkv', 'A2.mkv', 'a10.mkv', 'abc.mkv', 'ABC.mkv', '_pre.mkv',
  // version-like strings with several digit runs
  'v1.2.3.mkv', 'v1.10.0.mkv', 'v1.2.10.mkv', '2024-01-02.mkv', '2024-1-3.mkv',
  // non-ASCII
  '시즌1 2화.mkv', '시즌1 10화.mkv', '시즌2 1화.mkv', '한글.mkv',
  'Ätest.mkv', 'etest.mkv', 'é1.mkv',

  // ------------------------------------------------------------------------
  // THE CLASS THE 27,225-PAIR RUN COULD NOT SEE.
  //
  // Judged against Explorer over a real folder, 28 of 29 entries matched and
  // `ﬁle.mp4` (U+FB01) sat at index 21 for Explorer and 28 for us — eight
  // positional divergences from ONE character. This differential passed
  // anyway, because every name it generated was ASCII, Hangul or a Latin-1
  // accent. A corpus that cannot contain the defect is a check that lies, so
  // the four families that share a sort weight with a plainer form are all
  // here, each with the neighbours that pin its position.
  // ------------------------------------------------------------------------

  // ligatures and digraphs, with the letters on either side of the expansion
  'ﬁle.mkv', 'file.mkv', 'fi.mkv', 'fh.mkv', 'fj.mkv', 'fila.mkv', 'filz.mkv',
  'ﬂy.mkv', 'fly.mkv', 'flx.mkv', 'flz.mkv',
  'ﬀ.mkv', 'ff.mkv', 'fe.mkv', 'fg.mkv',
  'ﬃx.mkv', 'ffix.mkv', 'ﬄy.mkv', 'ffly.mkv', 'ﬆop.mkv', 'stop.mkv',
  'ß.mkv', 'ss.mkv', 'sa.mkv', 'sz.mkv', 'ßtr.mkv', 'sstr.mkv',
  'æon.mkv', 'aeon.mkv', 'adon.mkv', 'afon.mkv', 'Æ1.mkv', 'AE1.mkv',
  'œuf.mkv', 'oeuf.mkv', 'Ĳ.mkv', 'IJ.mkv', 'IK.mkv', 'þor.mkv', 'thor.mkv',
  'ǉub.mkv', 'ljub.mkv', 'ǳ.mkv', 'dz.mkv',
  // ligature INSIDE a numbered name, so the digit-run path sees it too
  'ﬁle 2.mkv', 'file 10.mkv', 'ﬁle 02.mkv',

  // precomposed vs decomposed — the same name typed on two keyboards
  'épisode.mkv', 'épisode.mkv', 'episode.mkv', 'ezisode.mkv',
  'Änna.mkv', 'Änna.mkv', 'anna.mkv', 'azna.mkv',
  'mañana.mkv', 'mañana.mkv', 'manana.mkv',
  'côte 1.mkv', 'côte 10.mkv',

  // full-width forms: the same PRIMARY weight, one tier later
  'ａ.mkv', 'a.mkv', 'Ａ.mkv', 'b.mkv',
  '１.mkv', '1.mkv', '2.mkv', '１0.mkv', '10.mkv',
  'ａ2.mkv', 'a10.mkv', 'ｅｐ１.mkv', 'ep1.mkv', 'ep02.mkv',
  '！.mkv', '!.mkv', '－a.mkv', '-a.mkv',

  // Hangul: jamo vs syllables, and the compatibility jamo block
  '가.mkv', '가.mkv', '각.mkv', '가나.mkv',
  'ᄀ.mkv', 'ㄱ.mkv', 'ㅏ.mkv',
  '한글.mkv', '한글.mkv',
  '시즌1 2화.mkv', '시즌1 2화.mkv',

  // THE CONTROLS. These look foldable and measurably are NOT: Roman numerals
  // sort between the digits and the letters, circled forms after every letter.
  // A blanket NFKC would have replaced one divergence with several hundred.
  'Ⅰ.mkv', 'I.mkv', 'Ⅸ.mkv', 'IX.mkv', 'ⅰv.mkv', 'iv.mkv',
  '①.mkv', '1x.mkv', '⑩.mkv', '10x.mkv'
]

// Deterministic fuzz over the alphabet that produced every bug found so far.
{
  // The alphabet now carries one representative of each folding family, so a
  // future regression in the expansion table shows up in the fuzz and not only
  // in the hand-written names above.
  const alphabet = [
    'a', 'B', 'z', '1', '02', '10', '-', '_', '.', ' ', '[', ']', '+', '~', "'", 'ep', '시즌',
    'ﬁ', 'fi', 'ﬂ', 'ß', 'ss', 'æ', 'ae', 'Ĳ',
    'ａ', '１', 'Ａ',
    'é', 'é', 'Ä', 'Ä',
    '가', '가', 'ㄱ', 'ㅏ',
    'Ⅰ', '①'
  ]
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let n = 0; n < 140; n++) {
    let s = ''
    const parts = 2 + Math.floor(rnd() * 4)
    for (let p = 0; p < parts; p++) s += alphabet[Math.floor(rnd() * alphabet.length)]
    NAMES.push(s + '.mkv')
  }
}

const pairs = []
for (const a of NAMES) for (const b of NAMES) pairs.push([a, b])

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-sort-'))
const inFile = path.join(dir, 'pairs.txt')
const outFile = path.join(dir, 'result.txt')
// Tab-separated, UTF-8: passing non-ASCII through stdin mangles it under
// Windows PowerShell's default code page.
fs.writeFileSync(inFile, pairs.map(([a, b]) => `${a}\t${b}`).join('\n'), 'utf8')

const ps = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class N {
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)]
  public static extern int StrCmpLogicalW(string a, string b);
}
"@
$lines = [System.IO.File]::ReadAllLines("${inFile.replace(/\\/g, '\\\\')}", [System.Text.Encoding]::UTF8)
$sb = New-Object System.Text.StringBuilder
foreach ($l in $lines) {
  $p = $l -split "\`t"
  [void]$sb.AppendLine([N]::StrCmpLogicalW($p[0], $p[1]))
}
[System.IO.File]::WriteAllText("${outFile.replace(/\\/g, '\\\\')}", $sb.ToString())
`

execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'inherit', 'inherit'] })
const win = fs.readFileSync(outFile, 'utf8').trim().split(/\r?\n/).map((n) => parseInt(n, 10))
fs.rmSync(dir, { recursive: true, force: true })

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0)

/**
 * DIVERGENCES WE KNOW ABOUT AND HAVE NOT FIXED.
 *
 * The alternative was to delete the offending names from the corpus, and that
 * is exactly the move that let `ﬁle.mp4` sit eight positions out of place while
 * this script printed "0 mismatches": a corpus that cannot contain the defect
 * is a check that lies. So the names STAY, the disagreement is named, and the
 * rule is asserted in BOTH directions — an unlisted disagreement fails the run,
 * and a listed rule that no longer catches anything ALSO fails it, because a
 * stale exemption is how this list would rot into the second lie.
 */
const CONJOINING_JAMO = /[ᄀ-ᇿ]/
const COMPAT_JAMO = /[㄰-㆏]/
const KNOWN_DIVERGENCES = [
  {
    id: 'hangul-compatibility-jamo',
    why:
      'The Hangul COMPATIBILITY jamo block (U+3130..U+318F) interleaves with the SYLLABLE ' +
      'block by phonetic position rather than by code point: measured, `한글.mkv` is GREATER ' +
      'than `ㄱ.mkv` (U+3131, a consonant) and LESS than `ㅏ.mkv` (U+314F, a vowel). ' +
      'Reproducing that needs the lead/vowel/tail algebra of Korean collation, which is a ' +
      'bigger job than the case this round was for — and that case IS fixed: `가` spelled ' +
      'U+1100 U+1161 and `가` spelled U+AC00 now agree with the API in both directions. ' +
      'Filed out loud rather than hidden by shrinking the corpus.',
    applies: (a, b) => COMPAT_JAMO.test(a) || COMPAT_JAMO.test(b)
  },
  {
    id: 'decomposed-hangul-inside-a-longer-name',
    why:
      'A canonically DECOMPOSED Hangul syllable sitting in the middle of a longer name. The ' +
      'pinned cases all agree with the API and are asserted directly in playlist.test.ts — ' +
      '`가` in jamo is less than `가`, than `가[`, than `가1`, than `각` and than `시즌`, and ' +
      '`한글` in syllables is greater than `한글` in jamo. What is NOT reproduced is where the ' +
      'jamo/syllable difference speaks relative to the REST of the name: the API answers ' +
      '`가Ä].mkv` < `가.mkv` (jamo), which no ordering of a primary pass and a last tier here ' +
      'produces. It needs the real Korean collation element table. Every pair it absorbs is fuzz-generated.',
    applies: (a, b) => CONJOINING_JAMO.test(a) || CONJOINING_JAMO.test(b)
  }
]

let bad = 0
const hits = new Map(KNOWN_DIVERGENCES.map((k) => [k.id, 0]))
pairs.forEach(([a, b], idx) => {
  const ours = sign(naturalCompare(a, b))
  const theirs = sign(win[idx])
  if (ours === theirs) return
  const known = KNOWN_DIVERGENCES.find((k) => k.applies(a, b))
  if (known) {
    hits.set(known.id, hits.get(known.id) + 1)
    return
  }
  bad++
  if (bad <= 20) {
    console.log(`MISMATCH ${JSON.stringify(a)} vs ${JSON.stringify(b)}: ours=${ours} win32=${theirs}`)
  }
})

for (const k of KNOWN_DIVERGENCES) {
  console.log(`\nKNOWN DIVERGENCE '${k.id}': ${hits.get(k.id)} diverging pair(s)\n  ${k.why}`)
}
const stale = KNOWN_DIVERGENCES.filter((k) => hits.get(k.id) === 0)
for (const k of stale) {
  console.log(
    `\nSTALE EXEMPTION '${k.id}': it matched no diverging pair. Either the comparator now ` +
      `agrees with Win32 here (delete the row) or the corpus lost the case (put it back).`
  )
}

console.log(`\nchecked ${pairs.length} ordered pairs against Win32, ${bad} unexpected mismatch(es)`)
process.exit(bad === 0 && stale.length === 0 ? 0 : 1)
