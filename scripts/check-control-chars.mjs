#!/usr/bin/env node
/**
 * No control characters in tracked source. And no file git thinks is binary.
 *
 * THE BUG THIS EXISTS FOR. `src/renderer/src/features/audio-eq/index.ts` byte
 * 1527 was a raw NUL: `const CUSTOM = '\0custom'`. Git sniffs for a NUL in the
 * first 8000 bytes to decide text vs binary, and with no `.gitattributes` it
 * decided binary. So:
 *
 *   git diff              -> "Bin 0 -> 11349 bytes"
 *   git grep presetSelect -> "Binary file src/... matches"   (no line numbers)
 *
 * 326 lines of a shipped feature module landed with no reviewable diff, and the
 * one line that caused it was invisible to every tool a reviewer would reach
 * for. Nothing in `npm run verify` noticed: typecheck compiles a NUL inside a
 * string literal happily, and the whole 395-test suite passed.
 *
 * WHAT IT CHECKS, and why each half is here:
 *
 *   1. NO CONTROL CHARACTERS in a tracked text file. TAB (0x09), LF (0x0a) and
 *      CR (0x0d) are legal; every other C0 code point, DEL (0x7f), and the
 *      invisible Unicode troublemakers (BOM in the middle of a file, zero-width
 *      space/joiner, LTR/RTL overrides, NBSP) are not. The bidi overrides are on
 *      the list because of CVE-2021-42574 "Trojan Source": U+202E can make
 *      source read one way to a human and compile another.
 *   2. NO FILE GIT WILL TREAT AS BINARY. Rule 1 is the cause; this is the
 *      symptom, and asserting the symptom directly means a future encoding
 *      accident this script's character table does not know about still fails.
 *      `git check-attr` + a NUL scan answer the same question git's own differ
 *      asks.
 *   3. THE CHECK CAN SEE ITSELF (`--self-test`). A scanner that silently stops
 *      matching reports "clean" for every violation at once, which is the
 *      failure mode five audit rounds in this repo keep finding. The self-test
 *      writes a temp file containing the exact byte that shipped and asserts the
 *      scanner FAILS on it, then asserts it passes on the same file cleaned.
 *
 * Run: npm run check:control-chars   (part of npm run verify)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF_TEST = process.argv.includes('--self-test')

/** Extensions that must be plain text. Anything else is skipped, not trusted. */
const TEXT_EXT = new Set([
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.jsonc',
  '.css', '.html', '.md', '.yml', '.yaml', '.conf', '.txt'
])

/**
 * Forbidden code points, each with what it does to a reviewer.
 *
 * Written as a table rather than a regex range so the failure message can say
 * WHY the byte is a problem — "a NUL makes git call this file binary" is
 * actionable, "control character 0x00" is not.
 */
const FORBIDDEN = new Map([
  [0x00, 'NUL — git classifies the whole file as binary: no diff, no git grep line numbers'],
  [0x01, 'SOH'], [0x02, 'STX'], [0x03, 'ETX'], [0x04, 'EOT'], [0x05, 'ENQ'],
  [0x06, 'ACK'], [0x07, 'BEL'], [0x08, 'BS'],
  [0x0b, 'VT — a vertical tab is a line break to some tools and not to others'],
  [0x0c, 'FF — a form feed splits the file for pagers but not for the compiler'],
  [0x0e, 'SO'], [0x0f, 'SI'], [0x10, 'DLE'], [0x11, 'DC1'], [0x12, 'DC2'],
  [0x13, 'DC3'], [0x14, 'DC4'], [0x15, 'NAK'], [0x16, 'SYN'], [0x17, 'ETB'],
  [0x18, 'CAN'], [0x19, 'EM'], [0x1a, 'SUB'], [0x1b, 'ESC — an ANSI escape can rewrite what a terminal shows'],
  [0x1c, 'FS'], [0x1d, 'GS'], [0x1e, 'RS'], [0x1f, 'US'],
  [0x7f, 'DEL'],
  // Invisible Unicode. The bidi controls are CVE-2021-42574 (Trojan Source):
  // source that reads one way to a human and compiles another.
  [0x00a0, 'NBSP — indistinguishable from a space, and not a space to any parser'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LRE — bidi override (Trojan Source, CVE-2021-42574)'],
  [0x202b, 'RLE — bidi override (Trojan Source, CVE-2021-42574)'],
  [0x202c, 'PDF — bidi override (Trojan Source, CVE-2021-42574)'],
  [0x202d, 'LRO — bidi override (Trojan Source, CVE-2021-42574)'],
  [0x202e, 'RLO — bidi override (Trojan Source, CVE-2021-42574)'],
  [0x2066, 'LRI — bidi isolate (Trojan Source, CVE-2021-42574)'],
  [0x2067, 'RLI — bidi isolate (Trojan Source, CVE-2021-42574)'],
  [0x2068, 'FSI — bidi isolate (Trojan Source, CVE-2021-42574)'],
  [0x2069, 'PDI — bidi isolate (Trojan Source, CVE-2021-42574)'],
  [0xfeff, 'BOM / ZERO WIDTH NO-BREAK SPACE — legal only as the very first character']
])

/**
 * Scan one file's bytes. Returns findings with a 1-based line and column, so the
 * message is something an editor can jump to; a byte offset alone is what made
 * the original take a hex dump to locate.
 */
export function scanBuffer(buf, { allowLeadingBom = true } = {}) {
  const findings = []
  const text = buf.toString('utf8')
  let line = 1
  let col = 1
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)
    if (code === undefined) continue
    if (code > 0xffff) i++ // surrogate pair; nothing in the table is astral
    if (code === 0x0a) {
      line++
      col = 1
      continue
    }
    const why = FORBIDDEN.get(code)
    if (why !== undefined) {
      const isLeadingBom = code === 0xfeff && i === 0 && allowLeadingBom
      if (!isLeadingBom) {
        findings.push({
          line,
          col,
          code,
          hex: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
          why
        })
      }
    }
    col++
  }
  return findings
}

/** Git's own text/binary verdict, for rule 2. */
function gitCallsItBinary(file) {
  // `-t` prints "file: diff: <value>"; `binary` is a macro for `-diff`.
  let attr = ''
  try {
    attr = execFileSync('git', ['check-attr', 'diff', '--', file], {
      cwd: repo,
      encoding: 'utf8'
    })
  } catch {
    attr = ''
  }
  if (/:\s*diff:\s*unset$/m.test(attr.trim())) return 'the .gitattributes `binary`/`-diff` attribute'
  // With `text=auto` and no explicit attribute, git sniffs for a NUL.
  const buf = fs.readFileSync(path.join(repo, file))
  if (buf.subarray(0, 8000).includes(0)) return 'a NUL byte in the first 8000 bytes'
  return null
}

function trackedTextFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'docs', 'web'],
    { cwd: repo, encoding: 'utf8' }
  )
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => fs.existsSync(path.join(repo, f)))
}

// --- rule 3: the check can see itself --------------------------------------
//
// Run FIRST and unconditionally in --self-test, and its fixture is the exact
// byte that shipped, not an invented one.
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ctrl-'))
  // BUILT FROM CODE POINTS, never typed as a literal: this file is itself scanned by
  // the rule below, so a fixture holding a real NUL would fail the very check it is
  // proving. That is not pedantry, it is why the fixture is trustworthy --
  // `String.fromCharCode(0)` is the same byte that shipped, with no editor or encoding
  // step in between.
  const NUL = String.fromCharCode(0)
  const BOM = String.fromCodePoint(0xfeff)
  const RLO = String.fromCodePoint(0x202e)
  const dirty = `const CUSTOM = '${NUL}custom'\nexport default CUSTOM\n`
  const clean = `const CUSTOM = ''\nexport default CUSTOM\n`
  const problems = []

  const onDirty = scanBuffer(Buffer.from(dirty, 'utf8'))
  if (onDirty.length !== 1 || onDirty[0].code !== 0x00) {
    problems.push(
      `the scanner did not flag the byte that actually shipped ('\\0' inside a string ` +
        `literal): got ${JSON.stringify(onDirty)}`
    )
  } else if (onDirty[0].line !== 1 || onDirty[0].col !== 17) {
    problems.push(
      `the scanner found the NUL but reported ${onDirty[0].line}:${onDirty[0].col} instead ` +
        `of 1:17. A finding nobody can locate is a finding nobody acts on.`
    )
  }
  if (scanBuffer(Buffer.from(clean, 'utf8')).length !== 0) {
    problems.push('the scanner flags the CLEANED version too, so it reports on everything')
  }
  // A BOM is legal at offset 0 and illegal anywhere else; both directions.
  if (scanBuffer(Buffer.from(`${BOM}const a = 1\n`, 'utf8')).length !== 0) {
    problems.push('a leading BOM is reported, which would fail every UTF-8-with-BOM file')
  }
  if (scanBuffer(Buffer.from(`const a = 1${BOM}\n`, 'utf8')).length !== 1) {
    problems.push('a BOM in the MIDDLE of a file is not reported')
  }
  // Trojan Source, and the three legal whitespace characters.
  if (scanBuffer(Buffer.from(`const a = "${RLO}evil"\n`, 'utf8')).length !== 1) {
    problems.push('a bidi override (CVE-2021-42574) is not reported')
  }
  if (scanBuffer(Buffer.from('a\tb\r\nc\n', 'utf8')).length !== 0) {
    problems.push('TAB, CR or LF is reported, which would fail every file in the repo')
  }

  // Rule 2 has to be exercised too: write the dirty file into the repo's own
  // tree so `git check-attr` and the NUL sniff run on a real path.
  const probe = path.join('scripts', `.control-char-self-test-${process.pid}.ts`)
  fs.writeFileSync(path.join(repo, probe), dirty, 'utf8')
  try {
    if (gitCallsItBinary(probe) === null) {
      problems.push(
        'git does NOT call a NUL-bearing .ts file binary according to this check, so rule 2 ' +
          'would have reported the shipped audio-eq/index.ts as clean'
      )
    }
  } finally {
    fs.rmSync(path.join(repo, probe), { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }

  if (problems.length > 0) {
    console.error('check:control-chars SELF-TEST FAILED:\n')
    for (const p of problems) console.error('  - ' + p + '\n')
    process.exit(1)
  }
  console.log('check:control-chars: self-test passed (the NUL that shipped is caught)')
}

if (SELF_TEST) selfTest()

const failures = []
const files = trackedTextFiles()
if (files.length === 0) {
  console.error('check:control-chars: git ls-files returned no text files. Nothing was checked.')
  process.exit(1)
}

for (const file of files) {
  const buf = fs.readFileSync(path.join(repo, file))
  for (const f of scanBuffer(buf)) {
    failures.push(
      `${file}:${f.line}:${f.col}\n    holds ${f.hex} (${f.why}).\n` +
        `    Tracked source must be reviewable text. Replace the character; if you need a\n` +
        `    sentinel value, pick one that cannot collide by construction rather than one\n` +
        `    that cannot be typed (see the CUSTOM comment in\n` +
        `    src/renderer/src/features/audio-eq/index.ts).`
    )
  }
  const binaryBecause = gitCallsItBinary(file)
  if (binaryBecause !== null) {
    failures.push(
      `${file}\n    is a source file git will treat as BINARY, because of ${binaryBecause}.\n` +
        `    'git diff' shows 'Bin N -> M bytes' and 'git grep' shows 'Binary file … matches'\n` +
        `    with no line numbers, so the file cannot be reviewed at all.`
    )
  }
}

if (failures.length > 0) {
  console.error('check:control-chars found %d problem(s):\n', failures.length)
  for (const f of failures) console.error('  ' + f + '\n')
  process.exit(1)
}

console.log('check:control-chars: clean (%d text files scanned)', files.length)
