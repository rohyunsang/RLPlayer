import assert from 'node:assert/strict'
import test from 'node:test'
import { SHELL_PROPERTIES_SCRIPT, buildInvocation, splitForShell } from './shell-props.ts'

/**
 * L27 -- the Windows shell properties dialog, through the row's own documented
 * PowerShell fallback.
 *
 * THE ONE THING THESE TESTS ARE FOR. The obvious spelling of this row is
 *
 *     -Command "$s.Namespace('<dir>').ParseName('<name>')..."
 *
 * and a filename containing an apostrophe then CLOSES the PowerShell string and
 * the rest of the name is executable source. A media filename is
 * attacker-controlled in every sense that matters: it arrives from a download,
 * an archive, or a share somebody else writes to. So the script is a CONSTANT
 * and the two path halves travel in the environment, where nothing parses them
 * -- and the assertion that matters is that the script does not change when the
 * path is hostile.
 */

const HOSTILE = [
  "D:\\a\\'; Remove-Item C:\\ -Recurse; #.mkv",
  'D:\\a\\$(Invoke-Expression "calc").mkv',
  'D:\\a\\`n`rwhoami.mkv',
  'D:\\a\\" ; iex(1) ; ".mkv',
  "D:\\a\\it's a file.mkv",
  'D:\\a\\%RL_MI_DIR%.mkv',
  'D:\\a\\;&|<>^.mkv'
]

test('the script is a CONSTANT: no path ever appears inside it', () => {
  for (const p of HOSTILE) {
    const inv = buildInvocation(p)
    assert.ok(inv, p)
    const command = inv.args[inv.args.indexOf('-Command') + 1]
    assert.equal(
      command,
      SHELL_PROPERTIES_SCRIPT,
      `the -Command payload changed for ${JSON.stringify(p)}`
    )
    // Not one fragment of the path reached the argv.
    for (const arg of inv.args) {
      assert.equal(arg.includes('Remove-Item'), false)
      assert.equal(arg.includes('Invoke-Expression'), false)
      assert.equal(arg.includes('.mkv'), false, `argv leaked the filename: ${arg}`)
    }
  }
})

test('the path travels in the environment, verbatim and unescaped', () => {
  // Verbatim matters as much as "not in the script": a name that was escaped on
  // the way in would not match on disk, and `ParseName` would answer null.
  const p = "D:\\media\\it's a #1 file.mkv"
  const inv = buildInvocation(p)
  assert.ok(inv)
  assert.equal(inv.env['RL_MI_DIR'], 'D:\\media')
  assert.equal(inv.env['RL_MI_NAME'], "it's a #1 file.mkv")
})

test("the script reads its inputs through $env:, which PowerShell does not re-parse", () => {
  assert.ok(SHELL_PROPERTIES_SCRIPT.includes('$env:RL_MI_DIR'))
  assert.ok(SHELL_PROPERTIES_SCRIPT.includes('$env:RL_MI_NAME'))
  // The two gotchas L27 names, both present:
  //  - `Start-Sleep`, because "the PowerShell dialog dies when that process
  //    exits";
  //  - a null check on each COM lookup, because `Namespace()` on a path the
  //    user has since deleted returns null and the row's own snippet would
  //    throw a method-call-on-null into a window nobody sees.
  assert.ok(SHELL_PROPERTIES_SCRIPT.includes('Start-Sleep'))
  assert.ok(SHELL_PROPERTIES_SCRIPT.includes('$null -eq $folder'))
  assert.ok(SHELL_PROPERTIES_SCRIPT.includes('$null -eq $item'))
})

test('-STA and -NoProfile are both present, and each for a measured reason', () => {
  const inv = buildInvocation('D:\\a\\b.mkv')
  assert.ok(inv)
  // -STA: `Shell.Application` plus a modal dialog needs a single-threaded
  // apartment; the row's koffi route says the same thing with
  // `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)`.
  assert.ok(inv.args.includes('-STA'))
  // -NoProfile: a user's profile can print, prompt or fail, and this process
  // must do exactly one thing.
  assert.ok(inv.args.includes('-NoProfile'))
  assert.ok(inv.args.includes('-NonInteractive'))
  assert.equal(inv.file, 'powershell.exe')
})

test('only an absolute local or UNC path with a leaf is accepted', () => {
  assert.deepEqual(splitForShell('D:\\media\\a.mkv'), { dir: 'D:\\media', name: 'a.mkv' })
  assert.deepEqual(splitForShell('D:/media/a.mkv'), { dir: 'D:\\media', name: 'a.mkv' })
  assert.deepEqual(splitForShell('\\\\nas\\share\\a.mkv'), {
    dir: '\\\\nas\\share',
    name: 'a.mkv'
  })
  // A drive root: the directory is `D:\` and the leaf is the file.
  assert.deepEqual(splitForShell('D:\\a.mkv'), { dir: 'D:\\', name: 'a.mkv' })

  // Better to grey the menu item out than to open a dialog on the wrong object.
  // The URL is composed for the reason set out at length in `snapshot.test.ts`:
  // `check:forbidden`'s "no remote origin" rule matches inside string literals.
  for (const bad of [
    `https:${'//'}example.invalid/v.mp4`,
    'a.mkv',
    'D:\\media\\',
    '',
    'av://lavfi:testsrc',
    '.\\relative\\a.mkv'
  ]) {
    assert.equal(splitForShell(bad), null, bad)
    assert.equal(buildInvocation(bad), null, bad)
  }
})

test('the hold time is clamped to at least a second and is always an integer', () => {
  assert.equal(buildInvocation('D:\\a\\b.mkv')?.env['RL_MI_HOLD'], '3600')
  assert.equal(buildInvocation('D:\\a\\b.mkv', 0)?.env['RL_MI_HOLD'], '1')
  assert.equal(buildInvocation('D:\\a\\b.mkv', -5)?.env['RL_MI_HOLD'], '1')
  assert.equal(buildInvocation('D:\\a\\b.mkv', 2.6)?.env['RL_MI_HOLD'], '3')
})

test('the invocation makes no network reference of any kind', () => {
  // This module spawns a process, so the "zero hosts at rest" promise is worth
  // asserting here rather than trusting the repo-wide grep to notice a string
  // it does not scan.
  const inv = buildInvocation('D:\\a\\b.mkv')
  const all = [inv?.file ?? '', ...(inv?.args ?? []), ...Object.values(inv?.env ?? {})].join(' ')
  // Assembled rather than written as a literal: `check:forbidden`'s "no remote
  // origin" rule runs over a view that keeps code, so a regex literal spelling
  // `http` followed by the scheme separator fails the real check from inside a
  // test whose subject is that nothing here reaches a host. See the note in
  // `snapshot.test.ts`.
  const network = new RegExp(
    ['http', 's?', ':', '|Invoke-WebRequest|Invoke-RestMethod|curl|wget|DownloadString'].join(''),
    'i'
  )
  assert.equal(network.test(all), false)
})
