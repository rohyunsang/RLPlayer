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
  'Ätest.mkv', 'etest.mkv', 'é1.mkv'
]

// Deterministic fuzz over the alphabet that produced every bug found so far.
{
  const alphabet = ['a', 'B', 'z', '1', '02', '10', '-', '_', '.', ' ', '[', ']', '+', '~', "'", 'ep', '시즌']
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let n = 0; n < 80; n++) {
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
let bad = 0
pairs.forEach(([a, b], idx) => {
  if (sign(naturalCompare(a, b)) === sign(win[idx])) return
  bad++
  if (bad <= 20) {
    console.log(
      `MISMATCH ${JSON.stringify(a)} vs ${JSON.stringify(b)}: ` +
        `ours=${sign(naturalCompare(a, b))} win32=${sign(win[idx])}`
    )
  }
})

console.log(`\nchecked ${pairs.length} ordered pairs against Win32, ${bad} mismatches`)
process.exit(bad === 0 ? 0 : 1)
